"""Citation metadata for existing collections whose payload lacks it.

Maps payload doc_id -> {org, title, source_url, publication_date}. Payload
values always win. Docs marked `exclude: true` are dropped (spec rule 11).
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

META_FILE = Path(__file__).with_name("doc_meta.yaml")


@lru_cache(maxsize=1)
def load_doc_meta() -> dict[str, dict[str, Any]]:
    if not META_FILE.exists():
        return {}
    data = yaml.safe_load(META_FILE.read_text(encoding="utf-8")) or {}
    return {str(k): dict(v or {}) for k, v in data.items()}


def build_citation(payload: dict[str, Any], default_org: str) -> dict[str, Any]:
    """Citation from payload, filled in from doc_meta.yaml where missing."""
    meta = load_doc_meta().get(str(payload.get("doc_id")), {})
    page_start = payload.get("page_start")
    page_end = payload.get("page_end") or page_start
    pages = payload.get("pages")
    if not pages and isinstance(page_start, int):
        pages = list(range(page_start, (page_end if isinstance(page_end, int) else page_start) + 1))
    section = payload.get("section_path") or payload.get("section") or ""
    # Payload has only: chunk_index, doc_id, doc_title, embed_model, page_start,
    # page_end, section, source_file, text. org/source_url/date come from doc_meta.yaml.
    return {
        "org": payload.get("org") or meta.get("org") or default_org,
        "doc_title": meta.get("title") or payload.get("doc_title") or payload.get("source_file") or "",
        "section_path": str(section)[:160],
        "pages": pages or [],
        "publication_date": str(payload.get("publication_date") or meta.get("publication_date") or ""),
        "source_url": payload.get("source_url") or meta.get("source_url") or "",
        "retrieved_at": payload.get("retrieved_at"),
    }


def is_excluded(payload: dict[str, Any]) -> bool:
    meta = load_doc_meta().get(str(payload.get("doc_id")), {})
    if meta.get("exclude"):
        return True
    # Unknown provenance (no source_url anywhere) is excluded (rule 11).
    return not (payload.get("source_url") or meta.get("source_url"))
