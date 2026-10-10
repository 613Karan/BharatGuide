"""FastAPI service (spec 9.5).

    python -m rag.service            # or: uvicorn rag.service.app:app --port 8008

POST /v1/search  (Authorization: Bearer <SERVICE_TOKEN>)
GET  /healthz    (no auth; no data beyond counts)

Logs: timestamp, request id, latency, abstain flag, top doc ids. Never the raw
query (spec 12). CORS is off (no middleware). Per-IP rate limit.
"""
from __future__ import annotations

import hmac
import logging
import threading
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from ..config import settings

log = logging.getLogger("rag.service")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


class State:
    retriever: Any = None
    client: Any = None
    model_loaded: bool = False
    load_error: str | None = None
    corpus_last_updated: str | None = None


state = State()


def _load() -> None:
    """Load the model and connect to Qdrant. Runs in a thread so /healthz can
    report "warming up" while BGE-M3 loads."""
    try:
        from ..embed import get_embedder
        from ..retrieval import Retriever
        from ..store import get_client

        state.client = get_client()
        embedder = get_embedder()
        state.retriever = Retriever(state.client, embedder)
        state.corpus_last_updated = _corpus_last_updated()
        state.model_loaded = True
        log.info("model loaded: %s", settings.embed_model)
    except Exception as exc:  # pragma: no cover - surfaced through /healthz
        state.load_error = str(exc)
        log.error("startup failed: %s", exc)


def _corpus_last_updated() -> str | None:
    """Latest retrieved_at date across stored chunks (when the corpus was last ingested)."""
    try:
        points, _ = state.client.scroll(settings.collection, limit=256, with_payload=["retrieved_at"])
        dates = sorted(str(p.payload.get("retrieved_at", ""))[:10] for p in points if p.payload)
        return dates[-1] if dates else None
    except Exception:
        return None


@asynccontextmanager
async def lifespan(_: FastAPI):
    threading.Thread(target=_load, daemon=True).start()
    yield


app = FastAPI(title="gov-guide-rag", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

_hits: dict[str, deque[float]] = defaultdict(deque)


def rate_limit(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    window = _hits[ip]
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= settings.rate_limit_per_minute:
        raise HTTPException(status_code=429, detail="rate limit")
    window.append(now)


def require_token(authorization: str | None = Header(default=None)) -> None:
    expected = f"Bearer {settings.service_token}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


class SearchFilters(BaseModel):
    org: str | None = None
    doc_type: list[str] = Field(default_factory=list)
    form_id: str | None = None

    @field_validator("org")
    @classmethod
    def _org(cls, v: str | None) -> str | None:
        return v.upper() if v else None


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    top_k: int = Field(default=5, ge=1, le=8)
    filters: SearchFilters | None = None


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    qdrant_ok, points = False, None
    try:
        from ..store import count_points, get_client

        client = state.client or get_client()
        points = count_points(client)
        qdrant_ok = True
    except Exception:
        pass
    return {
        "ok": state.model_loaded and qdrant_ok and bool(points),
        "model_loaded": state.model_loaded,
        "warming_up": not state.model_loaded and state.load_error is None,
        "load_error": state.load_error,
        "qdrant_reachable": qdrant_ok,
        "point_count": points,
        "embed_model": settings.embed_model,
        "corpus_last_updated": state.corpus_last_updated,
    }


@app.post("/v1/search", dependencies=[Depends(rate_limit), Depends(require_token)])
def search(body: SearchRequest) -> dict[str, Any]:
    if not state.model_loaded or state.retriever is None:
        raise HTTPException(status_code=503, detail="warming up")
    from ..retrieval import Filters

    request_id = uuid.uuid4().hex[:12]
    f = body.filters or SearchFilters()
    outcome = state.retriever.search(
        body.query, top_k=body.top_k, filters=Filters(org=f.org, doc_type=f.doc_type, form_id=f.form_id)
    )
    log.info(
        "search id=%s latency_ms=%s abstain=%s reason=%s top_dense=%.3f top_docs=%s",
        request_id, outcome.latency_ms, outcome.abstain, outcome.reason, outcome.top_dense, outcome.top_doc_ids[:5],
    )
    return {
        "request_id": request_id,
        "abstain": outcome.abstain,
        "reason": outcome.reason,
        "helpline": outcome.helpline,
        "results": outcome.results,
        "corpus_last_updated": state.corpus_last_updated,
    }
