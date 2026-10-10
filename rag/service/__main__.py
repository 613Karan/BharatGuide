"""Run the RAG service: python -m rag.service"""
import os

# PyTorch only: stop transformers from importing TensorFlow/Keras 3 (load error otherwise).
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("TRANSFORMERS_NO_TF", "1")

import uvicorn  # noqa: E402

from ..config import settings

if __name__ == "__main__":
    uvicorn.run("rag.service.app:app", host="127.0.0.1", port=settings.port, log_level="info")
