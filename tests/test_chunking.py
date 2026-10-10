"""Chunk constraints (spec 11): structure-aware splits, no chunk over 512 tokens."""
import json
from pathlib import Path

import pytest

from rag.chunk import build_units, chunk_units, is_heading, starts_unit
from rag.metadata import extract_form_ids, point_id
from rag.parse import Block

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "work"


def words(text: str) -> int:
    return len(text.split())


def test_headings_and_unit_starts():
    assert is_heading("GUIDELINES FOR FILLING UP THE APPLICATION")
    assert not is_heading("The applicant can fill entries.")
    assert starts_unit("4. Item (5)Aadhaar Details: Aadhaar Number should be furnished")
    assert starts_unit("What are the stages of Special Summery Revision of ER?")
    assert not starts_unit("(a) The application will be addressed to the ERO")


def test_lettered_clauses_stay_with_their_numbered_clause():
    blocks = [Block(1, "1. General Instructions:-\n(a) first rule.\n(b) second rule.\n2. Item (1) Name: exact spelling.")]
    units = build_units(blocks, "Doc")
    assert len(units) == 2
    assert "(a) first rule." in units[0].text and "(b) second rule." in units[0].text
    assert units[1].section_path.endswith("2. Item (1) Name: exact spelling.")


def test_faq_question_kept_with_answer():
    blocks = [Block(1, "What is SSR?\nAns.\nIt is a revision.\nWho does it?\nAns.\nThe ERO.")]
    units = build_units(blocks, "FAQ")
    assert [u.text.split("\n")[0] for u in units] == ["What is SSR?", "Who does it?"]
    assert "It is a revision." in units[0].text


def test_table_is_one_unit_and_never_split():
    table = "\n".join(f"{i} | Document {i} | Yes | No" for i in range(30))
    units = build_units([Block(1, "1. Intro text."), Block(1, table, kind="table")], "Doc")
    chunks = chunk_units(units, words, target=60, max_tokens=200)
    assert sum(table in c.text for c in chunks) == 1


def test_long_unit_is_cut_under_max_with_contiguous_index():
    long = "1. Start. " + " ".join(f"Sentence number {i} is here." for i in range(400))
    units = build_units([Block(1, long)], "Doc")
    chunks = chunk_units(units, words, target=50, max_tokens=100, overlap=10)
    assert len(chunks) > 3
    assert all(words(c.text) <= 100 for c in chunks)
    assert [c.chunk_index for c in chunks] == list(range(len(chunks)))


def test_form_ids_and_stable_point_ids():
    assert extract_form_ids("Fill Form-6B or Form 8 and FORM No. 6") == ["6", "6B", "8"]
    assert point_id("d", "sha", 0) == point_id("d", "sha", 0)
    assert point_id("d", "sha", 0) != point_id("d", "sha2", 0)


@pytest.mark.skipif(not WORK.exists(), reason="run `python -m rag.ingest --dry-run` first")
def test_ingested_chunks_respect_512_tokens():
    from rag.embed import count_tokens
    from rag.metadata import text_for_embedding

    files = list(WORK.glob("*.chunks.json"))
    assert files
    for f in files:
        chunks = json.loads(f.read_text(encoding="utf-8"))
        assert [c["chunk_index"] for c in chunks] == list(range(len(chunks)))
        for c in chunks:
            assert count_tokens(text_for_embedding(c)) <= 512, (f.name, c["chunk_index"])
