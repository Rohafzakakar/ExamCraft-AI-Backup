from typing import Literal, Optional
from pydantic import BaseModel, Field

ExportFormat = Literal["docx", "pdf"]
ExportTarget = Literal["exam", "answer_key", "both"]


class ExportRequest(BaseModel):
    exam_id: str
    group_id: Optional[str] = Field(default=None, description="Group ID or null to export all groups")
    target: ExportTarget = "both"
    format: ExportFormat = "pdf"
    include_student_header: bool = True
    include_source_references: bool = True


class ExportResponse(BaseModel):
    file_url: str
    filename: str
    format: ExportFormat
    size_bytes: int
