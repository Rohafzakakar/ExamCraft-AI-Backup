from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class DocumentChunkResponse(BaseModel):
    id: str
    document_id: str
    page_number: int
    chapter: Optional[str] = None
    section: Optional[str] = None
    content: str
    token_count: int
    chunk_index: int


class DocumentResponse(BaseModel):
    id: str
    filename: str
    file_type: str
    file_size_bytes: int
    detected_language: str
    is_rtl: bool
    total_pages: int
    status: str
    metadata: Dict[str, Any] = Field(default_factory=dict)
    chunks_count: int = 0
    error_message: Optional[str] = None
    created_at: Optional[str] = None


class DocumentSelectionRequest(BaseModel):
    document_id: str
    selected_pages: Optional[List[int]] = None
    selected_chapters: Optional[List[str]] = None
