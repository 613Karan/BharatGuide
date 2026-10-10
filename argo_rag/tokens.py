"""Token counting with the active profile's own tokenizer.

Chunk sizes are budgeted in tokens because that is what the embedding model's
context window limits, and chars-per-token varies wildly (about 4 for prose, but
under 1.5 for dotted form blanks and statutory reference text).
"""

from __future__ import annotations

from functools import lru_cache

from .config import CFG


@lru_cache(maxsize=1)
def _tokenizer():
    from huggingface_hub import hf_hub_download
    from tokenizers import Tokenizer

    return Tokenizer.from_file(hf_hub_download(CFG["tokenizer"], "tokenizer.json"))


def count_tokens(text: str) -> int:
    """Number of model tokens in `text`, excluding [CLS]/[SEP]-style specials."""
    return len(_tokenizer().encode(text, add_special_tokens=False).ids)
