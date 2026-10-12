from typing import List, Literal, Optional
from pydantic import BaseModel, Field

QuestionType = Literal["mcq", "true_false", "fill_blank", "short_answer", "essay"]
DifficultyLevel = Literal["easy", "medium", "hard"]
BloomLevel = Literal["remember", "understand", "apply", "analyze", "evaluate", "create"]


class QuestionBase(BaseModel):
    question_type: QuestionType
    question_text: str = Field(default="Question text", min_length=1)
    options: Optional[List[str]] = Field(default=None, description="Required for MCQ")
    correct_answer: str = Field(default="Refer to source reference text.", min_length=1)
    explanation: Optional[str] = None
    marks: float = Field(default=1.0, ge=0.5, le=100.0)
    difficulty: DifficultyLevel = "medium"
    bloom_level: Optional[BloomLevel] = None
    source_document_name: str = Field(default="Reference Document")
    source_page: int = Field(default=1, ge=1)
    source_chapter: Optional[str] = None
    source_section: Optional[str] = None
    source_chunk_id: Optional[str] = None
    source_evidence: str = Field(default="Excerpt from source text", min_length=1, description="Mandatory excerpt from source text")


class QuestionCreate(QuestionBase):
    exam_id: str
    group_id: str
    question_order: int = 1


class QuestionUpdate(BaseModel):
    question_text: Optional[str] = None
    options: Optional[List[str]] = None
    correct_answer: Optional[str] = None
    explanation: Optional[str] = None
    marks: Optional[float] = None
    difficulty: Optional[DifficultyLevel] = None
    bloom_level: Optional[BloomLevel] = None
    question_order: Optional[int] = None


class QuestionRegenerateRequest(BaseModel):
    instructions: Optional[str] = Field(default=None, description="Optional teacher prompt/guideline for replacement")


class QuestionReorderRequest(BaseModel):
    question_ids: List[str] = Field(description="Complete ordered list of question IDs for the group")


class QuestionDeleteResponse(BaseModel):
    deleted_question_id: str
    synchronized_groups_count: int
    deleted_count: int
    remaining_questions_per_group: int
    new_total_marks: float
    message: str


class QuestionResponse(QuestionBase):
    id: str
    exam_id: str
    group_id: str
    question_order: int
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
