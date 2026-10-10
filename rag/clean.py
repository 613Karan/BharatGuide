"""Text cleaning (spec 9.2, step 2).

NFC-normalize, fix hyphenated line breaks, collapse whitespace. Section numbers,
clause markers and form IDs are kept exactly as printed.
"""
from __future__ import annotations

import re
import unicodedata

# Control / private-use glyphs PyMuPDF emits for bullets (e.g. \x07, \uf0b7).
_JUNK = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\u200b-\u200d\ufeff\ue000-\uf8ff]")
_SPACES = re.compile(r"[ \t\u00a0]+")
_BLANK_LINES = re.compile(r"\n{3,}")


def clean_text(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = _JUNK.sub(" ", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # "regis-\ntration" -> "registration". Form IDs like "Form-\n6" are kept
    # intact because the right side is a digit after a word: join without hyphen
    # only when both sides are lowercase letters.
    text = re.sub(r"([a-z])-\n([a-z])", r"\1\2", text)
    text = _SPACES.sub(" ", text)
    lines = [line.strip() for line in text.split("\n")]
    text = "\n".join(lines)
    text = _BLANK_LINES.sub("\n\n", text)
    return text.strip()


def normalize_ws(text: str) -> str:
    """Single-line, whitespace-collapsed, lowercase form used for comparisons."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", text)).strip().lower()
