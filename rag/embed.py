"""Embeddings (spec 9.2 step 5, 9.4 step 3).

BGE-M3 via FlagEmbedding: dense 1024-d + sparse lexical weights. If EMBED_MODEL
is bge-small-en-v1.5 (CPU fallback), dense only and the sparse branch is
dropped everywhere. Queries are embedded exactly as written (no prefix).
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from functools import lru_cache

from .config import settings


@dataclass
class SparseVec:
    indices: list[int]
    values: list[float]


@dataclass
class Embedded:
    dense: list[float]
    sparse: SparseVec | None


def _to_sparse(weights: dict) -> SparseVec:
    # FlagEmbedding 1.4 returns {token_id(str): weight(np.float)}; verify key type per version.
    pairs = sorted((int(k), float(v)) for k, v in weights.items() if float(v) > 0)
    return SparseVec(indices=[k for k, _ in pairs], values=[v for _, v in pairs])


class Embedder:
    def __init__(self, model_name: str | None = None, max_length: int | None = None) -> None:
        self.model_name = model_name or settings.embed_model
        self.max_length = max_length or settings.embed_max_length
        self.sparse = "bge-m3" in self.model_name.lower()
        self._lock = threading.Lock()
        if self.sparse:
            from FlagEmbedding import BGEM3FlagModel

            self._model = BGEM3FlagModel(self.model_name, use_fp16=False, devices=["cpu"])
        else:
            from FlagEmbedding import FlagModel

            self._model = FlagModel(self.model_name, use_fp16=False, devices=["cpu"])

    @property
    def dim(self) -> int:
        return 1024 if self.sparse else 384

    def encode(self, texts: list[str], batch_size: int = 16) -> list[Embedded]:
        if not texts:
            return []
        with self._lock:
            if self.sparse:
                out = self._model.encode(
                    texts,
                    batch_size=batch_size,
                    max_length=self.max_length,
                    return_dense=True,
                    return_sparse=True,
                    return_colbert_vecs=False,
                )
                dense, sparse = out["dense_vecs"], out["lexical_weights"]
                return [Embedded(dense=list(map(float, d)), sparse=_to_sparse(s)) for d, s in zip(dense, sparse)]
            vectors = self._model.encode(texts, batch_size=batch_size, max_length=self.max_length)
            return [Embedded(dense=list(map(float, v)), sparse=None) for v in vectors]


@lru_cache(maxsize=1)
def get_embedder() -> Embedder:
    return Embedder()


@lru_cache(maxsize=1)
def get_tokenizer():
    """Tokenizer used for chunk sizing (spec 4: BGE-M3 tokenizer)."""
    from transformers import AutoTokenizer

    return AutoTokenizer.from_pretrained("BAAI/bge-m3")


def count_tokens(text: str) -> int:
    return len(get_tokenizer().encode(text, add_special_tokens=True))
