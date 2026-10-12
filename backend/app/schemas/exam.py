from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field, model_validator
from backend.app.schemas.question import QuestionResponse


class DifficultyDistribution(BaseModel):
    easy: int = Field(default=40, ge=0, le=100)
    medium: int = Field(default=40, ge=0, le=100)
    hard: int = Field(default=20, ge=0, le=100)

    @model_validator(mode="after")
    def validate_sum(self):
        total = self.easy + self.medium + self.hard
        if total != 100:
            raise ValueError(f"Difficulty percentages must sum to 100%, got {total}%")
        return self


class QuestionTypesDistribution(BaseModel):
    mcq: int = Field(default=5, ge=0)
    true_false: int = Field(default=5, ge=0)
    fill_blank: int = Field(default=0, ge=0)
    short_answer: int = Field(default=2, ge=0)
    essay: int = Field(default=0, ge=0)

    @model_validator(mode="before")
    @classmethod
    def handle_omitted_types(cls, data: Any):
        if isinstance(data, dict):
            # If caller explicitly provided question types (e.g. {"mcq": 30, "true_false": 20}),
            # any omitted type defaults to 0 rather than injecting unwanted question types.
            if any(k in data for k in ["mcq", "true_false", "fill_blank", "short_answer", "essay", "multiple_choice"]):
                return {
                    "mcq": data.get("mcq", data.get("multiple_choice", 0)),
                    "true_false": data.get("true_false", 0),
                    "fill_blank": data.get("fill_blank", 0),
                    "short_answer": data.get("short_answer", 0),
                    "essay": data.get("essay", 0),
                }
        return data

    @model_validator(mode="after")
    def validate_positive_total(self):
        total = self.mcq + self.true_false + self.fill_blank + self.short_answer + self.essay
        if total <= 0:
            raise ValueError("Exam must request at least one question")
        return self


class ExamCreate(BaseModel):
    document_id: str
    selected_pages: Optional[List[int]] = None
    title: str = Field(..., min_length=2, max_length=255)
    subject: str = Field(..., min_length=2, max_length=150)
    institution: Optional[str] = "University Department of Education"
    teacher_name: Optional[str] = "Instructor"
    grade_level: Optional[str] = "Undergraduate"
    exam_date: Optional[str] = None
    duration_minutes: int = Field(default=60, ge=10, le=360)
    total_marks: float = Field(default=100.0, ge=1.0)
    language: str = "auto"
    is_rtl: bool = False
    bloom_enabled: bool = False
    groups_count: int = Field(default=3, ge=1, le=10, description="Number of examination groups (1 to 10, e.g. Group A to Group J)")
    difficulty_distribution: DifficultyDistribution = Field(default_factory=DifficultyDistribution)
    question_types_config: QuestionTypesDistribution = Field(default_factory=QuestionTypesDistribution)


class ExamUpdate(BaseModel):
    title: Optional[str] = None
    subject: Optional[str] = None
    institution: Optional[str] = None
    teacher_name: Optional[str] = None
    grade_level: Optional[str] = None
    exam_date: Optional[str] = None
    duration_minutes: Optional[int] = None
    total_marks: Optional[float] = None
    status: Optional[str] = None


class ExamGroupResponse(BaseModel):
    id: str
    exam_id: str
    group_name: str
    group_order: int
    questions_count: int = 0
    questions: Optional[List[QuestionResponse]] = None


class ExamResponse(BaseModel):
    id: str
    user_id: Optional[str] = None
    session_id: Optional[str] = None
    title: str
    subject: str
    institution: Optional[str] = None
    teacher_name: Optional[str] = None
    grade_level: Optional[str] = None
    exam_date: Optional[str] = None
    duration_minutes: int
    total_marks: float
    language: str
    is_rtl: bool
    bloom_enabled: bool
    difficulty_distribution: Dict[str, int]
    question_types_config: Dict[str, int]
    status: str
    groups_count: int
    questions_count: int
    groups: List[ExamGroupResponse] = Field(default_factory=list)
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class AnswerKeyItem(BaseModel):
    question_number: int
    question_type: str
    correct_answer: str
    explanation: Optional[str] = None
    marks: float
    source_reference: str
    source_page: int


class AnswerKeyResponse(BaseModel):
    id: str
    exam_id: str
    group_id: str
    group_name: str
    items: List[AnswerKeyItem]
    updated_at: Optional[str] = None
