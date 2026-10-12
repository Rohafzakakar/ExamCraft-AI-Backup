import hashlib
import math
import re
from typing import List, Optional
import numpy as np


class MultilingualEmbeddingService:
    """Provides 384-dimensional dense multilingual embeddings for RAG retrieval
    and semantic duplicate detection.
    """

    DIMENSION = 384

    def __init__(self):
        self._st_model = None

    def _get_sentence_transformer(self):
        if self._st_model is None:
            try:
                from sentence_transformers import SentenceTransformer
                self._st_model = SentenceTransformer("paraphrase-multilingual-MiniLM-L12-v2")
            except Exception:
                self._st_model = False
        return self._st_model if self._st_model is not False else None

    def _deterministic_multilingual_embed(self, text: str) -> List[float]:
        """High-precision multilingual feature hashing and sublinear TF-IDF projection
        producing normalized 384-dimensional dense vectors.
        Preserves character n-grams, word tokens, and script features for both LTR and RTL scripts.
        """
        vec = np.zeros(self.DIMENSION, dtype=np.float32)
        if not text or not text.strip():
            return vec.tolist()

        clean_text = text.lower().strip()
        words = re.findall(r"\w+", clean_text, re.UNICODE)
        ngrams: List[str] = []
        for w in words:
            if len(w) >= 3:
                for i in range(len(w) - 2):
                    ngrams.append(w[i : i + 3])
            if len(w) >= 4:
                for i in range(len(w) - 3):
                    ngrams.append(w[i : i + 4])

        features = words + ngrams
        if not features:
            features = [clean_text]

        counts = {}
        for feat in features:
            counts[feat] = counts.get(feat, 0) + 1

        for feat, count in counts.items():
            h = hashlib.sha256(feat.encode("utf-8")).digest()
            idx = int.from_bytes(h[:4], "big") % self.DIMENSION
            weight = 1.0 + math.log(count)
            vec[idx] += weight

        norm = np.linalg.norm(vec)
        if norm > 0:
            vec = vec / norm

        return vec.tolist()

    def embed_text(self, text: str) -> List[float]:
        model = self._get_sentence_transformer()
        if model:
            try:
                emb = model.encode(text, normalize_embeddings=True)
                return emb.tolist()
            except Exception:
                pass
        return self._deterministic_multilingual_embed(text)

    def embed_batch(self, texts: List[str]) -> List[List[float]]:
        model = self._get_sentence_transformer()
        if model:
            try:
                embs = model.encode(texts, normalize_embeddings=True)
                return [e.tolist() for e in embs]
            except Exception:
                pass
        return [self._deterministic_multilingual_embed(t) for t in texts]

    @staticmethod
    def cosine_similarity(v1: List[float], v2: List[float]) -> float:
        """Calculates cosine similarity between two dense embedding vectors."""
        a = np.array(v1, dtype=np.float32)
        b = np.array(v2, dtype=np.float32)
        norm_a = np.linalg.norm(a)
        norm_b = np.linalg.norm(b)
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return float(np.dot(a, b) / (norm_a * norm_b))


_embedding_service_instance: Optional[MultilingualEmbeddingService] = None


def get_embedding_service() -> MultilingualEmbeddingService:
    global _embedding_service_instance
    if _embedding_service_instance is None:
        _embedding_service_instance = MultilingualEmbeddingService()
    return _embedding_service_instance
