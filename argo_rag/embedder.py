"""Embedding backends behind one interface.

Both backends return (dense, sparse) per text so build_index.py and search.py
never need to know which model is active:

    emb = Embedder()
    dense, sparse = emb.embed_passages(["..."])   # index time
    dense, sparse = emb.embed_query("...")        # query time
"""

from __future__ import annotations

from qdrant_client import models

from .config import CFG, EMBED_MODEL


def _sparse(indices, values) -> models.SparseVector:
    return models.SparseVector(
        indices=[int(i) for i in indices],
        values=[float(v) for v in values],
    )


class Embedder:
    def __init__(self) -> None:
        self.backend = CFG["backend"]
        self.prefix = CFG["query_prefix"]
        if self.backend == "fastembed":
            from fastembed import SparseTextEmbedding, TextEmbedding

            print(f"loading {EMBED_MODEL} + {CFG['sparse_model']} (fastembed/ONNX)...")
            self._dense = TextEmbedding(model_name=EMBED_MODEL)
            self._sparse = SparseTextEmbedding(model_name=CFG["sparse_model"])
        else:
            from FlagEmbedding import BGEM3FlagModel

            print(f"loading {EMBED_MODEL} (FlagEmbedding)...")
            self._m3 = BGEM3FlagModel(EMBED_MODEL, use_fp16=True)

    def embed_passages(self, texts: list[str]):
        if self.backend == "fastembed":
            dense = [v.tolist() for v in self._dense.embed(
                texts, batch_size=CFG["batch_size"])]
            sparse = [_sparse(s.indices, s.values)
                      for s in self._sparse.embed(texts)]
            return dense, sparse
        out = self._m3.encode(
            texts, batch_size=CFG["batch_size"], max_length=CFG["max_length"],
            return_dense=True, return_sparse=True, return_colbert_vecs=False)
        dense = [[float(x) for x in v] for v in out["dense_vecs"]]
        sparse = [_sparse(w.keys(), w.values()) for w in out["lexical_weights"]]
        return dense, sparse

    def embed_query(self, query: str):
        if self.backend == "fastembed":
            dense = next(iter(self._dense.embed([self.prefix + query]))).tolist()
            s = next(iter(self._sparse.query_embed(query)))
            return dense, _sparse(s.indices, s.values)
        out = self._m3.encode(
            [query], max_length=CFG["max_length"],
            return_dense=True, return_sparse=True, return_colbert_vecs=False)
        dense = [float(x) for x in out["dense_vecs"][0]]
        w = out["lexical_weights"][0]
        return dense, _sparse(w.keys(), w.values())
