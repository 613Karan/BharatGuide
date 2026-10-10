"""Stage 4 - hybrid retrieval check: dense + sparse fused with RRF.

Use this to sanity-check the index before building any UI. Compare against
--dense-only to see what the sparse (lexical) leg contributes.

Usage:
    uv run python -m argo_rag.search "how do I register as a new voter"
    uv run python -m argo_rag.search --top-k 10 "form 6 documents required"
    uv run python -m argo_rag.search --dense-only "epic number correction"
"""

from __future__ import annotations

import argparse

from qdrant_client import QdrantClient, models

from .config import (
    COLLECTION,
    DENSE_VECTOR,
    EMBED_MODEL,
    PROFILE,
    QDRANT_API_KEY,
    QDRANT_URL,
    SPARSE_VECTOR,
)


def snippet(text: str, width: int = 320) -> str:
    text = " ".join(text.split())
    if len(text) <= width:
        return text
    return text[:width].rsplit(" ", 1)[0] + " ..."


def main() -> int:
    parser = argparse.ArgumentParser(description="hybrid retrieval check")
    parser.add_argument("query", nargs="+", help="the question to search for")
    parser.add_argument("--top-k", type=int, default=6)
    parser.add_argument("--dense-only", action="store_true",
                        help="skip the sparse leg (useful for comparison)")
    args = parser.parse_args()
    query = " ".join(args.query)

    from .embedder import Embedder

    dense, sparse = Embedder().embed_query(query)
    client = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY, timeout=60)

    if args.dense_only:
        response = client.query_points(
            COLLECTION, query=dense, using=DENSE_VECTOR,
            limit=args.top_k, with_payload=True,
        )
        mode = "dense only"
    else:
        response = client.query_points(
            COLLECTION,
            prefetch=[
                models.Prefetch(query=dense, using=DENSE_VECTOR, limit=20),
                models.Prefetch(query=sparse, using=SPARSE_VECTOR, limit=20),
            ],
            query=models.FusionQuery(fusion=models.Fusion.RRF),
            limit=args.top_k, with_payload=True,
        )
        mode = "hybrid dense+sparse (RRF)"

    print(f'\nquery: "{query}"')
    print(f"profile={PROFILE} model={EMBED_MODEL} | retrieval: {mode}")
    print("-" * 72)
    for rank, hit in enumerate(response.points, start=1):
        payload = hit.payload or {}
        start, end = payload.get("page_start"), payload.get("page_end")
        pages = f"p{start}" if start == end else f"pp{start}-{end}"
        print(f"{rank}. score={hit.score:.4f}  {payload.get('doc_title')} {pages}")
        if payload.get("section"):
            print(f"   section: {payload['section']}")
        print(f"   {snippet(payload.get('text', ''))}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
