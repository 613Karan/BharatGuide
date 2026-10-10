"""Personal-data redaction (spec rule 13, section 12).

Aadhaar-like (12 digits, optional spaces/hyphens), EPIC-like (3 letters + 7
digits), 10-digit Indian mobiles (optional +91/0 prefix) and emails become
[REDACTED]. Mirrors shell/src/rag/redact.ts; keep both in sync.
"""
from __future__ import annotations

import re

REDACTED = "[REDACTED]"

_PATTERNS: list[re.Pattern[str]] = [
    # Email first, so digits inside an address do not leave fragments.
    re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    # Aadhaar: 12 digits, optionally grouped 4-4-4 by spaces or hyphens.
    re.compile(r"(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}(?!\d)"),
    # EPIC: 3 letters followed by 7 digits.
    re.compile(r"\b[A-Za-z]{3}\d{7}\b"),
    # Mobile: optional +91 / 91 / 0 prefix, then 10 digits starting 6-9.
    re.compile(r"(?<!\d)(?:\+?91[ -]?|0)?[6-9]\d{4}[ -]?\d{5}(?!\d)"),
]


def redact(text: str) -> tuple[str, bool]:
    """Return (redacted_text, changed)."""
    out = text
    for pattern in _PATTERNS:
        out = pattern.sub(REDACTED, out)
    return out, out != text


def redact_text(text: str) -> str:
    return redact(text)[0]
