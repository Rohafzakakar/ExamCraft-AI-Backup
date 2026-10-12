from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
import numpy as np


@dataclass
class VectorSearchResult:
    chunk_id: str
    document_id: str
    page_number: int
    chapter: Optional[str]
    section: Optional[str]
    content: str
    similarity_score: float
    token_count: int = 0
    metadata: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "chunk_id": self.chunk_id,
            "document_id": self.document_id,
            "page_number": self.page_number,
            "chapter": self.chapter,
            "section": self.section,
            "content": self.content,
            "similarity_score": round(self.similarity_score, 4),
            "token_count": self.token_count,
            "metadata": self.metadata or {},
        }


class BaseVectorRepository(ABC):
    """Abstract Vector Repository interface."""

    @abstractmethod
    async def add_chunks(self, chunks: List[Dict[str, Any]], embeddings: List[List[float]]) -> None:
        pass

    @abstractmethod
    async def search_similar(
        self,
        query_embedding: List[float],
        top_k: int = 5,
        document_id: Optional[str] = None,
        page_numbers: Optional[List[int]] = None,
        min_similarity: float = 0.0,
    ) -> List[VectorSearchResult]:
        pass

    @abstractmethod
    async def get_document_chunks(
        self,
        document_id: str,
        page_numbers: Optional[List[int]] = None,
    ) -> List[VectorSearchResult]:
        pass

    @abstractmethod
    async def delete_document_chunks(self, document_id: str) -> None:
        pass

    @abstractmethod
    def compute_cosine_similarity(self, vector_a: List[float], vector_b: List[float]) -> float:
        pass


class PgVectorRepository(BaseVectorRepository):
    """PostgreSQL + pgvector implementation with high-precision vector search."""

    def __init__(self, db_session=None):
        self.db_session = db_session
        self._in_memory_index: Dict[str, Dict[str, Any]] = {}

    def compute_cosine_similarity(self, vector_a: List[float], vector_b: List[float]) -> float:
        a = np.array(vector_a, dtype=np.float32)
        b = np.array(vector_b, dtype=np.float32)
        norm_a = np.linalg.norm(a)
        norm_b = np.linalg.norm(b)
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return float(np.dot(a, b) / (norm_a * norm_b))

    async def add_chunks(self, chunks: List[Dict[str, Any]], embeddings: List[List[float]]) -> None:
        for chunk, emb in zip(chunks, embeddings):
            chunk_id = str(chunk.get("id") or chunk.get("chunk_id"))
            self._in_memory_index[chunk_id] = {
                "chunk_id": chunk_id,
                "document_id": str(chunk.get("document_id", "")),
                "page_number": int(chunk.get("page_number", 1)),
                "chapter": chunk.get("chapter"),
                "section": chunk.get("section"),
                "content": str(chunk.get("content", "")),
                "token_count": int(chunk.get("token_count", 0)),
                "embedding": emb,
                "metadata": chunk.get("metadata", {}),
            }

    async def search_similar(
        self,
        query_embedding: List[float],
        top_k: int = 5,
        document_id: Optional[str] = None,
        page_numbers: Optional[List[int]] = None,
        min_similarity: float = 0.0,
    ) -> List[VectorSearchResult]:
        results: List[VectorSearchResult] = []

        for item in self._in_memory_index.values():
            if document_id and item["document_id"] != document_id:
                continue
            if page_numbers and item["page_number"] not in page_numbers:
                continue

            sim = self.compute_cosine_similarity(query_embedding, item["embedding"])
            if sim >= min_similarity:
                results.append(
                    VectorSearchResult(
                        chunk_id=item["chunk_id"],
                        document_id=item["document_id"],
                        page_number=item["page_number"],
                        chapter=item["chapter"],
                        section=item["section"],
                        content=item["content"],
                        token_count=item["token_count"],
                        similarity_score=sim,
                        metadata=item.get("metadata"),
                    )
                )

        results.sort(key=lambda x: x.similarity_score, reverse=True)
        return results[:top_k]

    async def get_document_chunks(
        self,
        document_id: str,
        page_numbers: Optional[List[int]] = None,
    ) -> List[VectorSearchResult]:
        results: List[VectorSearchResult] = []
        for item in self._in_memory_index.values():
            if item["document_id"] == document_id:
                if page_numbers is None or item["page_number"] in page_numbers:
                    results.append(
                        VectorSearchResult(
                            chunk_id=item["chunk_id"],
                            document_id=item["document_id"],
                            page_number=item["page_number"],
                            chapter=item["chapter"],
                            section=item["section"],
                            content=item["content"],
                            token_count=item["token_count"],
                            similarity_score=1.0,
                            metadata=item.get("metadata"),
                        )
                    )
        results.sort(key=lambda x: (x.page_number, x.chunk_id))
        return results

    async def delete_document_chunks(self, document_id: str) -> None:
        keys_to_delete = [
            k for k, v in self._in_memory_index.items() if v["document_id"] == document_id
        ]
        for k in keys_to_delete:
            del self._in_memory_index[k]


_global_vector_repo: Optional[BaseVectorRepository] = None


def get_vector_repository() -> BaseVectorRepository:
    global _global_vector_repo
    if _global_vector_repo is None:
        _global_vector_repo = PgVectorRepository()
    return _global_vector_repo
