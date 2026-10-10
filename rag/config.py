"""Configuration for the RAG pipeline and service.

Values come from environment variables, optionally loaded from a gitignored
`.env` at the repo root. Secrets (Qdrant key, service token) live only here,
on the server side (spec rule 12).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader: KEY=VALUE lines, existing env vars win."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


_load_dotenv(ROOT / ".env")


def _csv(name: str, default: str) -> list[str]:
    return [item.strip().lower() for item in os.environ.get(name, default).split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    qdrant_url: str = os.environ.get("QDRANT_URL", "http://localhost:6333")
    qdrant_api_key: str | None = os.environ.get("QDRANT_API_KEY") or None
    collection: str = os.environ.get("QDRANT_COLLECTION", "gov_docs")
    # Named vectors in YOUR existing collection. Set QDRANT_SPARSE_VECTOR= (empty)
    # for a dense-only collection.
    dense_vector: str = os.environ.get("QDRANT_DENSE_VECTOR", "dense")
    sparse_vector: str = os.environ.get("QDRANT_SPARSE_VECTOR", "sparse")
    # Filter on payload status=active (spec 9.4). Turn off if your payload has no `status`.
    filter_active_only: bool = os.environ.get("FILTER_ACTIVE_ONLY", "1").strip().lower() in {"1", "true", "yes"}
    # Payload form_ids filter for "Form 6B"-style queries (spec 9.4 step 2).
    form_id_filter: bool = os.environ.get("FORM_ID_FILTER", "1").strip().lower() in {"1", "true", "yes"}
    # Default org for points whose payload has no `org` (and no doc_meta entry).
    default_org: str = os.environ.get("DEFAULT_ORG", "ECI")
    # Fallback for "Last verified" when the payload has no retrieved_at.
    corpus_last_updated: str = os.environ.get("CORPUS_LAST_UPDATED", "")
    embed_model: str = os.environ.get("EMBED_MODEL", "BAAI/bge-m3")
    embed_max_length: int = int(os.environ.get("EMBED_MAX_LENGTH", "512"))
    abstain_threshold: float = float(os.environ.get("ABSTAIN_THRESHOLD", "0.45"))
    service_token: str = os.environ.get("SERVICE_TOKEN", "change-me-dev-token")
    port: int = int(os.environ.get("RAG_PORT", "8008"))
    helpline_eci: str = os.environ.get(
        "HELPLINE_ECI", "Voter Helpline 1950 (toll-free) | https://voters.eci.gov.in"
    )
    helpline_uidai: str = os.environ.get(
        "HELPLINE_UIDAI", "UIDAI helpline 1947 (toll-free) | help@uidai.gov.in | https://uidai.gov.in"
    )
    out_of_scope_keywords: list[str] = field(
        default_factory=lambda: _csv(
            "OUT_OF_SCOPE_KEYWORDS",
            "who should i vote,which party,best party,best candidate,political party,party manifesto,"
            "bjp,congress,aap,exit poll,opinion poll,election result,predict,legal advice,sue ,lawyer",
        )
    )
    rate_limit_per_minute: int = int(os.environ.get("RAG_RATE_LIMIT_PER_MINUTE", "120"))

    # Pipeline paths
    sources_dir: Path = ROOT / "sources"
    sources_yaml: Path = ROOT / "sources.yaml"
    work_dir: Path = ROOT / "work"
    inventory_csv: Path = ROOT / "inventory.csv"
    ingest_report: Path = ROOT / "ingest_report.json"

    @property
    def is_bge_m3(self) -> bool:
        return "bge-m3" in self.embed_model.lower()


settings = Settings()

# Chunking targets (spec 9.2, step 3)
CHUNK_TARGET_TOKENS = 350
CHUNK_MAX_TOKENS = 512
CHUNK_OVERLAP_TOKENS = 50
