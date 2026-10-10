"""Retrieval + service tests. Live tests need Qdrant with an ingested corpus;
they are skipped automatically when it is unreachable."""
from __future__ import annotations

import pytest

from rag.retrieval import form_hint, helpline_for, normalize_query, out_of_scope


def test_query_normalization_redacts_before_embedding():
    assert "1234" not in normalize_query("my aadhaar 1234 5678 9012 how to update")


def test_form_hint_and_scope():
    assert form_hint("What is Form 6B?") == "6B"
    assert form_hint("how to register") is None
    assert out_of_scope("Who should I vote for?")
    assert not out_of_scope("How do I register as a new voter?")


def test_helpline_routing():
    assert "1947" in helpline_for(None, "aadhaar update") or "UIDAI" in helpline_for(None, "aadhaar update")
    assert helpline_for("ECI") == helpline_for(None, "voter id")


def _live():
    try:
        from rag.store import count_points, get_client

        client = get_client()
        return client if count_points(client) > 0 else None
    except Exception:
        return None


live = pytest.mark.skipif(_live() is None, reason="Qdrant with ingested corpus not available")


@pytest.fixture(scope="module")
def retriever():
    from rag.embed import get_embedder
    from rag.retrieval import Retriever

    return Retriever(_live(), get_embedder())


@live
def test_known_query_returns_expected_doc_in_top3(retriever):
    out = retriever.search("What is Form 6B?", top_k=5)
    assert not out.abstain
    assert "eci-form6b" in [r["doc_id"] for r in out.results[:3]]
    cit = out.results[0]["citation"]
    for key in ["org", "doc_title", "section_path", "pages", "publication_date", "source_url"]:
        assert cit[key], key


@live
def test_political_question_abstains_with_helpline(retriever):
    out = retriever.search("Which political party should I vote for?")
    assert out.abstain and out.reason == "out_of_scope" and out.results == []
    assert out.helpline


@live
def test_off_topic_abstains(retriever):
    out = retriever.search("best recipe for chicken biryani")
    assert out.abstain and out.reason == "no_relevant_source"


@live
def test_superseded_docs_never_returned(retriever):
    out = retriever.search("Aadhaar PVC card charge", top_k=8)
    assert "uidai-handbook-2021" not in [r["doc_id"] for r in out.results]


@live
def test_reingest_is_idempotent():
    from rag.ingest import run
    from rag.store import count_points, get_client

    before = count_points(get_client())
    report = run()
    assert report["points_after"] == before
    assert all(d["action"] == "unchanged" for d in report["docs"])


def test_service_requires_token():
    from fastapi.testclient import TestClient

    from rag.service.app import app

    with TestClient(app) as client:
        assert client.post("/v1/search", json={"query": "x"}).status_code == 401
        bad = client.post("/v1/search", json={"query": "x"}, headers={"Authorization": "Bearer nope"})
        assert bad.status_code == 401
        assert client.get("/healthz").status_code == 200
