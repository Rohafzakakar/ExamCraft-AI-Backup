import re
import uuid
from typing import Any, Dict, List, Optional
from backend.app.core.config import settings
from backend.app.services.parser import DocumentPage, ParsedDocument


class DocumentChunker:
    """Splits parsed educational documents into metadata-preserving semantic chunks for RAG."""

    def __init__(
        self,
        target_tokens: Optional[int] = None,
        overlap_tokens: Optional[int] = None,
    ):
        self.target_tokens = target_tokens or settings.CHUNK_SIZE_TOKENS
        self.overlap_tokens = overlap_tokens or settings.CHUNK_OVERLAP_TOKENS

    @staticmethod
    def count_tokens(text: str) -> int:
        return len(re.findall(r"\w+|[^\w\s]", text, re.UNICODE))

    def split_sentences(self, text: str) -> List[str]:
        pattern = r"(?<=[.!?؟\n])\s+"
        parts = re.split(pattern, text)
        return [p.strip() for p in parts if p.strip()]

    def chunk_document(
        self,
        document_id: str,
        parsed_doc: ParsedDocument,
        selected_pages: Optional[List[int]] = None,
    ) -> List[Dict[str, Any]]:
        chunks: List[Dict[str, Any]] = []
        global_chunk_index = 0

        target_pages: List[DocumentPage] = []
        for page in parsed_doc.pages:
            if selected_pages is None or page.page_number in selected_pages:
                if page.text and len(page.text.strip()) > 0:
                    target_pages.append(page)

        for page in target_pages:
            page_text = page.text.strip()
            total_tokens = self.count_tokens(page_text)

            if total_tokens <= self.target_tokens + (self.overlap_tokens // 2):
                chunk_id = str(uuid.uuid4())
                chunks.append(
                    {
                        "id": chunk_id,
                        "document_id": document_id,
                        "page_number": page.page_number,
                        "chapter": page.chapter or "General Content",
                        "section": page.section,
                        "content": page_text,
                        "token_count": total_tokens,
                        "chunk_index": global_chunk_index,
                        "metadata": {
                            "filename": parsed_doc.filename,
                            "language": parsed_doc.detected_language,
                            "is_rtl": parsed_doc.is_rtl,
                        },
                    }
                )
                global_chunk_index += 1
            else:
                sentences = self.split_sentences(page_text)
                current_chunk_sentences: List[str] = []
                current_tokens = 0

                for sent in sentences:
                    sent_tokens = self.count_tokens(sent)
                    if current_tokens + sent_tokens > self.target_tokens and current_chunk_sentences:
                        chunk_text = " ".join(current_chunk_sentences)
                        chunk_id = str(uuid.uuid4())
                        chunks.append(
                            {
                                "id": chunk_id,
                                "document_id": document_id,
                                "page_number": page.page_number,
                                "chapter": page.chapter or "General Content",
                                "section": page.section,
                                "content": chunk_text,
                                "token_count": current_tokens,
                                "chunk_index": global_chunk_index,
                                "metadata": {
                                    "filename": parsed_doc.filename,
                                    "language": parsed_doc.detected_language,
                                    "is_rtl": parsed_doc.is_rtl,
                                },
                            }
                        )
                        global_chunk_index += 1

                        overlap_sentences: List[str] = []
                        overlap_count = 0
                        for s in reversed(current_chunk_sentences):
                            s_cnt = self.count_tokens(s)
                            if overlap_count + s_cnt <= self.overlap_tokens:
                                overlap_sentences.insert(0, s)
                                overlap_count += s_cnt
                            else:
                                break

                        current_chunk_sentences = overlap_sentences + [sent]
                        current_tokens = overlap_count + sent_tokens
                    else:
                        current_chunk_sentences.append(sent)
                        current_tokens += sent_tokens

                if current_chunk_sentences:
                    chunk_text = " ".join(current_chunk_sentences)
                    chunk_id = str(uuid.uuid4())
                    chunks.append(
                        {
                            "id": chunk_id,
                            "document_id": document_id,
                            "page_number": page.page_number,
                            "chapter": page.chapter or "General Content",
                            "section": page.section,
                            "content": chunk_text,
                            "token_count": current_tokens,
                            "chunk_index": global_chunk_index,
                            "metadata": {
                                "filename": parsed_doc.filename,
                                "language": parsed_doc.detected_language,
                                "is_rtl": parsed_doc.is_rtl,
                            },
                        }
                    )
                    global_chunk_index += 1

        return chunks
