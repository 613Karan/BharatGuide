"""Stage 1 - extract text per page from the ECI PDFs into data/pages.jsonl.

Kept deliberately separate from embedding so extraction quality can be
inspected (and OCR'd if needed) before anything expensive happens.

Usage:
    uv run python -m argo_rag.extract
"""

from __future__ import annotations

import json
import re
import sys

try:
    import pymupdf  # PyMuPDF >= 1.24
except ImportError:  # pragma: no cover - older PyMuPDF exposes only `fitz`
    import fitz as pymupdf

from .config import DATA_DIR, DOCS_DIR, PAGES_PATH

# Pages with less text than this are probably scanned images needing OCR.
MIN_USEFUL_CHARS = 200


def doc_id_for(filename: str) -> str:
    """Stable slug used as the document identifier across all stages."""
    stem = filename.rsplit(".", 1)[0]
    return re.sub(r"[^a-z0-9]+", "_", stem.lower()).strip("_")


def normalise(text: str) -> str:
    """Tidy PDF text without destroying paragraph structure."""
    text = text.replace("\u00ad", "")               # soft hyphens
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)    # de-hyphenate line wraps
    text = re.sub(r"[ \t]+", " ", text)             # collapse runs of spaces
    text = re.sub(r"\n{3,}", "\n\n", text)          # at most one blank line
    return text.strip()


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    pdfs = sorted(DOCS_DIR.glob("*.pdf"))
    if not pdfs:
        print(f"no PDFs found in {DOCS_DIR}", file=sys.stderr)
        return 1

    total_pages = 0
    thin: list[tuple[str, int, int]] = []

    with PAGES_PATH.open("w", encoding="utf-8") as fh:
        for pdf in pdfs:
            doc = pymupdf.open(pdf)
            did = doc_id_for(pdf.name)
            print(f"{pdf.name:<45} {doc.page_count:>3} pages")
            for page_no in range(doc.page_count):
                text = normalise(doc[page_no].get_text("text"))
                if len(text) < MIN_USEFUL_CHARS:
                    thin.append((pdf.name, page_no + 1, len(text)))
                fh.write(json.dumps({
                    "doc_id": did,
                    "doc_title": pdf.stem,
                    "source_file": pdf.name,
                    "page": page_no + 1,
                    "n_chars": len(text),
                    "text": text,
                }, ensure_ascii=False) + "\n")
                total_pages += 1
            doc.close()

    print(f"\nwrote {total_pages} pages -> {PAGES_PATH}")

    if thin:
        print(f"\n{len(thin)} page(s) under {MIN_USEFUL_CHARS} chars "
              f"(likely scanned images, candidates for OCR):")
        for name, page, n in thin:
            print(f"   {name} p{page} ({n} chars)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
