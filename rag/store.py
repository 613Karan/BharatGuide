"""Qdrant access (spec 9.3, 9.4)."""
from __future__ import annotations

from typing import Any, Iterable

from qdrant_client import QdrantClient, models

from .config import settings
from .embed import Embedded

KEYWORD_INDEXES = ["org", "doc_type", "status", "form_ids", "doc_id"]


def get_client() -> QdrantClient:
    return QdrantClient(url=settings.qdrant_url, api_key=settings.qdrant_api_key, timeout=30)


def ensure_collection(client: QdrantClient, dim: int, with_sparse: bool) -> None:
    name = settings.collection
    if client.collection_exists(name):
        return
    client.create_collection(
        name,
        vectors_config={"dense": models.VectorParams(size=dim, distance=models.Distance.COSINE)},
        sparse_vectors_config={"sparse": models.SparseVectorParams()} if with_sparse else None,
    )
    for field in KEYWORD_INDEXES:
        client.create_payload_index(name, field, models.PayloadSchemaType.KEYWORD)
    client.create_payload_index(name, "chunk_index", models.PayloadSchemaType.INTEGER)


def existing_doc_hashes(client: QdrantClient) -> dict[str, set[str]]:
    """doc_id -> set of doc_sha256 currently stored."""
    out: dict[str, set[str]] = {}
    offset = None
    while True:
        points, offset = client.scroll(
            settings.collection,
            limit=256,
            offset=offset,
            with_payload=["doc_id", "doc_sha256"],
            with_vectors=False,
        )
        for point in points:
            payload = point.payload or {}
            out.setdefault(str(payload.get("doc_id")), set()).add(str(payload.get("doc_sha256")))
        if offset is None:
            break
    return out


def delete_doc(client: QdrantClient, doc_id: str) -> None:
    client.delete(
        settings.collection,
        points_selector=models.FilterSelector(
            filter=models.Filter(must=[models.FieldCondition(key="doc_id", match=models.MatchValue(value=doc_id))])
        ),
        wait=True,
    )


def upsert(client: QdrantClient, ids: list[str], vectors: list[Embedded], payloads: list[dict[str, Any]]) -> None:
    points = []
    for pid, vec, payload in zip(ids, vectors, payloads):
        vector: dict[str, Any] = {"dense": vec.dense}
        if vec.sparse is not None:
            vector["sparse"] = models.SparseVector(indices=vec.sparse.indices, values=vec.sparse.values)
        points.append(models.PointStruct(id=pid, vector=vector, payload=payload))
    client.upsert(settings.collection, points=points, wait=True)


def count_points(client: QdrantClient) -> int:
    return client.count(settings.collection, exact=True).count


def build_filter(
    status: str = "active",
    org: str | None = None,
    doc_types: Iterable[str] | None = None,
    form_id: str | None = None,
) -> models.Filter | None:
    must: list[models.Condition] = []
    if settings.filter_active_only:
        must.append(models.FieldCondition(key="status", match=models.MatchValue(value=status)))
    if not settings.payload_filters:
        org, doc_types = None, None
    if org:
        must.append(models.FieldCondition(key="org", match=models.MatchValue(value=org)))
    types = [t for t in (doc_types or []) if t]
    if types:
        must.append(models.FieldCondition(key="doc_type", match=models.MatchAny(any=types)))
    if form_id:
        must.append(models.FieldCondition(key="form_ids", match=models.MatchValue(value=form_id.upper())))
    # No conditions (e.g. eci_docs_small has no status/org fields): search unfiltered.
    return models.Filter(must=must) if must else None
