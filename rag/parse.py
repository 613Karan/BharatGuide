"""Parse born-digital PDFs into page-tagged text blocks with PyMuPDF (spec 9.2, step 1).

- Text blocks keep their page number.
- Repeating headers/footers (same normalized line on many pages, near the top or
  bottom) are dropped.
- Tables found by PyMuPDF become one text unit, rows joined with " | ".
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import fitz


@dataclass
class Block:
    page: int  # 1-based
    text: str
    kind: str = "text"  # "text" | "table"
    y0: float = 0.0


_DIGITS = re.compile(r"\d+")


def _norm_line(line: str) -> str:
    """Header/footer key: page numbers vary, so digits are collapsed."""
    return _DIGITS.sub("#", re.sub(r"\s+", " ", line).strip().lower())


def _inside(rect: fitz.Rect, boxes: list[fitz.Rect]) -> bool:
    for box in boxes:
        inter = rect & box
        if not inter.is_empty and inter.get_area() >= 0.6 * max(rect.get_area(), 1):
            return True
    return False


def _table_text(table: "fitz.table.Table") -> str:
    rows = []
    for row in table.extract():
        cells = [re.sub(r"\s+", " ", (cell or "")).strip() for cell in row]
        cells = [cell for cell in cells if cell]
        if cells:
            rows.append(" | ".join(cells))
    return "\n".join(rows)


def parse_pdf(path: Path, detect_tables: bool = True) -> list[Block]:
    doc = fitz.open(path)
    raw: list[Block] = []
    edge_lines: Counter[str] = Counter()
    page_count = len(doc)

    for index, page in enumerate(doc):
        height = page.rect.height or 1
        table_boxes: list[fitz.Rect] = []
        if detect_tables:
            try:
                tables = page.find_tables()
                for table in tables.tables:
                    text = _table_text(table)
                    # Ignore 1-row "tables" (layout boxes, not data tables).
                    if text.count("\n") >= 1:
                        table_boxes.append(fitz.Rect(table.bbox))
                        raw.append(Block(page=index + 1, text=text, kind="table", y0=table.bbox[1]))
            except Exception:
                pass

        for x0, y0, x1, y1, text, *_ in page.get_text("blocks", sort=True):
            if not text.strip():
                continue
            if table_boxes and _inside(fitz.Rect(x0, y0, x1, y1), table_boxes):
                continue
            raw.append(Block(page=index + 1, text=text, y0=y0))
            if y0 < height * 0.1 or y1 > height * 0.9:
                for line in text.splitlines():
                    if line.strip():
                        edge_lines[_norm_line(line)] += 1

    doc.close()

    # A line that repeats on >= 50% of pages (min 3) near the edges is a header/footer.
    threshold = max(3, int(page_count * 0.5))
    repeating = {line for line, count in edge_lines.items() if count >= threshold}

    blocks: list[Block] = []
    for block in sorted(raw, key=lambda b: (b.page, b.y0)):
        if block.kind == "text" and repeating:
            kept = [line for line in block.text.splitlines() if _norm_line(line) not in repeating]
            text = "\n".join(kept)
        else:
            text = block.text
        # Page markers such as "Page 3 of 24".
        text = re.sub(r"(?im)^\s*page\s+\d+\s+of\s+\d+\s*$", "", text)
        if text.strip():
            blocks.append(Block(page=block.page, text=text, kind=block.kind, y0=block.y0))
    return blocks
