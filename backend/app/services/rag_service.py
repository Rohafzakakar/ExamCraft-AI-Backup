from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from backend.app.services.embedding import get_embedding_service
from backend.app.services.vector_store import VectorSearchResult, get_vector_repository


@dataclass
class GroundedContextChunk:
    chunk_id: str
    document_name: str
    page_number: int
    chapter: Optional[str]
    section: Optional[str]
    content: str
    relevance_score: float

    def format_citation(self) -> str:
        loc = f"Page {self.page_number}"
        if self.chapter:
            loc += f", {self.chapter}"
        if self.section:
            loc += f" ({self.section})"
        return f"[{self.document_name} - {loc}]"


class RAGRetrievalService:
    """Manages semantic search and context assembly strictly constrained
    to teacher-approved educational content.
    """

    def __init__(self):
        self.embedding_service = get_embedding_service()
        self.vector_repo = get_vector_repository()

    async def retrieve_approved_context(
        self,
        query: str,
        document_id: str,
        document_name: str,
        approved_pages: Optional[List[int]] = None,
        top_k: int = 5,
        min_relevance: float = 0.0,
    ) -> List[GroundedContextChunk]:
        """Retrieves top-k chunks strictly constrained to teacher-approved pages of the document."""
        query_embedding = self.embedding_service.embed_text(query)

        raw_results = await self.vector_repo.search_similar(
            query_embedding=query_embedding,
            top_k=top_k,
            document_id=document_id,
            page_numbers=approved_pages,
            min_similarity=min_relevance,
        )

        grounded_chunks: List[GroundedContextChunk] = []
        for r in raw_results:
            grounded_chunks.append(
                GroundedContextChunk(
                    chunk_id=r.chunk_id,
                    document_name=document_name,
                    page_number=r.page_number,
                    chapter=r.chapter,
                    section=r.section,
                    content=r.content,
                    relevance_score=r.similarity_score,
                )
            )

        return grounded_chunks

    @staticmethod
    def assemble_prompt_context(chunks: List[GroundedContextChunk]) -> str:
        """Assembles structured prompt context blocks with explicit page and chapter markers."""
        if not chunks:
            return "No relevant source content found for the approved pages."

        blocks = []
        for idx, chunk in enumerate(chunks, 1):
            citation = chunk.format_citation()
            block = (
                f"--- SOURCE EXCERPT #{idx} {citation} ---\n"
                f"Page: {chunk.page_number}\n"
                f"Chapter: {chunk.chapter or 'General'}\n"
                f"Text:\n{chunk.content}\n"
            )
            blocks.append(block)

        return "\n\n".join(blocks)


_rag_service: Optional[RAGRetrievalService] = None


def get_rag_service() -> RAGRetrievalService:
    global _rag_service
    if _rag_service is None:
        _rag_service = RAGRetrievalService()
    return _rag_service
