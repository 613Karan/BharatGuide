"""Stage 2 - turn extracted pages into retrieval chunks.

Structure-aware packing, sized in TOKENS (see tokens.py):
  * paragraphs are never split mid-sentence unless a single paragraph exceeds
    the token budget, then it is split on sentences, then on words;
  * chunks are packed up to TARGET_TOKENS with an OVERLAP_TOKENS tail carried
    into the next chunk, so a clause straddling a boundary stays retrievable;
  * each chunk is labelled with the section where its own text begins;
  * runs of dotted/underscore form blanks are collapsed to a single ellipsis:
    they carry no information but can cost one token per character.

Chunks are packed one page at a time, so a chunk never spans two pages and
citations always point at an exact page.

Usage:
    uv run python -m argo_rag.chunk
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import asdict, dataclass

from .config import (
    CHUNKS_PATH,
    MIN_CHUNK_CHARS,
    OVERLAP_TOKENS,
    PAGES_PATH,
    PROFILE,
    TARGET_TOKENS,
)
from .tokens import count_tokens

# Lines that look like a section/rule heading in the ECI documents.
HEADING_RE = re.compile(
    r"^(?:"
    r"CHAPTER\s+[IVXLC]+|PART\s+[IVXLC]+|"
    r"FORM\s+\d+[A-Z]?(?:\s|$)|"
    r"(?:Section|Rule|Article)\s+\d+[A-Z]?|"
    r"\d+\.\s+[A-Z]|"          # "12. Qualification of electors"
    r"\d+\.\d+\s+[A-Z]|"       # "12.1 Something"
    r"[IVXLC]+\.\s+[A-Z]"      # "III. Something"
    r")"
)

# Split points used when a single paragraph is too long to be one chunk.
SENTENCE_RE = re.compile(r"(?<=[.;])\s+")

# Dotted / underscore fill-in blanks, e.g. "Date.................".
FILLER_RE = re.compile(r"[.…·_]{4,}")
FILLER_GAP_RE = re.compile(r"(?:…\s*){2,}")


@dataclass
class Chunk:
    doc_id: str
    doc_title: str
    source_file: str
    chunk_index: int
    page_start: int
    page_end: int
    section: str
    n_chars: int
    n_tokens: int
    text: str


def collapse_filler(line: str) -> str:
    line = FILLER_RE.sub("…", line)
    return FILLER_GAP_RE.sub("… ", line).strip()


# Amendment footnotes ("1. Ins. by Notifn. ...", "2. Subs. by ...") look like
# numbered headings but are not section titles.
FOOTNOTE_RE = re.compile(
    r"^\d+\.\s*(?:Ins|Subs|Omitted|Rep|Added|Renumbered|The words?|The figures?|"
    r"Sub-?section|Clause|See|Vide|Corrected)\b",
    re.IGNORECASE,
)


def is_heading(line: str) -> bool:
    stripped = line.strip()
    if not stripped or len(stripped) > 120:
        return False
    if FOOTNOTE_RE.match(stripped):
        return False
    return bool(HEADING_RE.match(stripped))


def hard_split(text: str) -> list[str]:
    """Last resort for text with no sentence breaks: split on words, and slice
    any single word that alone exceeds the budget."""
    pieces: list[str] = []
    buf = ""
    for word in text.split():
        n = count_tokens(word)
        if n > TARGET_TOKENS:
            if buf:
                pieces.append(buf)
                buf = ""
            step = max(1, len(word) * TARGET_TOKENS // n - 1)
            pieces.extend(word[i:i + step] for i in range(0, len(word), step))
            continue
        candidate = f"{buf} {word}".strip()
        if buf and count_tokens(candidate) > TARGET_TOKENS:
            pieces.append(buf)
            buf = word
        else:
            buf = candidate
    if buf:
        pieces.append(buf)
    return pieces


def split_long(text: str) -> list[str]:
    """Break a paragraph over the token budget on sentence boundaries."""
    if count_tokens(text) <= TARGET_TOKENS:
        return [text]
    pieces: list[str] = []
    buf = ""
    for sentence in SENTENCE_RE.split(text):
        if count_tokens(sentence) > TARGET_TOKENS:
            if buf:
                pieces.append(buf)
                buf = ""
            pieces.extend(hard_split(sentence))
            continue
        candidate = f"{buf} {sentence}".strip()
        if buf and count_tokens(candidate) > TARGET_TOKENS:
            pieces.append(buf)
            buf = sentence
        else:
            buf = candidate
    if buf:
        pieces.append(buf)
    return pieces


def units_for(record: dict) -> list[tuple[int, str, str]]:
    """Return (page, kind, text) units, kind in {'heading', 'para'}."""
    units: list[tuple[int, str, str]] = []
    buf: list[str] = []
    page = record["page"]

    def flush_buf() -> None:
        if buf:
            joined = " ".join(buf).strip()
            for piece in split_long(joined):
                units.append((page, "para", piece))
            buf.clear()

    for raw_line in record["text"].split("\n"):
        line = collapse_filler(raw_line)
        if not line:
            flush_buf()
        elif is_heading(line):
            flush_buf()
            units.append((page, "heading", line))
        else:
            buf.append(line)
    flush_buf()
    return units


def pack_document(record: dict) -> list[Chunk]:
    """Pack ONE page into chunks. Each unit is (tokens, text, section)."""
    units = units_for(record)
    chunks: list[Chunk] = []
    cur: list[tuple[int, str, str]] = []
    carried = 0   # leading units of `cur` copied over from the previous chunk
    section = ""
    page = record["page"]

    def cur_tokens() -> int:
        return sum(n for n, _, _ in cur)

    def flush() -> list[tuple[int, str, str]]:
        """Emit the current chunk; return units to carry over as overlap."""
        nonlocal cur, carried
        if not cur:
            return []
        text = " ".join(t for _, t, _ in cur).strip()
        if len(text) >= MIN_CHUNK_CHARS:
            # Label with the section where this chunk's OWN text begins, not
            # the overlap carried in, and not a heading belonging to the next.
            own = cur[carried:] or cur
            chunks.append(Chunk(
                doc_id=record["doc_id"],
                doc_title=record["doc_title"],
                source_file=record["source_file"],
                chunk_index=0,                  # renumbered per document
                page_start=page,
                page_end=page,
                section=own[0][2],
                n_chars=len(text),
                n_tokens=count_tokens(text),
                text=text,
            ))
        carry: list[tuple[int, str, str]] = []
        total = 0
        for unit in reversed(cur):
            if total + unit[0] > OVERLAP_TOKENS:
                break
            carry.insert(0, unit)
            total += unit[0]
        carried = len(carry)
        cur = []
        return carry

    for _page, kind, text in units:
        n = count_tokens(text)
        if kind == "heading":
            section = text
            if cur_tokens() >= TARGET_TOKENS * 0.75:
                cur = flush()
        elif cur and cur_tokens() + n > TARGET_TOKENS:
            cur = flush()
        cur.append((n, text, section))

    flush()
    return chunks


def main() -> int:
    if not PAGES_PATH.exists():
        print(f"missing {PAGES_PATH} - run `python -m argo_rag.extract` first",
              file=sys.stderr)
        return 1

    with PAGES_PATH.open(encoding="utf-8") as fh:
        records = [json.loads(line) for line in fh if line.strip()]

    all_chunks: list[Chunk] = []
    for doc_id in dict.fromkeys(r["doc_id"] for r in records):
        doc_chunks: list[Chunk] = []
        for rec in (r for r in records if r["doc_id"] == doc_id):
            doc_chunks.extend(pack_document(rec))
        for i, chunk in enumerate(doc_chunks):  # deterministic contiguous ids
            chunk.chunk_index = i
        all_chunks.extend(doc_chunks)

    CHUNKS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CHUNKS_PATH.open("w", encoding="utf-8") as fh:
        for chunk in all_chunks:
            fh.write(json.dumps(asdict(chunk), ensure_ascii=False) + "\n")

    toks = sorted(c.n_tokens for c in all_chunks)
    chars = sorted(c.n_chars for c in all_chunks)
    print(f"profile={PROFILE}: wrote {len(all_chunks)} chunks -> {CHUNKS_PATH}")
    if toks:
        print(f"  tokens: min={toks[0]} median={toks[len(toks) // 2]} max={toks[-1]}"
              f"  (budget {TARGET_TOKENS} + {OVERLAP_TOKENS} overlap)")
        print(f"  chars : min={chars[0]} median={chars[len(chars) // 2]} "
              f"max={chars[-1]}")

    per_doc: dict[str, int] = {}
    for chunk in all_chunks:
        per_doc[chunk.doc_id] = per_doc.get(chunk.doc_id, 0) + 1
    print("\nchunks per document:")
    for doc_id, count in sorted(per_doc.items()):
        print(f"   {doc_id:<40} {count:>4}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
