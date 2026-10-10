"""Inventory of source PDFs (spec 9.1).

    python -m rag.inventory ./sources

Writes inventory.csv with: path, sha256, bytes, pages, has_text_layer, org,
source_url, publication_date, notes. A file is *included* only when it has a
text layer (no OCR, D2) AND sources.yaml gives it a known org + source_url
(rule 11). Everything else is listed with the reason it was excluded.
"""
from __future__ import annotations

import csv
import hashlib
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import fitz  # PyMuPDF
import yaml

from .config import settings

KNOWN_ORGS = {"ECI", "UIDAI"}
DOC_TYPES = {"form", "form_instructions", "rules", "faq", "circular", "guide", "charges"}
# Minimum ASCII letters per page for a page to count as having a text layer.
MIN_LETTERS_PER_PAGE = 80


@dataclass
class InventoryRow:
    path: str
    sha256: str
    bytes: int
    pages: int
    has_text_layer: bool
    org: str
    source_url: str
    publication_date: str
    notes: str
    included: bool
    doc_id: str = ""
    title: str = ""
    doc_type: str = ""
    version: str = ""
    status: str = ""


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def text_layer_stats(path: Path) -> tuple[int, bool, str]:
    """Return (pages, has_text_layer, note). Scanned/garbled PDFs have no usable layer."""
    try:
        doc = fitz.open(path)
    except Exception as exc:  # not a PDF, encrypted, corrupt
        return 0, False, f"cannot open: {exc}"
    pages = len(doc)
    if pages == 0:
        return 0, False, "empty pdf"
    letters = 0
    for page in doc:
        letters += sum(1 for ch in page.get_text() if ch.isascii() and ch.isalpha())
    doc.close()
    ok = letters >= MIN_LETTERS_PER_PAGE * pages * 0.5
    note = "" if ok else f"no usable English text layer ({letters} letters / {pages} pages); OCR is out of scope"
    return pages, ok, note


def load_sources_yaml(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return {str(k): (v or {}) for k, v in data.items()}


def build_inventory(sources_dir: Path, meta: dict[str, dict[str, Any]]) -> list[InventoryRow]:
    rows: list[InventoryRow] = []
    seen_hashes: dict[str, str] = {}
    for path in sorted(sources_dir.iterdir()):
        if not path.is_file():
            continue
        digest = sha256_of(path)
        size = path.stat().st_size
        info = meta.get(path.name, {})
        notes: list[str] = []

        if path.suffix.lower() != ".pdf":
            pages, has_text, note = 0, False, "not a PDF (only born-digital PDFs are supported)"
        else:
            pages, has_text, note = text_layer_stats(path)
        if note:
            notes.append(note)

        org = str(info.get("org", "")).upper()
        source_url = str(info.get("source_url", ""))
        if not info:
            notes.append("not listed in sources.yaml: unknown provenance")
        elif org not in KNOWN_ORGS:
            notes.append(f"unknown org '{org}'")
        if info and not source_url.startswith("https://"):
            notes.append("missing https source_url")
        doc_type = str(info.get("doc_type", ""))
        if info and doc_type not in DOC_TYPES:
            notes.append(f"unknown doc_type '{doc_type}'")
        if digest in seen_hashes:
            notes.append(f"duplicate of {seen_hashes[digest]}")
        elif info:
            seen_hashes[digest] = path.name

        included = has_text and not notes
        rows.append(
            InventoryRow(
                path=str(path.relative_to(sources_dir.parent)).replace("\\", "/"),
                sha256=digest,
                bytes=size,
                pages=pages,
                has_text_layer=has_text,
                org=org,
                source_url=source_url,
                publication_date=str(info.get("publication_date", "")),
                notes="; ".join(notes),
                included=included,
                doc_id=str(info.get("doc_id", "")),
                title=str(info.get("title", "")),
                doc_type=doc_type,
                version=str(info.get("version", "")),
                status=str(info.get("status", "active")),
            )
        )
    return rows


CSV_FIELDS = [
    "path", "sha256", "bytes", "pages", "has_text_layer", "org",
    "source_url", "publication_date", "notes",
]


def write_csv(rows: list[InventoryRow], out: Path) -> None:
    with out.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS + ["included"])
        writer.writeheader()
        for row in rows:
            record = asdict(row)
            writer.writerow({key: record[key] for key in CSV_FIELDS + ["included"]})


def main(argv: list[str]) -> int:
    sources_dir = Path(argv[1]) if len(argv) > 1 else settings.sources_dir
    rows = build_inventory(sources_dir.resolve(), load_sources_yaml(settings.sources_yaml))
    write_csv(rows, settings.inventory_csv)
    for row in rows:
        mark = "OK  " if row.included else "SKIP"
        print(f"{mark} {row.path:45} pages={row.pages:<3} {row.notes}")
    print(f"\n{sum(r.included for r in rows)} included, {sum(not r.included for r in rows)} skipped -> {settings.inventory_csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
