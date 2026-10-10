"""Retrieval (spec 9.4): redact -> form-ID hint -> embed -> hybrid RRF -> abstain check."""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any

from qdrant_client import QdrantClient, models

from .config import settings
from .doc_meta import build_citation, is_excluded
from .embed import Embedder
from .redact import redact_text
from .store import build_filter

_FORM_HINT = re.compile(r"\bform[\s\-]*(?:no\.?\s*)?(\d{1,2}[a-z]?)\b", re.I)
PREFETCH = 30
FUSED = 8


@dataclass
class Filters:
    org: str | None = None
    doc_type: list[str] = field(default_factory=list)
    form_id: str | None = None


@dataclass
class SearchOutcome:
    abstain: bool
    reason: str | None
    helpline: str | None
    results: list[dict[str, Any]]
    top_dense: float
    latency_ms: float
    top_doc_ids: list[str]


def normalize_query(query: str) -> str:
    return re.sub(r"\s+", " ", redact_text(query)).strip()


def form_hint(query: str) -> str | None:
    match = _FORM_HINT.search(query)
    return match.group(1).upper() if match else None


def out_of_scope(query: str) -> bool:
    lowered = f" {query.lower()} "
    return any(keyword in lowered for keyword in settings.out_of_scope_keywords)


def helpline_for(org: str | None, query: str = "") -> str:
    q = query.lower()
    if org == "UIDAI" or (org is None and ("aadhaar" in q or "aadhar" in q or "uidai" in q)):
        return settings.helpline_uidai
    return settings.helpline_eci


class Retriever:
    def __init__(self, client: QdrantClient, embedder: Embedder) -> None:
        self.client = client
        self.embedder = embedder

    def _hybrid(self, emb: Any, flt: models.Filter | None, limit: int) -> list[models.ScoredPoint]:
        dense_name = settings.dense_vector
        dense_prefetch = models.Prefetch(query=emb.dense, using=dense_name, limit=PREFETCH, filter=flt)
        if emb.sparse is None or not settings.sparse_vector:
            res = self.client.query_points(
                settings.collection, query=emb.dense, using=dense_name, limit=limit, query_filter=flt, with_payload=True
            )
            return res.points
        sparse_prefetch = models.Prefetch(
            query=models.SparseVector(indices=emb.sparse.indices, values=emb.sparse.values),
            using=settings.sparse_vector,
            limit=PREFETCH,
            filter=flt,
        )
        res = self.client.query_points(
            settings.collection,
            prefetch=[dense_prefetch, sparse_prefetch],
            query=models.FusionQuery(fusion=models.Fusion.RRF),
            limit=limit,
            with_payload=True,
        )
        return res.points

    def _top_dense(self, emb: Any, flt: models.Filter | None) -> float:
        res = self.client.query_points(
            settings.collection, query=emb.dense, using=settings.dense_vector, limit=1, query_filter=flt, with_payload=False
        )
        return float(res.points[0].score) if res.points else 0.0

    def search(self, query: str, top_k: int = 5, filters: Filters | None = None) -> SearchOutcome:
        started = time.perf_counter()
        filters = filters or Filters()
        q = normalize_query(query)

        def done(abstain: bool, reason: str | None, results: list[dict[str, Any]], top: float) -> SearchOutcome:
            return SearchOutcome(
                abstain=abstain,
                reason=reason,
                helpline=helpline_for(filters.org, q) if abstain else None,
                results=results,
                top_dense=top,
                latency_ms=round((time.perf_counter() - started) * 1000, 1),
                top_doc_ids=[r["doc_id"] for r in results],
            )

        if not q or out_of_scope(q):
            return done(True, "out_of_scope", [], 0.0)

        emb = self.embedder.encode([q], batch_size=1)[0]
        form_id = filters.form_id or form_hint(q)
        base = dict(org=filters.org, doc_types=filters.doc_type)

        flt = build_filter(form_id=form_id, **base)
        points = self._hybrid(emb, flt, FUSED) if form_id and settings.form_id_filter else []
        if not points:  # no form hint, or the form filter returned nothing
            flt = build_filter(**base)
            points = self._hybrid(emb, flt, FUSED)

        top = self._top_dense(emb, build_filter(**base))
        if not points or top < settings.abstain_threshold:
            return done(True, "no_relevant_source", [], top)

        results = []
        kept = [p for p in points if not is_excluded(p.payload or {})]
        if not kept:
            return done(True, "no_relevant_source", [], top)
        for rank, point in enumerate(kept[: max(1, min(top_k, FUSED))]):
            payload = point.payload or {}
            results.append(
                {
                    "chunk_id": str(point.id),
                    "doc_id": payload.get("doc_id"),
                    "score": float(point.score),
                    "is_hit": rank < top_k,
                    "text": payload.get("text", ""),
                    "ui_labels": payload.get("ui_labels", []),
                    "citation": build_citation(payload, settings.default_org),
                }
            )
        return done(False, None, results, top)
