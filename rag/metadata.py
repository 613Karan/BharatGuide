"""Per-chunk payload (spec 9.2, step 4)."""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any

from .chunk import Chunk, embedding_header

# "Form 6", "Form-6B", "Form No. 8", "Form 6A" -> "6", "6B", "8", "6A"
_FORM_ID = re.compile(r"\bForm[\s\-]*(?:No\.?\s*)?(\d{1,2}[A-Z]?)\b", re.I)

# Portal UI labels that appear in official text (used by the ghost to look up
# elements by accessible name; spec 9.6). Optional, kept small and literal.
_UI_LABEL_CANDIDATES = [
    "Register as New Elector",
    "Fill Form 6",
    "Fill Form 8",
    "Fill Form 6B",
    "Search in Electoral Roll",
    "Track Application Status",
    "Login",
    "Sign-Up",
    "Book an Appointment",
    "Update Demographics Data",
    "Document Update",
    "Download Aadhaar",
    "Check Aadhaar Status",
    "Order Aadhaar PVC Card",
    "Locate Enrolment Center",
]

_TOPICS = {
    "registration": ["new voter", "new elector", "enrolment", "enrollment", "form-6", "form 6"],
    "aadhaar_linking": ["form-6b", "form 6b", "authentication"],
    "correction": ["correction", "shifting", "form-8", "form 8", "replacement of epic"],
    "deletion": ["form-7", "form 7", "deletion", "objection"],
    "documents": ["proof of identity", "proof of address", "poi", "poa", "document"],
    "fees": ["₹", "rs.", "fee", "charges", "free"],
    "aadhaar_update": ["update", "demographic", "biometric"],
}


def extract_form_ids(text: str) -> list[str]:
    return sorted({match.upper() for match in _FORM_ID.findall(text)})


def extract_ui_labels(text: str) -> list[str]:
    lowered = text.lower()
    return [label for label in _UI_LABEL_CANDIDATES if label.lower() in lowered]


def topic_tags(text: str) -> list[str]:
    lowered = text.lower()
    return sorted(tag for tag, words in _TOPICS.items() if any(w in lowered for w in words))


def point_id(doc_id: str, doc_sha256: str, chunk_index: int) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"{doc_id}:{doc_sha256}:{chunk_index}"))


def build_payload(chunk: Chunk, doc: dict[str, Any], retrieved_at: str | None = None) -> dict[str, Any]:
    retrieved_at = retrieved_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "doc_id": doc["doc_id"],
        "doc_sha256": doc["sha256"],
        "org": doc["org"],
        "doc_title": doc["title"],
        "doc_type": doc["doc_type"],
        "section_path": chunk.section_path,
        "page_start": chunk.page_start,
        "page_end": chunk.page_end,
        "pages": chunk.pages or list(range(chunk.page_start, chunk.page_end + 1)),
        "chunk_index": chunk.chunk_index,
        "form_ids": extract_form_ids(chunk.text),
        "topic_tags": topic_tags(chunk.text),
        "ui_labels": extract_ui_labels(chunk.text),
        "publication_date": doc["publication_date"],
        "version": doc["version"],
        "status": doc["status"],
        "source_url": doc["source_url"],
        "retrieved_at": retrieved_at,
        "text": chunk.text,
        "token_count": chunk.token_count,
    }


def text_for_embedding(payload: dict[str, Any]) -> str:
    return embedding_header(payload["org"], payload["doc_title"], payload["section_path"]) + payload["text"]
