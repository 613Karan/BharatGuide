"""Central configuration for the ARGO RAG pipeline.

The embedding model is part of the index *format*: each profile below writes to
its own Qdrant collection, so "small" and "m3" indexes can coexist and you can
switch with an environment variable, no code changes:

    ARGO_PROFILE=small  (default)  BAAI/bge-small-en-v1.5 + BM25 sparse (fastembed)
    ARGO_PROFILE=m3                BAAI/bge-m3 dense + learned sparse (FlagEmbedding)
"""

from __future__ import annotations

import os
from pathlib import Path

# --- paths -----------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = PROJECT_ROOT / "ECI ground source docs"
DATA_DIR = PROJECT_ROOT / "data"
PAGES_PATH = DATA_DIR / "pages.jsonl"

# --- embedding profiles ----------------------------------------------------
PROFILES: dict[str, dict] = {
    "small": {
        "backend": "fastembed",
        "model": "BAAI/bge-small-en-v1.5",   # English-only, 384-d, 512 tokens
        "sparse_model": "Qdrant/bm25",       # lexical leg (needs IDF modifier)
        "dim": 384,
        "max_length": 512,
        "batch_size": 32,
        "sparse_idf": True,
        "tokenizer": "BAAI/bge-small-en-v1.5",   # used to MEASURE chunk size
        "target_tokens": 380,                # chunk budget, in model tokens
        "overlap_tokens": 60,
        # bge-*-en-v1.5 retrieval instruction, applied to queries only
        "query_prefix": "Represent this sentence for searching relevant passages: ",
    },
    "m3": {
        "backend": "flagembedding",
        "model": "BAAI/bge-m3",              # multilingual, 1024-d, 8192 tokens
        "sparse_model": None,                # sparse comes from the same model
        "dim": 1024,
        "max_length": 1024,
        "batch_size": 8,
        "sparse_idf": False,
        "tokenizer": "BAAI/bge-m3",
        "target_tokens": 700,
        "overlap_tokens": 80,
        "query_prefix": "",
    },
}

PROFILE = os.environ.get("ARGO_PROFILE", "small")
if PROFILE not in PROFILES:
    raise SystemExit(f"unknown ARGO_PROFILE={PROFILE!r}; choose from {list(PROFILES)}")
CFG = PROFILES[PROFILE]

EMBED_MODEL = CFG["model"]
DENSE_DIM = CFG["dim"]

# --- chunking (profile-dependent so chunks fit the model's context) ---------
# Sizes are in TOKENS, not characters: legal text with dotted form blanks can
# be ~1.4 chars/token, so a character budget silently overflows the model's
# context window (anything past max_length is dropped before embedding).
TARGET_TOKENS = CFG["target_tokens"]
OVERLAP_TOKENS = CFG["overlap_tokens"]
HEADER_RESERVE_TOKENS = 64    # room for the contextual header (see below)
SPECIAL_TOKENS = 2            # [CLS]/[SEP] or <s>/</s>
MIN_CHUNK_CHARS = 200

# A chunk is at most TARGET + OVERLAP tokens (carried overlap + one new unit),
# and the header and special tokens are added on top of that at embed time.
assert (TARGET_TOKENS + OVERLAP_TOKENS + HEADER_RESERVE_TOKENS + SPECIAL_TOKENS
        <= CFG["max_length"]), "chunk budget exceeds the model's max_length"
# Chunks are model-dependent, so each profile keeps its own file.
CHUNKS_PATH = DATA_DIR / f"chunks_{PROFILE}.jsonl"
INDEX_META_PATH = DATA_DIR / f"index_meta_{PROFILE}.json"

# --- contextual header ------------------------------------------------------
# Prepended to each chunk ONLY for embedding (the stored/displayed text is
# unchanged). It tells the model which document a chunk belongs to, which
# separates near-identical texts such as the Form 6 and Form 6A guidelines.
CONTEXTUAL_HEADERS = os.environ.get("ARGO_CONTEXT", "1") != "0"
DOC_CONTEXT: dict[str, str] = {
    "form_6_en": "Form 6 guidelines: application for inclusion of name in the "
                 "electoral roll, registering as a new voter in India",
    "form_6a_en": "Form 6A guidelines: application for registration of an Indian "
                  "citizen living abroad (overseas elector, passport holder)",
    "form_7_en": "Form 7 guidelines: objection to inclusion of a name, or "
                 "request for deletion of a name, in the electoral roll",
    "form_8_en": "Form 8 guidelines: shifting of residence, correction of "
                 "entries, replacement EPIC voter ID card, marking PwD",
    "form_6_english": "Form 6 application form: new voter registration, with "
                      "the list of age proof and address proof documents",
    "form_6a_english": "Form 6A application form and guidelines: overseas "
                       "(NRI) elector registration, passport details",
    "form_7_english": "Form 7 application form: objection to inclusion of a "
                      "name or deletion of a name in the electoral roll",
    "form_8_english": "Form 8 application form: shifting of residence, "
                      "correction of entries, replacement EPIC, marking PwD, "
                      "with address proof documents",
    "declaration_form_english": "Declaration Form (Annexure-IV) submitted "
                                "along with Form 6 or Form 8",
    "voterguide2025eng": "Voter Guide 2025 (Election Commission of India)",
    "registration_of_electors_rules": "Registration of Electors Rules, 1960",
    "representation_of_the_people_act_1950":
        "Representation of the People Act, 1950",
}

# --- qdrant ----------------------------------------------------------------
QDRANT_URL = "http://localhost:6333"
COLLECTION = f"eci_docs_{PROFILE}"
DENSE_VECTOR = "dense"
SPARSE_VECTOR = "sparse"
UPSERT_BATCH = 64
