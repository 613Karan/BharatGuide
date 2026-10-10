"""Stage 3 - embed chunks and upsert them into Qdrant.

Creates a collection with two named vectors:
  dense  : semantic similarity
  sparse : lexical signal for exact terms ("Form 6", "EPIC", "section 23")

The active model comes from ARGO_PROFILE (default: small = bge-small-en-v1.5).

Usage:
    uv run python -m argo_rag.build_index --recreate
    uv run python -m argo_rag.build_index --limit 20 --recreate   # smoke test
    ARGO_PROFILE=m3 uv run python -m argo_rag.build_index --recreate
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid

from qdrant_client import QdrantClient, models

from .config import (
    CFG,
    CHUNKS_PATH,
    COLLECTION,
    CONTEXTUAL_HEADERS,
    DENSE_DIM,
    DENSE_VECTOR,
    DOC_CONTEXT,
    EMBED_MODEL,
    INDEX_META_PATH,
    PROFILE,
    QDRANT_API_KEY,
    QDRANT_IS_LOCAL,
    QDRANT_URL,
    SPARSE_VECTOR,
    UPSERT_BATCH,
)

# Fixed namespace so point ids are reproducible across rebuilds.
NAMESPACE = uuid.UUID("6f1c2f9e-0f4a-4c2b-9a5e-2f7b1d3c8a10")

PAYLOAD_FIELDS = (
    "doc_id", "doc_title", "source_file", "chunk_index",
    "page_start", "page_end", "section", "text",
)


def point_id(doc_id: str, chunk_index: int) -> str:
    """Deterministic UUID per chunk, so re-running is idempotent."""
    return str(uuid.uuid5(NAMESPACE, f"{doc_id}:{chunk_index}"))


def embed_text(chunk: dict) -> str:
    """Text that is embedded: a context header + the chunk text.

    Only the embedding sees the header; the payload keeps the original text.
    """
    if not CONTEXTUAL_HEADERS:
        return chunk["text"]
    title = DOC_CONTEXT.get(chunk["doc_id"], chunk["doc_title"])
    section = " ".join(chunk.get("section", "").split())[:100]
    header = f"{title}. Section: {section}" if section else title
    return f"{header}\n\n{chunk['text']}"


def load_chunks() -> list[dict]:
    with CHUNKS_PATH.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def ensure_collection(client: QdrantClient, recreate: bool) -> None:
    exists = client.collection_exists(COLLECTION)
    if exists and not recreate:
        print(f"using existing collection '{COLLECTION}'")
        return
    if exists:
        client.delete_collection(COLLECTION)
    # BM25 sparse vectors need Qdrant to apply inverse-document-frequency.
    modifier = models.Modifier.IDF if CFG["sparse_idf"] else None
    client.create_collection(
        collection_name=COLLECTION,
        vectors_config={
            DENSE_VECTOR: models.VectorParams(
                size=DENSE_DIM, distance=models.Distance.COSINE,
            ),
        },
        sparse_vectors_config={
            SPARSE_VECTOR: models.SparseVectorParams(modifier=modifier),
        },
    )
    for field, schema in (
        ("doc_id", models.PayloadSchemaType.KEYWORD),
        ("section", models.PayloadSchemaType.KEYWORD),
        ("page_start", models.PayloadSchemaType.INTEGER),
    ):
        client.create_payload_index(COLLECTION, field, schema)
    print(f"created collection '{COLLECTION}' "
          f"({DENSE_VECTOR}: {DENSE_DIM}-d cosine, {SPARSE_VECTOR}: sparse)")


def main() -> int:
    parser = argparse.ArgumentParser(description="embed chunks into Qdrant")
    parser.add_argument("--recreate", action="store_true",
                        help="drop and rebuild the collection")
    parser.add_argument("--force", action="store_true",
                        help="allow --recreate on a REMOTE (non-local) Qdrant")
    parser.add_argument("--limit", type=int, default=0,
                        help="only embed the first N chunks (smoke test)")
    args = parser.parse_args()

    if not CHUNKS_PATH.exists():
        print(f"missing {CHUNKS_PATH} - run `python -m argo_rag.chunk` first",
              file=sys.stderr)
        return 1

    host = QDRANT_URL.split("//", 1)[-1]
    print(f"target Qdrant: {host} ({'local' if QDRANT_IS_LOCAL else 'REMOTE'})")
    if args.recreate and not QDRANT_IS_LOCAL and not args.force:
        print("refusing --recreate on a remote Qdrant: it DELETES the shared "
              "collection for everyone using it. Re-run with --force if you "
              "really mean it.", file=sys.stderr)
        return 2
    if not QDRANT_IS_LOCAL and not QDRANT_API_KEY:
        print("warning: remote URL but no QDRANT_API_KEY set", file=sys.stderr)

    chunks = load_chunks()
    if args.limit:
        chunks = chunks[: args.limit]
    if not chunks:
        print("no chunks to index", file=sys.stderr)
        return 1

    # Imported here so the module compiles without the heavy dependencies.
    from .embedder import Embedder

    print(f"profile={PROFILE} model={EMBED_MODEL}")
    embedder = Embedder()

    client = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY, timeout=120)
    ensure_collection(client, args.recreate)

    print(f"embedding {len(chunks)} chunks...")
    dense, sparse = embedder.embed_passages([embed_text(c) for c in chunks])

    points = [
        models.PointStruct(
            id=point_id(chunk["doc_id"], chunk["chunk_index"]),
            vector={DENSE_VECTOR: dense[i], SPARSE_VECTOR: sparse[i]},
            payload={
                **{field: chunk[field] for field in PAYLOAD_FIELDS},
                "embed_model": EMBED_MODEL,
            },
        )
        for i, chunk in enumerate(chunks)
    ]

    for start in range(0, len(points), UPSERT_BATCH):
        client.upsert(
            collection_name=COLLECTION,
            points=points[start : start + UPSERT_BATCH],
            wait=True,
        )
        print(f"  upserted {min(start + UPSERT_BATCH, len(points))}"
              f"/{len(points)}", flush=True)

    count = client.count(COLLECTION, exact=True).count
    INDEX_META_PATH.parent.mkdir(parents=True, exist_ok=True)
    INDEX_META_PATH.write_text(json.dumps({
        "profile": PROFILE,
        "collection": COLLECTION,
        "embed_model": EMBED_MODEL,
        "sparse_model": CFG["sparse_model"] or EMBED_MODEL,
        "dense_dim": DENSE_DIM,
        "max_length": CFG["max_length"],
        "contextual_headers": CONTEXTUAL_HEADERS,
        "points": count,
    }, indent=2) + "\n", encoding="utf-8")

    print(f"\ncollection '{COLLECTION}' now holds {count} points")
    print(f"wrote {INDEX_META_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
