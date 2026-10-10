"""Structure-aware chunking (spec 9.2, step 3).

1. Blocks are split into *units* at structural boundaries: headings, numbered
   sections/clauses ("1.", "4.", "Item 7"), and FAQ questions ("Q.", lines
   ending in "?"). A table block is always one unit. Lettered sub-clauses
   ("(a)") stay inside their numbered clause, so procedures are not split.
2. Units are grouped into chunks of ~350 tokens (hard max 512, BGE-M3
   tokenizer). Units are never split unless a single unit is over the max; then
   it is cut on line/sentence boundaries with ~50 tokens of overlap.
3. Each chunk keeps its section path and page range.

The token counter is injected so tests can use a cheap stand-in.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable, Iterable

from .clean import clean_text
from .config import CHUNK_MAX_TOKENS, CHUNK_OVERLAP_TOKENS, CHUNK_TARGET_TOKENS
from .parse import Block

TokenCounter = Callable[[str], int]

_NUMBERED = re.compile(r"^(?:\d{1,2}(?:\.\d{1,2})*[.)]\s+\S|item\s*\(?\d+)", re.I)
_QUESTION = re.compile(r"^(?:q(?:uestion)?\s*\d*\s*[.:)-]\s*\S|faq\b)", re.I)
_HEADING_WORDS = re.compile(
    r"^(?:part|chapter|section|annexure|schedule|list\s+[ivx]+\b|enrolment type|table-?\d)", re.I
)


def is_heading(line: str) -> bool:
    text = line.strip()
    if not text or len(text) > 90:
        return False
    if _HEADING_WORDS.match(text):
        return True
    letters = [ch for ch in text if ch.isalpha()]
    # SHORT ALL-CAPS LINES are headings ("GUIDELINES FOR FILLING UP THE APPLICATION").
    return len(letters) >= 6 and all(ch.isupper() for ch in letters) and not text.endswith(".")


def is_question(line: str) -> bool:
    text = line.strip()
    return bool(_QUESTION.match(text)) or (text.endswith("?") and len(text) > 12)


def starts_unit(line: str) -> bool:
    text = line.strip()
    return bool(_NUMBERED.match(text)) or is_question(text) or is_heading(text)


@dataclass
class Unit:
    text: str
    page_start: int
    page_end: int
    section_path: str
    kind: str = "text"


@dataclass
class Chunk:
    text: str
    section_path: str
    page_start: int
    page_end: int
    token_count: int = 0
    chunk_index: int = 0
    pages: list[int] = field(default_factory=list)


def _section_label(line: str) -> str:
    return re.sub(r"\s+", " ", line.strip()).rstrip(":-–—")[:80]


def build_units(blocks: Iterable[Block], doc_title: str) -> list[Unit]:
    """Split page blocks into structural units, tracking a 2-level section path."""
    units: list[Unit] = []
    heading = ""
    sub = ""
    current: list[str] = []
    cur_start = cur_end = 0

    def path() -> str:
        parts = [p for p in (heading, sub) if p]
        return " > ".join(parts) if parts else doc_title

    def flush() -> None:
        nonlocal current
        text = clean_text("\n".join(current))
        if text:
            units.append(Unit(text=text, page_start=cur_start, page_end=cur_end, section_path=path()))
        current = []

    for block in blocks:
        if block.kind == "table":
            flush()
            text = clean_text(block.text)
            if text:
                units.append(Unit(text, block.page, block.page, path(), kind="table"))
            continue
        for line in clean_text(block.text).split("\n"):
            if not line.strip():
                continue
            if starts_unit(line) and current:
                flush()
            if not current:
                cur_start = block.page
            if is_heading(line):
                heading, sub = _section_label(line), ""
            elif _NUMBERED.match(line.strip()) or is_question(line):
                sub = _section_label(line)
            current.append(line)
            cur_end = block.page
    flush()
    return units


def _split_long(text: str, count: TokenCounter, max_tokens: int, overlap: int) -> list[str]:
    """Cut an over-long unit on line, then sentence boundaries, with token overlap."""
    pieces: list[str] = []
    for piece in (p for p in re.split(r"(?<=[.;:])\s+|\n", text) if p.strip()):
        if count(piece) <= max_tokens:
            pieces.append(piece)
            continue
        # A single sentence larger than max: hard-cut by words.
        words = piece.split()
        parts = count(piece) // max_tokens + 2
        step = max(1, len(words) // parts)
        pieces.extend(" ".join(words[i : i + step]) for i in range(0, len(words), step))

    out: list[str] = []
    window: list[str] = []
    for part in pieces:
        if window and count("\n".join(window + [part])) > max_tokens:
            out.append("\n".join(window))
            tail: list[str] = []
            for prev in reversed(window):
                if count("\n".join([prev] + tail)) > overlap:
                    break
                tail.insert(0, prev)
            window = tail + [part]
            if count("\n".join(window)) > max_tokens:
                window = [part]
        else:
            window.append(part)
    if window:
        out.append("\n".join(window))
    return out


def chunk_units(
    units: list[Unit],
    count: TokenCounter,
    target: int = CHUNK_TARGET_TOKENS,
    max_tokens: int = CHUNK_MAX_TOKENS,
    overlap: int = CHUNK_OVERLAP_TOKENS,
    header_tokens: int = 0,
) -> list[Chunk]:
    """Greedy grouping of whole units. `header_tokens` reserves room for the
    embedding prefix so text_for_embedding also stays under max_tokens."""
    budget = max_tokens - header_tokens
    chunks: list[Chunk] = []
    buf: list[Unit] = []

    def emit(group: list[Unit]) -> None:
        if not group:
            return
        text = "\n".join(u.text for u in group)
        pages = sorted({p for u in group for p in range(u.page_start, u.page_end + 1)})
        chunks.append(Chunk(text, group[0].section_path, pages[0], pages[-1], count(text), pages=pages))

    for unit in units:
        if count(unit.text) > budget:
            emit(buf)
            buf = []
            for part in _split_long(unit.text, count, budget, overlap):
                emit([Unit(part, unit.page_start, unit.page_end, unit.section_path, unit.kind)])
            continue
        if buf:
            buf_tokens = count("\n".join(u.text for u in buf))
            joined = count("\n".join([u.text for u in buf] + [unit.text]))
            top = lambda u: u.section_path.split(" > ")[0]  # noqa: E731
            new_section = top(unit) != top(buf[-1]) and buf_tokens >= target * 0.4
            if joined > target or joined > budget or new_section:
                emit(buf)
                buf = []
        buf.append(unit)
    emit(buf)

    for index, chunk in enumerate(chunks):
        chunk.chunk_index = index
    return chunks


def embedding_header(org: str, doc_title: str, section_path: str) -> str:
    return f"{org} | {doc_title} | {section_path}\n"

