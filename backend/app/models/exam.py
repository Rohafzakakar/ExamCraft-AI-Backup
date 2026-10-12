import uuid
from datetime import datetime
from sqlalchemy import Column, String, Integer, Float, DateTime, ForeignKey, Text, JSON, Boolean
from sqlalchemy.orm import relationship
from backend.app.core.database import Base


class Exam(Base):
    __tablename__ = "exams"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    session_id = Column(String(64), nullable=True, index=True)
    document_id = Column(String(36), ForeignKey("documents.id", ondelete="SET NULL"), nullable=True, index=True)
    title = Column(String(255), nullable=False)
    subject = Column(String(150), nullable=False)
    institution = Column(String(255), nullable=True, default="University Department of Education")
    teacher_name = Column(String(150), nullable=True, default="Instructor")
    grade_level = Column(String(100), nullable=True, default="Undergraduate")
    exam_date = Column(String(50), nullable=True)
    duration_minutes = Column(Integer, default=60)
    total_marks = Column(Float, default=100.0)
    language = Column(String(16), default="en")
    is_rtl = Column(Boolean, default=False)
    bloom_enabled = Column(Boolean, default=False)
    status = Column(String(32), default="ready")
    difficulty_distribution = Column(JSON, nullable=True)
    question_types_config = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    groups = relationship("ExamGroup", back_populates="exam", cascade="all, delete-orphan", order_by="ExamGroup.group_order", lazy="selectin")


class ExamGroup(Base):
    __tablename__ = "exam_groups"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    exam_id = Column(String(36), ForeignKey("exams.id", ondelete="CASCADE"), nullable=False, index=True)
    group_name = Column(String(64), nullable=False)  # "Group A", "Group B", "Group C"
    group_order = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    exam = relationship("Exam", back_populates="groups")
    questions = relationship("ExamQuestion", back_populates="group", cascade="all, delete-orphan", order_by="ExamQuestion.question_order", lazy="selectin")


class ExamQuestion(Base):
    __tablename__ = "exam_questions"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    exam_id = Column(String(36), ForeignKey("exams.id", ondelete="CASCADE"), nullable=False, index=True)
    group_id = Column(String(36), ForeignKey("exam_groups.id", ondelete="CASCADE"), nullable=False, index=True)
    question_order = Column(Integer, nullable=False, default=1)
    question_type = Column(String(32), nullable=False)  # mcq, true_false, fill_blank, short_answer, essay
    question_text = Column(Text, nullable=False)
    options = Column(JSON, nullable=True)  # List of strings for MCQ choices
    correct_answer = Column(Text, nullable=False)
    explanation = Column(Text, nullable=True)
    marks = Column(Float, default=1.0)
    difficulty = Column(String(16), default="medium")  # easy, medium, hard
    bloom_level = Column(String(32), nullable=True)  # remember, understand, apply, analyze, evaluate, create

    # Mandatory source grounding provenance (Phase 2 constraint)
    source_document_name = Column(String(255), nullable=False)
    source_page = Column(Integer, default=1)
    source_chapter = Column(String(255), nullable=True)
    source_section = Column(String(255), nullable=True)
    source_chunk_id = Column(String(36), nullable=True)
    source_evidence = Column(Text, nullable=False)  # Mandatory verbatim citation from source

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    group = relationship("ExamGroup", back_populates="questions")


# Aliases for backward compatibility
Question = ExamQuestion
AnswerKey = ExamQuestion
