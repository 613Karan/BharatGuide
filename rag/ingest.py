"""Ingestion orchestrator (spec 9.2).

    python -m rag.ingest            # inventory -> parse -> chunk -> embed -> upsert
    python -m rag.ingest --dry-run  # stop after chunking (writes ./work, no Qdrant)

Idempotent (rule 16): point ids are uuid5(doc_id:sha256:chunk_index). A
document whose sha256 is unchanged is skipped; if it changed, its old points are
deleted by doc_id first. Intermediates go to ./work/ so stages can be re-run.
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from typing import Any

from .chunk import build_units, chunk_units, embedding_header
from .config import CHUNK_MAX_TOKENS, settings
from .inventory import build_inventory, load_sources_yaml, write_csv
from .metadata import build_payload, point_id, text_for_embedding
from .parse import parse_pdf

BATCH = 16


def chunk_document(row: Any, count) -> list[dict[str, Any]]:
    """Parse + clean + chunk one inventory row into payload dicts."""
    path = settings.sources_dir.parent / row.path
    units = build_units(parse_pdf(path), row.title)
    # Reserve space for the longest section label (80 chars) in the embedding header.
    header_tokens = count(embedding_header(row.org, row.title, "x" * 80)) + 2
    chunks = chunk_units(units, count, header_tokens=header_tokens)
    doc = {
        "doc_id": row.doc_id,
        "sha256": row.sha256,
        "org": row.org,
        "title": row.title,
        "doc_type": row.doc_type,
        "publication_date": row.publication_date,
        "version": row.version,
        "status": row.status,
        "source_url": row.source_url,
    }
    retrieved_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return [build_payload(chunk, doc, retrieved_at) for chunk in chunks]


def chunk_all(rows: list[Any], report: dict[str, Any], count) -> dict[str, list[dict[str, Any]]]:
    settings.work_dir.mkdir(exist_ok=True)
    out: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        payloads = chunk_document(row, count)
        if not payloads:
            report["skipped_files"].append({"path": row.path, "reason": "no text extracted"})
            continue
        out[row.doc_id] = payloads
        (settings.work_dir / f"{row.doc_id}.chunks.json").write_text(
            json.dumps(payloads, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        for p in payloads:
            tokens = count(text_for_embedding(p))
            if tokens > CHUNK_MAX_TOKENS:
                report["over_limit_chunks"].append(
                    {"doc_id": row.doc_id, "chunk_index": p["chunk_index"], "tokens": tokens}
                )
        print(f"chunked {row.doc_id:28} chunks={len(payloads):<4} status={row.status}")
    return out


def run(dry_run: bool = False) -> dict[str, Any]:
    from .embed import count_tokens

    started = time.time()
    rows = build_inventory(settings.sources_dir, load_sources_yaml(settings.sources_yaml))
    write_csv(rows, settings.inventory_csv)
    included = [r for r in rows if r.included]
    report: dict[str, Any] = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "embed_model": settings.embed_model,
        "docs": [],
        "skipped_files": [{"path": r.path, "reason": r.notes} for r in rows if not r.included],
        "over_limit_chunks": [],
        "points_before": None,
        "points_after": None,
    }
    all_chunks = chunk_all(included, report, count_tokens)

    if dry_run:
        report["docs"] = [{"doc_id": k, "chunks": len(v)} for k, v in all_chunks.items()]
        settings.ingest_report.write_text(json.dumps(report, indent=2), encoding="utf-8")
        return report

    from .embed import get_embedder
    from .store import count_points, delete_doc, ensure_collection, existing_doc_hashes, get_client, upsert

    embedder = get_embedder()
    client = get_client()
    ensure_collection(client, embedder.dim, embedder.sparse)
    report["points_before"] = count_points(client)
    stored = existing_doc_hashes(client)

    for row in included:
        payloads = all_chunks.get(row.doc_id)
        if not payloads:
            continue
        hashes = stored.get(row.doc_id, set())
        ids = [point_id(row.doc_id, row.sha256, p["chunk_index"]) for p in payloads]
        if hashes == {row.sha256}:
            existing = client.retrieve(settings.collection, ids=ids, with_payload=False)
            if len(existing) == len(ids) and len(ids) == _stored_count(client, row.doc_id):
                report["docs"].append({"doc_id": row.doc_id, "chunks": len(ids), "action": "unchanged"})
                print(f"unchanged {row.doc_id}")
                continue
        if hashes:
            delete_doc(client, row.doc_id)
        for start in range(0, len(payloads), BATCH):
            batch = payloads[start : start + BATCH]
            vectors = embedder.encode([text_for_embedding(p) for p in batch], batch_size=BATCH)
            upsert(client, ids[start : start + BATCH], vectors, batch)
        action = "replaced" if hashes else "inserted"
        report["docs"].append({"doc_id": row.doc_id, "chunks": len(ids), "action": action})
        print(f"{action} {row.doc_id} ({len(ids)} chunks)")

    # Documents no longer included are purged so the corpus matches sources.yaml.
    for doc_id in set(stored) - {r.doc_id for r in included}:
        delete_doc(client, doc_id)
        report["docs"].append({"doc_id": doc_id, "chunks": 0, "action": "removed"})

    report["points_after"] = count_points(client)
    report["seconds"] = round(time.time() - started, 1)
    settings.ingest_report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"points: {report['points_before']} -> {report['points_after']}  ({report['seconds']} s)")
    return report


def _stored_count(client: Any, doc_id: str) -> int:
    from qdrant_client import models

    flt = models.Filter(must=[models.FieldCondition(key="doc_id", match=models.MatchValue(value=doc_id))])
    return client.count(settings.collection, count_filter=flt, exact=True).count


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    report = run(dry_run=args.dry_run)
    if report["over_limit_chunks"]:
        print("WARNING: chunks over the token limit:", report["over_limit_chunks"])
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

