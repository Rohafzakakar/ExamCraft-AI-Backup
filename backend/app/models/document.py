import uuid
import json
from datetime import datetime, timezone
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship
from backend.app.core.database import Base


class Document(Base):
    __tablename__ = "documents"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    session_id = Column(String(100), nullable=True, index=True)
    filename = Column(String(255), nullable=False)
    file_type = Column(String(20), nullable=False)  # 'pdf' or 'docx'
    file_size_bytes = Column(Integer, nullable=False)
    detected_language = Column(String(30), default="auto", nullable=False)
    is_rtl = Column(Boolean, default=False, nullable=False)
    total_pages = Column(Integer, nullable=False, default=1)
    doc_metadata = Column(Text, default="{}", nullable=False)  # JSON-encoded outlines/chapters
    status = Column(String(50), default="indexed", nullable=False)  # 'processing', 'indexed', 'error'
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)

    chunks = relationship("DocumentChunk", back_populates="document", cascade="all, delete-orphan", lazy="selectin")

    def to_dict(self):
        metadata_dict = {}
        try:
            metadata_dict = json.loads(self.doc_metadata) if self.doc_metadata else {}
        except Exception:
            pass

        return {
            "id": self.id,
            "user_id": self.user_id,
            "session_id": self.session_id,
            "filename": self.filename,
            "file_type": self.file_type,
            "file_size_bytes": self.file_size_bytes,
            "detected_language": self.detected_language,
            "is_rtl": self.is_rtl,
            "total_pages": self.total_pages,
            "metadata": metadata_dict,
            "status": self.status,
            "error_message": self.error_message,
            "chunks_count": len(self.chunks) if self.chunks else 0,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class DocumentChunk(Base):
    __tablename__ = "document_chunks"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    document_id = Column(String(36), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True)
    page_number = Column(Integer, nullable=False, index=True)
    chapter = Column(String(255), nullable=True)
    section = Column(String(255), nullable=True)
    content = Column(Text, nullable=False)
    token_count = Column(Integer, nullable=False, default=0)
    chunk_index = Column(Integer, nullable=False, default=0)
    embedding_json = Column(Text, nullable=True)  # Store vector embedding representation
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)

    document = relationship("Document", back_populates="chunks")

    def to_dict(self):
        return {
            "id": self.id,
            "document_id": self.document_id,
            "page_number": self.page_number,
            "chapter": self.chapter,
            "section": self.section,
            "content": self.content,
            "token_count": self.token_count,
            "chunk_index": self.chunk_index,
            "has_embedding": bool(self.embedding_json),
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
