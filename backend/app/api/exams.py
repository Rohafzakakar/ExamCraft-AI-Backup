from typing import List, Optional, Literal
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from sqlalchemy.orm import selectinload

from backend.app.core.database import get_db
from backend.app.models.exam import Exam, ExamGroup, ExamQuestion
from backend.app.models.user import User
from backend.app.schemas.exam import (
    ExamCreate,
    ExamResponse,
    ExamGroupResponse,
    AnswerKeyResponse,
    AnswerKeyItem,
)
from backend.app.schemas.question import (
    QuestionResponse,
    QuestionUpdate,
    QuestionRegenerateRequest,
    QuestionReorderRequest,
    QuestionDeleteResponse,
)
from backend.app.services.question_generator import get_exam_generation_service
from backend.app.services.export_service import get_export_service, sanitize_export_filename
from backend.app.api.auth import get_current_user_optional

router = APIRouter(prefix="/exams", tags=["Examinations & Questions"])


def _format_exam_response(exam: Exam) -> ExamResponse:
    group_responses = []
    total_q_count = 0

    if exam.groups:
        for g in sorted(exam.groups, key=lambda x: x.group_order):
            q_responses = []
            if g.questions:
                for q in sorted(g.questions, key=lambda x: x.question_order):
                    q_responses.append(
                        QuestionResponse(
                            id=q.id,
                            exam_id=q.exam_id,
                            group_id=q.group_id,
                            question_order=q.question_order,
                            question_type=q.question_type,
                            question_text=q.question_text,
                            options=q.options,
                            correct_answer=q.correct_answer,
                            explanation=q.explanation,
                            marks=q.marks,
                            difficulty=q.difficulty,
                            bloom_level=q.bloom_level,
                            source_document_name=q.source_document_name,
                            source_page=q.source_page,
                            source_chapter=q.source_chapter,
                            source_section=q.source_section,
                            source_chunk_id=q.source_chunk_id,
                            source_evidence=q.source_evidence,
                            created_at=q.created_at.isoformat() if q.created_at else None,
                            updated_at=q.updated_at.isoformat() if q.updated_at else None,
                        )
                    )
            total_q_count += len(q_responses)
            group_responses.append(
                ExamGroupResponse(
                    id=g.id,
                    exam_id=g.exam_id,
                    group_name=g.group_name,
                    group_order=g.group_order,
                    questions_count=len(q_responses),
                    questions=q_responses,
                )
            )

    return ExamResponse(
        id=exam.id,
        user_id=exam.user_id,
        session_id=exam.session_id,
        title=exam.title,
        subject=exam.subject,
        institution=exam.institution,
        teacher_name=exam.teacher_name,
        grade_level=exam.grade_level,
        exam_date=exam.exam_date,
        duration_minutes=exam.duration_minutes,
        total_marks=exam.total_marks,
        language=exam.language,
        is_rtl=exam.is_rtl,
        bloom_enabled=exam.bloom_enabled,
        difficulty_distribution=exam.difficulty_distribution or {},
        question_types_config=exam.question_types_config or {},
        status=exam.status,
        groups_count=len(group_responses),
        questions_count=total_q_count,
        groups=group_responses,
        created_at=exam.created_at.isoformat() if exam.created_at else None,
        updated_at=exam.updated_at.isoformat() if exam.updated_at else None,
    )


@router.post("/generate", response_model=ExamResponse, status_code=status.HTTP_201_CREATED)
async def generate_exam(
    req: ExamCreate,
    session_id: Optional[str] = Query(None),
    current_user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Generates a complete source-grounded exam with multiple isomorphic anti-cheating groups."""
    user_id = current_user.id if current_user else None
    sess_id = session_id or (user_id if not user_id else None) or "guest_session"

    generator = get_exam_generation_service()
    exam = await generator.generate_exam(
        db=db,
        req=req,
        user_id=user_id,
        session_id=sess_id,
    )

    return _format_exam_response(exam)


@router.get("", response_model=List[ExamResponse])
async def list_exams(
    session_id: Optional[str] = Query(None),
    current_user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Lists exams generated by the user or current guest session."""
    user_id = current_user.id if current_user else None

    stmt = select(Exam).options(selectinload(Exam.groups).selectinload(ExamGroup.questions))

    if user_id:
        stmt = stmt.where(Exam.user_id == user_id)
    elif session_id:
        stmt = stmt.where(Exam.session_id == session_id)

    stmt = stmt.order_by(Exam.created_at.desc())
    result = await db.execute(stmt)
    exams = result.scalars().all()

    return [_format_exam_response(e) for e in exams]


@router.get("/{exam_id}", response_model=ExamResponse)
async def get_exam(exam_id: str, db: AsyncSession = Depends(get_db)):
    """Retrieves full exam details with all groups, questions, and citations."""
    stmt = (
        select(Exam)
        .where(Exam.id == exam_id)
        .options(selectinload(Exam.groups).selectinload(ExamGroup.questions))
    )
    result = await db.execute(stmt)
    exam = result.scalar_one_or_none()
    if not exam:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam not found")

    return _format_exam_response(exam)


@router.get("/{exam_id}/answer-key", response_model=List[AnswerKeyResponse])
async def get_exam_answer_keys(exam_id: str, db: AsyncSession = Depends(get_db)):
    """Returns official answer keys, scoring rubrics, and source evidence for each group."""
    stmt = (
        select(Exam)
        .where(Exam.id == exam_id)
        .options(selectinload(Exam.groups).selectinload(ExamGroup.questions))
    )
    result = await db.execute(stmt)
    exam = result.scalar_one_or_none()
    if not exam:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam not found")

    keys = []
    for g in sorted(exam.groups, key=lambda x: x.group_order):
        items = []
        for q in sorted(g.questions, key=lambda x: x.question_order):
            items.append(
                AnswerKeyItem(
                    question_number=q.question_order,
                    question_type=q.question_type,
                    correct_answer=q.correct_answer,
                    explanation=q.explanation,
                    marks=q.marks,
                    source_reference=f"{q.source_document_name} ({q.source_chapter or 'General'})",
                    source_page=q.source_page,
                )
            )
        keys.append(
            AnswerKeyResponse(
                id=f"key_{g.id}",
                exam_id=exam.id,
                group_id=g.id,
                group_name=g.group_name,
                items=items,
                updated_at=exam.updated_at.isoformat() if exam.updated_at else None,
            )
        )
    return keys


@router.put("/{exam_id}/questions/{question_id}", response_model=QuestionResponse)
async def update_question(
    exam_id: str,
    question_id: str,
    payload: QuestionUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Allows teacher to edit question text, choices, marks, or explanation."""
    stmt = select(ExamQuestion).where(ExamQuestion.id == question_id, ExamQuestion.exam_id == exam_id)
    result = await db.execute(stmt)
    q = result.scalar_one_or_none()
    if not q:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Question not found")

    if payload.question_text is not None:
        q.question_text = payload.question_text
    if payload.options is not None:
        q.options = payload.options
    if payload.correct_answer is not None:
        q.correct_answer = payload.correct_answer
    if payload.explanation is not None:
        q.explanation = payload.explanation
    if payload.marks is not None:
        q.marks = payload.marks
    if payload.difficulty is not None:
        q.difficulty = payload.difficulty
    if payload.bloom_level is not None:
        q.bloom_level = payload.bloom_level
    if payload.question_order is not None:
        q.question_order = payload.question_order

    await db.commit()
    await db.refresh(q)

    return QuestionResponse(
        id=q.id,
        exam_id=q.exam_id,
        group_id=q.group_id,
        question_order=q.question_order,
        question_type=q.question_type,
        question_text=q.question_text,
        options=q.options,
        correct_answer=q.correct_answer,
        explanation=q.explanation,
        marks=q.marks,
        difficulty=q.difficulty,
        bloom_level=q.bloom_level,
        source_document_name=q.source_document_name,
        source_page=q.source_page,
        source_chapter=q.source_chapter,
        source_section=q.source_section,
        source_chunk_id=q.source_chunk_id,
        source_evidence=q.source_evidence,
        created_at=q.created_at.isoformat() if q.created_at else None,
        updated_at=q.updated_at.isoformat() if q.updated_at else None,
    )


@router.delete("/{exam_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_exam(exam_id: str, db: AsyncSession = Depends(get_db)):
    """Deletes an exam and cascades deletion of its groups and questions."""
    stmt = select(Exam).where(Exam.id == exam_id)
    result = await db.execute(stmt)
    exam = result.scalar_one_or_none()
    if not exam:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam not found")

    await db.delete(exam)
    await db.commit()
    return None


@router.delete("/{exam_id}/questions/{question_id}", response_model=QuestionDeleteResponse)
async def delete_question(
    exam_id: str,
    question_id: str,
    current_user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Deletes a question and synchronizes deletion of its corresponding isomorphic variants across all groups."""
    # 1. Verify exam exists
    stmt_exam = select(Exam).where(Exam.id == exam_id).options(selectinload(Exam.groups).selectinload(ExamGroup.questions))
    res_exam = await db.execute(stmt_exam)
    exam = res_exam.scalar_one_or_none()
    if not exam:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam not found")

    # 2. Verify question exists in this exam
    stmt_q = select(ExamQuestion).where(ExamQuestion.id == question_id, ExamQuestion.exam_id == exam_id)
    res_q = await db.execute(stmt_q)
    target_q = res_q.scalar_one_or_none()
    if not target_q:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Question not found")

    target_group_id = target_q.group_id
    target_text = target_q.question_text
    target_evidence = target_q.source_evidence

    # Check minimum questions constraint: an exam must retain at least 1 question per group
    group_a = next((g for g in exam.groups if g.group_order == 1 or g.group_name == "Group A"), exam.groups[0] if exam.groups else None)
    if not group_a or len(group_a.questions) <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete question: Examination must retain at least one question."
        )

    # 3. Identify isomorphic counterparts in other groups
    to_delete = [target_q]
    for group in exam.groups:
        if group.id != target_group_id:
            for q in group.questions:
                if q.question_text == target_text or (target_evidence and q.source_evidence == target_evidence):
                    if q not in to_delete:
                        to_delete.append(q)
                    break

    deleted_ids = [q.id for q in to_delete]
    for q in to_delete:
        await db.delete(q)

    await db.flush()

    # 4. Re-sequence question_order in all affected groups
    for group in exam.groups:
        stmt_remaining = (
            select(ExamQuestion)
            .where(ExamQuestion.group_id == group.id)
            .order_by(ExamQuestion.question_order.asc(), ExamQuestion.created_at.asc())
        )
        res_remaining = await db.execute(stmt_remaining)
        remaining_questions = res_remaining.scalars().all()
        for idx, rq in enumerate(remaining_questions, start=1):
            rq.question_order = idx

    # 5. Recalculate total_marks from Group A (or first group)
    stmt_ga_remaining = (
        select(ExamQuestion)
        .where(ExamQuestion.group_id == group_a.id)
        .order_by(ExamQuestion.question_order.asc())
    )
    res_ga = await db.execute(stmt_ga_remaining)
    ga_remaining = res_ga.scalars().all()
    new_total_marks = round(sum(q.marks for q in ga_remaining), 2)
    exam.total_marks = max(0.0, new_total_marks)

    await db.commit()
    await db.refresh(exam)

    return QuestionDeleteResponse(
        deleted_question_id=question_id,
        synchronized_groups_count=len(exam.groups),
        deleted_count=len(deleted_ids),
        remaining_questions_per_group=len(ga_remaining),
        new_total_marks=exam.total_marks,
        message=f"Successfully deleted question and synchronized across {len(exam.groups)} groups. Total marks updated to {exam.total_marks}."
    )


@router.put("/{exam_id}/groups/{group_id}/reorder", response_model=List[QuestionResponse])
async def reorder_questions(
    exam_id: str,
    group_id: str,
    payload: QuestionReorderRequest,
    db: AsyncSession = Depends(get_db),
):
    """Reorders questions within a group while maintaining sequential numbering, answers, and provenance."""
    stmt_group = (
        select(ExamGroup)
        .where(ExamGroup.id == group_id, ExamGroup.exam_id == exam_id)
        .options(selectinload(ExamGroup.questions))
    )
    res_group = await db.execute(stmt_group)
    group = res_group.scalar_one_or_none()
    if not group:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam group not found")

    existing_questions = {q.id: q for q in group.questions}
    provided_ids = payload.question_ids

    if len(provided_ids) != len(existing_questions) or set(provided_ids) != set(existing_questions.keys()):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid question IDs provided. You must provide exactly all existing question IDs for this group."
        )

    for new_order, q_id in enumerate(provided_ids, start=1):
        existing_questions[q_id].question_order = new_order

    await db.commit()

    sorted_questions = sorted(existing_questions.values(), key=lambda q: q.question_order)
    return [
        QuestionResponse(
            id=q.id,
            exam_id=q.exam_id,
            group_id=q.group_id,
            question_order=q.question_order,
            question_type=q.question_type,
            question_text=q.question_text,
            options=q.options,
            correct_answer=q.correct_answer,
            explanation=q.explanation,
            marks=q.marks,
            difficulty=q.difficulty,
            bloom_level=q.bloom_level,
            source_document_name=q.source_document_name,
            source_page=q.source_page,
            source_chapter=q.source_chapter,
            source_section=q.source_section,
            source_chunk_id=q.source_chunk_id,
            source_evidence=q.source_evidence,
            created_at=q.created_at.isoformat() if q.created_at else None,
            updated_at=q.updated_at.isoformat() if q.updated_at else None,
        )
        for q in sorted_questions
    ]


@router.post("/{exam_id}/questions/{question_id}/regenerate", response_model=QuestionResponse)
async def regenerate_question(
    exam_id: str,
    question_id: str,
    payload: QuestionRegenerateRequest = QuestionRegenerateRequest(),
    session_id: Optional[str] = Query(None),
    current_user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Regenerates a single question grounded in its source chunk and synchronizes variants across groups."""
    stmt_exam = select(Exam).where(Exam.id == exam_id)
    res_exam = await db.execute(stmt_exam)
    exam = res_exam.scalar_one_or_none()
    if not exam:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam not found")

    stmt_q = select(ExamQuestion).where(ExamQuestion.id == question_id, ExamQuestion.exam_id == exam_id)
    res_q = await db.execute(stmt_q)
    target_q = res_q.scalar_one_or_none()
    if not target_q:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Question not found")

    user_sess = (current_user.id if current_user else None) or session_id or exam.session_id or "default"
    generator = get_exam_generation_service()

    updated_q = await generator.regenerate_single_question(
        db=db,
        exam=exam,
        target_question=target_q,
        instructions=payload.instructions,
        session_id=user_sess,
    )

    return QuestionResponse(
        id=updated_q.id,
        exam_id=updated_q.exam_id,
        group_id=updated_q.group_id,
        question_order=updated_q.question_order,
        question_type=updated_q.question_type,
        question_text=updated_q.question_text,
        options=updated_q.options,
        correct_answer=updated_q.correct_answer,
        explanation=updated_q.explanation,
        marks=updated_q.marks,
        difficulty=updated_q.difficulty,
        bloom_level=updated_q.bloom_level,
        source_document_name=updated_q.source_document_name,
        source_page=updated_q.source_page,
        source_chapter=updated_q.source_chapter,
        source_section=updated_q.source_section,
        source_chunk_id=updated_q.source_chunk_id,
        source_evidence=updated_q.source_evidence,
        created_at=updated_q.created_at.isoformat() if updated_q.created_at else None,
        updated_at=updated_q.updated_at.isoformat() if updated_q.updated_at else None,
    )


# -----------------------------------------------------------------------------
# Checkpoint 4.2: Export Engine Endpoints (DOCX & PDF)
# -----------------------------------------------------------------------------
@router.get("/{exam_id}/export/docx", summary="Export examination as Word (.docx) document")
async def export_exam_docx(
    exam_id: str,
    group_id: Optional[str] = Query(None, description="Optional specific group ID to export. If omitted, exports all groups."),
    target: Literal["both", "exam", "answer_key"] = Query("both", description="Target component: 'exam', 'answer_key', or 'both'."),
    include_references: bool = Query(True, description="Whether to include source evidence and provenance in the teacher answer key."),
    db: AsyncSession = Depends(get_db),
):
    """Exports examination as a styled Word DOCX file with student paper and confidential answer key."""
    stmt = (
        select(Exam)
        .where(Exam.id == exam_id)
        .options(
            selectinload(Exam.groups).selectinload(ExamGroup.questions)
        )
    )
    res = await db.execute(stmt)
    exam = res.scalar_one_or_none()
    if not exam:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam not found")

    if not exam.groups:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Exam has no question groups to export")

    if group_id:
        selected_groups = [g for g in exam.groups if g.id == group_id]
        if not selected_groups:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Group with ID {group_id} not found in this examination")
        group_suffix = selected_groups[0].group_name
    else:
        selected_groups = sorted(exam.groups, key=lambda g: g.group_order)
        group_suffix = "All_Groups" if len(selected_groups) > 1 else selected_groups[0].group_name

    export_service = get_export_service()
    docx_buffer = export_service.generate_docx(
        exam=exam,
        groups=selected_groups,
        target=target,
        include_references=include_references,
    )

    filename = sanitize_export_filename(exam.title, group_suffix, "docx")
    return StreamingResponse(
        docx_buffer,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{exam_id}/export/pdf", summary="Export examination as PDF (.pdf) document")
async def export_exam_pdf(
    exam_id: str,
    group_id: Optional[str] = Query(None, description="Optional specific group ID to export. If omitted, exports all groups."),
    target: Literal["both", "exam", "answer_key"] = Query("both", description="Target component: 'exam', 'answer_key', or 'both'."),
    include_references: bool = Query(True, description="Whether to include source evidence and provenance in the teacher answer key."),
    db: AsyncSession = Depends(get_db),
):
    """Exports examination as a formatted PDF file with student paper and confidential answer key."""
    stmt = (
        select(Exam)
        .where(Exam.id == exam_id)
        .options(
            selectinload(Exam.groups).selectinload(ExamGroup.questions)
        )
    )
    res = await db.execute(stmt)
    exam = res.scalar_one_or_none()
    if not exam:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam not found")

    if not exam.groups:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Exam has no question groups to export")

    if group_id:
        selected_groups = [g for g in exam.groups if g.id == group_id]
        if not selected_groups:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Group with ID {group_id} not found in this examination")
        group_suffix = selected_groups[0].group_name
    else:
        selected_groups = sorted(exam.groups, key=lambda g: g.group_order)
        group_suffix = "All_Groups" if len(selected_groups) > 1 else selected_groups[0].group_name

    export_service = get_export_service()
    pdf_buffer = export_service.generate_pdf(
        exam=exam,
        groups=selected_groups,
        target=target,
        include_references=include_references,
    )

    filename = sanitize_export_filename(exam.title, group_suffix, "pdf")
    return StreamingResponse(
        pdf_buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

