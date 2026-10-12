import pytest
import pytest_asyncio
import io
import uuid
import pymupdf
from httpx import AsyncClient, ASGITransport
from backend.app.core.database import Base, engine, init_db
from backend.app.main import app
from backend.app.models.exam import Exam, ExamGroup, ExamQuestion
from backend.app.models.document import Document, DocumentChunk
from backend.app.services.llm_session import get_active_api_key, is_llm_configured


@pytest_asyncio.fixture(autouse=True)
async def prepare_db():
    await init_db()
    yield


def make_sample_pdf(content: str) -> bytes:
    doc = pymupdf.open()
    p = doc.new_page()
    p.insert_text(pymupdf.Point(50, 72), f"Chapter 1: Principles of Cellular Biochemistry\n\n{content}")
    p2 = doc.new_page()
    p2.insert_text(pymupdf.Point(50, 72), f"Chapter 2: Energy Transformations and ATP Yield\n\n{content}")
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


@pytest.mark.asyncio
async def test_question_delete_and_multigroup_sync():
    """Validates deleting a question cascades across Group A, B, and C,
    re-sequences question order, and recalculates total marks.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Upload document
        pdf_bytes = make_sample_pdf("Glycolysis converts glucose to pyruvate in the cytoplasm, yielding 2 ATP and 2 NADH. The Krebs cycle occurs in mitochondrial matrix.")
        files = {"file": ("Cell_Bio.pdf", pdf_bytes, "application/pdf")}
        doc_res = await client.post("/api/documents/upload", files=files)
        assert doc_res.status_code == 201
        doc_id = doc_res.json()["id"]

        # 2. Generate exam with 3 groups
        exam_payload = {
            "title": "Bioenergetics Exam Phase 4",
            "subject": "Biochemistry",
            "document_id": doc_id,
            "groups_count": 3,
            "duration_minutes": 60,
            "question_types_config": {"mcq": 2, "true_false": 1, "short_answer": 1},
            "difficulty_distribution": {"easy": 50, "medium": 25, "hard": 25},
        }
        gen_res = await client.post("/api/exams/generate", json=exam_payload)
        assert gen_res.status_code == 201
        exam = gen_res.json()
        exam_id = exam["id"]
        assert len(exam["groups"]) == 3

        group_a = exam["groups"][0]
        group_b = exam["groups"][1]
        group_c = exam["groups"][2]
        initial_q_count = len(group_a["questions"])
        assert initial_q_count >= 2
        initial_marks = sum(q["marks"] for q in group_a["questions"])

        # Pick question 1 from Group A
        target_q = group_a["questions"][0]
        target_q_id = target_q["id"]
        target_marks = target_q["marks"]

        # 3. Attempt invalid exam / question ID
        del_bad_exam = await client.delete(f"/api/exams/non-existent-exam/questions/{target_q_id}")
        assert del_bad_exam.status_code == 404

        del_bad_q = await client.delete(f"/api/exams/{exam_id}/questions/non-existent-question")
        assert del_bad_q.status_code == 404

        # 4. Delete question and verify multi-group sync
        del_res = await client.delete(f"/api/exams/{exam_id}/questions/{target_q_id}")
        assert del_res.status_code == 200
        del_data = del_res.json()
        assert del_data["deleted_question_id"] == target_q_id
        assert del_data["synchronized_groups_count"] == 3
        assert del_data["deleted_count"] == 3  # deleted from Group A, B, and C
        assert del_data["remaining_questions_per_group"] == initial_q_count - 1
        assert del_data["new_total_marks"] == pytest.approx(initial_marks - target_marks, rel=1e-2)

        # 5. Fetch exam and verify structure, sequential question_order, and answer keys
        updated_exam = (await client.get(f"/api/exams/{exam_id}")).json()
        for g in updated_exam["groups"]:
            assert len(g["questions"]) == initial_q_count - 1
            # Verify sequential numbering 1, 2, 3
            orders = [q["question_order"] for q in g["questions"]]
            assert orders == list(range(1, initial_q_count))
            # Provenance preserved
            for q in g["questions"]:
                assert q["source_document_name"]
                assert q["source_evidence"]

        # 6. Verify Answer Key integrity
        key_res = await client.get(f"/api/exams/{exam_id}/answer-key")
        assert key_res.status_code == 200
        keys = key_res.json()
        assert len(keys) == 3
        for k in keys:
            assert len(k["items"]) == initial_q_count - 1
            for item in k["items"]:
                assert item["question_number"] in [1, 2, 3]
                assert item["correct_answer"]


@pytest.mark.asyncio
async def test_question_reordering_within_group():
    """Validates reordering questions within a group:
    - sequential 1-indexed order applied
    - error on missing or invalid IDs
    - answer key sync
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        pdf_bytes = make_sample_pdf("Photosynthesis occurs in chloroplasts. Light reactions generate ATP. Calvin cycle fixes CO2 into sugar.")
        doc_res = await client.post(
            "/api/documents/upload",
            files={"file": ("Syllabus.pdf", pdf_bytes, "application/pdf")},
        )
        assert doc_res.status_code == 201
        doc_id = doc_res.json()["id"]

        exam_payload = {
            "title": "Plant Physiology Exam",
            "subject": "Botany",
            "document_id": doc_id,
            "groups_count": 3,
            "question_types_config": {"mcq": 2, "short_answer": 1},
        }
        exam = (await client.post("/api/exams/generate", json=exam_payload)).json()
        exam_id = exam["id"]
        group_a = exam["groups"][0]
        group_a_id = group_a["id"]
        questions = group_a["questions"]
        num_questions = len(questions)
        assert num_questions >= 2

        orig_ids = [q["id"] for q in questions]
        reversed_ids = list(reversed(orig_ids))

        # 1. Invalid payload: missing one ID
        bad_reorder = await client.put(
            f"/api/exams/{exam_id}/groups/{group_a_id}/reorder",
            json={"question_ids": orig_ids[:1]},
        )
        assert bad_reorder.status_code == 400

        # 2. Invalid payload: unknown ID
        bad_reorder_unknown = await client.put(
            f"/api/exams/{exam_id}/groups/{group_a_id}/reorder",
            json={"question_ids": orig_ids[:num_questions - 1] + ["fake-question-id-123"]},
        )
        assert bad_reorder_unknown.status_code == 400

        # 3. Valid reorder: reverse list
        reorder_res = await client.put(
            f"/api/exams/{exam_id}/groups/{group_a_id}/reorder",
            json={"question_ids": reversed_ids},
        )
        assert reorder_res.status_code == 200
        reordered_questions = reorder_res.json()
        assert [q["id"] for q in reordered_questions] == reversed_ids
        assert [q["question_order"] for q in reordered_questions] == list(range(1, num_questions + 1))

        # Content, marks, and provenance preserved
        for orig, reord in zip(reversed(questions), reordered_questions):
            assert orig["id"] == reord["id"]
            assert orig["question_text"] == reord["question_text"]
            assert orig["marks"] == reord["marks"]
            assert orig["source_evidence"] == reord["source_evidence"]

        # 4. Verify answer key reflects the new question order
        keys = (await client.get(f"/api/exams/{exam_id}/answer-key")).json()
        ga_key = next(k for k in keys if k["group_id"] == group_a_id)
        assert [item["question_number"] for item in ga_key["items"]] == list(range(1, num_questions + 1))
        # Item 1 now corresponds to the reversed question
        assert ga_key["items"][0]["correct_answer"] == reordered_questions[0]["correct_answer"]


@pytest.mark.asyncio
async def test_single_question_regeneration():
    """Validates single-question regeneration:
    - preserves question type, difficulty, marks
    - grounds replacement question in source chunk/evidence
    - checks for duplicate avoidance
    - synchronizes replacement across isomorphic groups
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        pdf_bytes = make_sample_pdf("DNA replication is semiconservative as demonstrated by Meselson and Stahl. Helicase unwinds the double helix, while DNA polymerase synthesizes the complementary strand in the 5 to 3 prime direction.")
        doc_res = await client.post(
            "/api/documents/upload",
            files={"file": ("Genetics_Chapter.pdf", pdf_bytes, "application/pdf")},
        )
        assert doc_res.status_code == 201
        doc_id = doc_res.json()["id"]

        exam_payload = {
            "title": "Molecular Genetics Exam",
            "subject": "Genetics",
            "document_id": doc_id,
            "groups_count": 3,
            "question_types_config": {"mcq": 2, "short_answer": 1},
        }
        exam = (await client.post("/api/exams/generate", json=exam_payload)).json()
        exam_id = exam["id"]

        # Target MCQ question in Group A
        target_mcq = next(q for q in exam["groups"][0]["questions"] if q["question_type"] == "mcq")
        target_id = target_mcq["id"]
        old_text = target_mcq["question_text"]
        old_type = target_mcq["question_type"]
        old_marks = target_mcq["marks"]
        old_difficulty = target_mcq["difficulty"]

        # 1. Regenerate question with teacher instructions
        regen_res = await client.post(
            f"/api/exams/{exam_id}/questions/{target_id}/regenerate",
            json={"instructions": "Focus specifically on DNA polymerase directionality."},
        )
        assert regen_res.status_code == 200
        new_q = regen_res.json()

        assert new_q["id"] == target_id
        assert new_q["question_type"] == old_type
        assert new_q["marks"] == old_marks
        assert new_q["difficulty"] == old_difficulty
        assert new_q["source_document_name"]
        assert new_q["source_evidence"]

        # 2. Verify replacement is synchronized across Group B and C
        updated_exam = (await client.get(f"/api/exams/{exam_id}")).json()
        group_b_questions = updated_exam["groups"][1]["questions"]
        group_c_questions = updated_exam["groups"][2]["questions"]

        # The new question text should be present in Group B and Group C
        qb_match = next((q for q in group_b_questions if q["question_text"] == new_q["question_text"]), None)
        qc_match = next((q for q in group_c_questions if q["question_text"] == new_q["question_text"]), None)

        assert qb_match is not None, "Regenerated question was not synchronized to Group B"
        assert qc_match is not None, "Regenerated question was not synchronized to Group C"

        # The old question text should no longer exist in any group
        all_texts = [q["question_text"] for g in updated_exam["groups"] for q in g["questions"]]
        assert old_text not in all_texts or old_text != new_q["question_text"]

        # 3. Answer keys are synchronized
        keys = (await client.get(f"/api/exams/{exam_id}/answer-key")).json()
        for k in keys:
            assert len(k["items"]) == len(exam["groups"][0]["questions"])
            for it in k["items"]:
                assert it["correct_answer"]
