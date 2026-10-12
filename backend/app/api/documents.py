import json
import uuid
from typing import List, Optional
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from backend.app.api.auth import get_current_user_optional
from backend.app.core.config import settings
from backend.app.core.database import get_db
from backend.app.models.document import Document, DocumentChunk
from backend.app.models.user import User
from backend.app.schemas.document import DocumentChunkResponse, DocumentResponse
from backend.app.services.chunker import DocumentChunker
from backend.app.services.embedding import get_embedding_service
from backend.app.services.parser import (
    CorruptedFileError,
    DocumentParser,
    FileTooLargeError,
    UnreadableDocumentError,
    UnsupportedFileTypeError,
)
from backend.app.services.vector_store import get_vector_repository

router = APIRouter(prefix="/documents", tags=["Documents & RAG"])


@router.post("/upload", response_model=DocumentResponse, status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...),
    session_id: Optional[str] = Form(None),
    current_user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Uploads, validates, parses, chunks, and vector-indexes an educational PDF or DOCX document."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="Uploaded file has no filename.")

    content_bytes = await file.read()
    if len(content_bytes) > settings.UPLOAD_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"The uploaded file exceeds the maximum size limit of {settings.UPLOAD_MAX_BYTES // (1024 * 1024)}MB.",
        )

    try:
        parsed_doc = DocumentParser.parse_file(content_bytes, file.filename)
    except UnsupportedFileTypeError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except FileTooLargeError as e:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(e))
    except CorruptedFileError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except UnreadableDocumentError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to process document: {str(e)}",
        )

    doc_id = str(uuid.uuid4())
    user_id = current_user.id if current_user else None
    guest_session = session_id if not user_id else None

    chunker = DocumentChunker()
    raw_chunks = chunker.chunk_document(document_id=doc_id, parsed_doc=parsed_doc)

    embedding_service = get_embedding_service()
    chunk_texts = [c["content"] for c in raw_chunks]
    embeddings = embedding_service.embed_batch(chunk_texts)

    vector_repo = get_vector_repository()
    await vector_repo.add_chunks(raw_chunks, embeddings)

    meta_dict = {
        "chapters": parsed_doc.chapters,
        "total_characters": parsed_doc.total_characters,
        "pages_info": [
            {"page_number": p.page_number, "chapter": p.chapter, "char_count": p.char_count}
            for p in parsed_doc.pages
        ],
    }

    doc_record = Document(
        id=doc_id,
        user_id=user_id,
        session_id=guest_session,
        filename=file.filename,
        file_type=parsed_doc.file_type,
        file_size_bytes=parsed_doc.file_size_bytes,
        detected_language=parsed_doc.detected_language,
        is_rtl=parsed_doc.is_rtl,
        total_pages=parsed_doc.total_pages,
        doc_metadata=json.dumps(meta_dict),
        status="indexed",
    )
    db.add(doc_record)

    for chunk_data, emb in zip(raw_chunks, embeddings):
        chunk_record = DocumentChunk(
            id=chunk_data["id"],
            document_id=doc_id,
            page_number=chunk_data["page_number"],
            chapter=chunk_data["chapter"],
            section=chunk_data["section"],
            content=chunk_data["content"],
            token_count=chunk_data["token_count"],
            chunk_index=chunk_data["chunk_index"],
            embedding_json=json.dumps(emb),
        )
        db.add(chunk_record)

    await db.commit()
    await db.refresh(doc_record)

    return DocumentResponse(
        id=doc_record.id,
        filename=doc_record.filename,
        file_type=doc_record.file_type,
        file_size_bytes=doc_record.file_size_bytes,
        detected_language=doc_record.detected_language,
        is_rtl=doc_record.is_rtl,
        total_pages=doc_record.total_pages,
        status=doc_record.status,
        metadata=meta_dict,
        chunks_count=len(raw_chunks),
        created_at=doc_record.created_at.isoformat() if doc_record.created_at else None,
    )


@router.get("", response_model=List[DocumentResponse])
async def list_documents(
    session_id: Optional[str] = Query(None),
    current_user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    query = select(Document)
    if current_user:
        query = query.where(Document.user_id == current_user.id)
    elif session_id:
        query = query.where(Document.session_id == session_id)
    else:
        return []

    result = await db.execute(query.order_by(Document.created_at.desc()))
    docs = result.scalars().all()

    responses = []
    for d in docs:
        meta_dict = {}
        try:
            meta_dict = json.loads(d.doc_metadata) if d.doc_metadata else {}
        except Exception:
            pass
        responses.append(
            DocumentResponse(
                id=d.id,
                filename=d.filename,
                file_type=d.file_type,
                file_size_bytes=d.file_size_bytes,
                detected_language=d.detected_language,
                is_rtl=d.is_rtl,
                total_pages=d.total_pages,
                status=d.status,
                metadata=meta_dict,
                chunks_count=len(d.chunks) if d.chunks else 0,
                error_message=d.error_message,
                created_at=d.created_at.isoformat() if d.created_at else None,
            )
        )
    return responses


@router.get("/{document_id}", response_model=DocumentResponse)
async def get_document(
    document_id: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found.")

    meta_dict = {}
    try:
        meta_dict = json.loads(doc.doc_metadata) if doc.doc_metadata else {}
    except Exception:
        pass

    return DocumentResponse(
        id=doc.id,
        filename=doc.filename,
        file_type=doc.file_type,
        file_size_bytes=doc.file_size_bytes,
        detected_language=doc.detected_language,
        is_rtl=doc.is_rtl,
        total_pages=doc.total_pages,
        status=doc.status,
        metadata=meta_dict,
        chunks_count=len(doc.chunks) if doc.chunks else 0,
        error_message=doc.error_message,
        created_at=doc.created_at.isoformat() if doc.created_at else None,
    )


@router.get("/{document_id}/chunks", response_model=List[DocumentChunkResponse])
async def get_document_chunks(
    document_id: str,
    pages: Optional[str] = Query(None, description="Comma-separated page numbers, e.g. '1,2,3'"),
    db: AsyncSession = Depends(get_db),
):
    query = select(DocumentChunk).where(DocumentChunk.document_id == document_id)

    if pages:
        try:
            page_list = [int(p.strip()) for p in pages.split(",") if p.strip()]
            if page_list:
                query = query.where(DocumentChunk.page_number.in_(page_list))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid page numbers format. Use comma-separated integers.")

    result = await db.execute(query.order_by(DocumentChunk.chunk_index.asc()))
    chunks = result.scalars().all()

    return [
        DocumentChunkResponse(
            id=c.id,
            document_id=c.document_id,
            page_number=c.page_number,
            chapter=c.chapter,
            section=c.section,
            content=c.content,
            token_count=c.token_count,
            chunk_index=c.chunk_index,
        )
        for c in chunks
    ]


@router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(
    document_id: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found.")

    vector_repo = get_vector_repository()
    await vector_repo.delete_document_chunks(document_id)

    await db.delete(doc)
    await db.commit()
    return None
