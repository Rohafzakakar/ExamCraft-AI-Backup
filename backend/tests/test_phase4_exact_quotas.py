import io
import json
import pytest
import pytest_asyncio
import pymupdf
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.core.database import init_db
from backend.app.services.llm_client import LLMProviderInterface, set_llm_client_override


class MockOpenRouterClient(LLMProviderInterface):
    """Deterministic mock client mimicking OpenRouter response for automated tests."""

    async def generate_chat(
        self,
        messages: list,
        temperature: float = 0.2,
        max_tokens: int = 4000,
        response_format: dict = None,
        session_id: str = "default",
    ) -> str:
        user_msg = messages[-1]["content"] if messages else ""
        if "SINGLE replacement examination question" in user_msg:
            return json.dumps({
                "question_text": "Updated Saltatory Conduction Question?",
                "options": ["A) Rapid impulse", "B) Slow drift", "C) Continuous leakage", "D) Synaptic delay"],
                "correct_answer": "A) Rapid impulse",
                "explanation": "Saltatory conduction increases action potential velocity.",
                "source_evidence": "Myelin sheaths produced by Schwann cells allow saltatory conduction.",
            })

        questions = []
        if "REQUIRED QUESTION SPECIFICATIONS LIST:" in user_msg:
            try:
                plan_part = user_msg.split("REQUIRED QUESTION SPECIFICATIONS LIST:")[1].split("REFERENCE CONTEXT CHUNKS:")[0].strip()
                plan = json.loads(plan_part)
                for item in plan:
                    q_num = item["question_number"]
                    q_type = item["question_type"]
                    if q_type == "mcq":
                        questions.append({
                            "question_number": q_num,
                            "question_type": "mcq",
                            "difficulty": item["difficulty"],
                            "bloom_level": item.get("bloom_level") or "understand",
                            "question_text": f"Which principle applies to topic concept {q_num}?",
                            "options": [f"Option A for item {q_num}", f"Option B for item {q_num}", f"Option C for item {q_num}", f"Option D for item {q_num}"],
                            "correct_answer": f"Option A for item {q_num}",
                            "explanation": f"Explanation for question {q_num}.",
                            "marks": item["marks"],
                            "source_document_name": "Test.pdf",
                            "source_page": 1,
                            "source_evidence": "Verbatim evidence quote.",
                        })
                    elif q_type == "true_false":
                        questions.append({
                            "question_number": q_num,
                            "question_type": "true_false",
                            "difficulty": item["difficulty"],
                            "bloom_level": item.get("bloom_level") or "understand",
                            "question_text": f"True or False: Statement {q_num} is correct.",
                            "options": ["True", "False"],
                            "correct_answer": "True",
                            "explanation": f"Explanation for question {q_num}.",
                            "marks": item["marks"],
                            "source_document_name": "Test.pdf",
                            "source_page": 1,
                            "source_evidence": "Verbatim evidence quote.",
                        })
                    elif q_type == "fill_blank":
                        questions.append({
                            "question_number": q_num,
                            "question_type": "fill_blank",
                            "difficulty": item["difficulty"],
                            "bloom_level": item.get("bloom_level") or "understand",
                            "question_text": f"Complete statement {q_num}: [_____] is essential.",
                            "options": None,
                            "correct_answer": f"Term {q_num}",
                            "explanation": f"Explanation for question {q_num}.",
                            "marks": item["marks"],
                            "source_document_name": "Test.pdf",
                            "source_page": 1,
                            "source_evidence": "Verbatim evidence quote.",
                        })
                    elif q_type == "essay":
                        questions.append({
                            "question_number": q_num,
                            "question_type": "essay",
                            "difficulty": item["difficulty"],
                            "bloom_level": item.get("bloom_level") or "understand",
                            "question_text": f"Discuss analytical essay prompt {q_num}.",
                            "options": None,
                            "correct_answer": f"Rubric for prompt {q_num}.",
                            "explanation": f"Explanation for question {q_num}.",
                            "marks": item["marks"],
                            "source_document_name": "Test.pdf",
                            "source_page": 1,
                            "source_evidence": "Verbatim evidence quote.",
                        })
                    else:
                        questions.append({
                            "question_number": q_num,
                            "question_type": q_type,
                            "difficulty": item["difficulty"],
                            "bloom_level": item.get("bloom_level") or "understand",
                            "question_text": f"Short answer question {q_num}.",
                            "options": None,
                            "correct_answer": f"Model answer {q_num}.",
                            "explanation": f"Explanation for question {q_num}.",
                            "marks": item["marks"],
                            "source_document_name": "Test.pdf",
                            "source_page": 1,
                            "source_evidence": "Verbatim evidence quote.",
                        })
            except Exception:
                pass

        return json.dumps({"group_name": "Group A", "questions": questions})


@pytest.fixture(autouse=True)
def setup_mock_llm():
    set_llm_client_override(MockOpenRouterClient())
    yield
    set_llm_client_override(None)


def create_sample_pdf_bytes(text_content: str) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((50, 50), text_content)
    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


@pytest_asyncio.fixture(autouse=True)
async def prepare_db():
    await init_db()
    yield


@pytest.mark.asyncio
async def test_dynamic_group_counts_1_to_10_and_validation():
    """Verifies:
    1. Group generation supports 1 group (Group A).
    2. Group generation supports 6 groups (Group A-F).
    3. Group generation supports 10 groups (Group A-J).
    4. Group count validation rejects 0 (< 1) and 11 (> 10) with 422.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        pdf_bytes = create_sample_pdf_bytes(
            "Enzymes are biological catalysts that speed up biochemical reactions by lowering activation energy. "
            "Substrates bind to the active site of the enzyme through induced fit mechanisms."
        )
        up_res = await client.post(
            "/api/documents/upload",
            files={"file": ("Enzymology.pdf", pdf_bytes, "application/pdf")},
        )
        assert up_res.status_code == 201
        doc_id = up_res.json()["id"]

        # 1. Single group (Group A)
        res_1 = await client.post(
            "/api/exams/generate",
            json={
                "title": "Enzyme Kinetics Single Group",
                "subject": "Biochemistry",
                "document_id": doc_id,
                "groups_count": 1,
                "question_types_config": {"mcq": 3, "true_false": 1},
            },
        )
        assert res_1.status_code == 201
        data_1 = res_1.json()
        assert data_1["groups_count"] == 1
        assert len(data_1["groups"]) == 1
        assert data_1["groups"][0]["group_name"] == "Group A"
        assert len(data_1["groups"][0]["questions"]) == 4

        # 2. Six groups (Group A through Group F)
        res_6 = await client.post(
            "/api/exams/generate",
            json={
                "title": "Enzyme Kinetics 6 Groups",
                "subject": "Biochemistry",
                "document_id": doc_id,
                "groups_count": 6,
                "question_types_config": {"mcq": 2, "short_answer": 1},
            },
        )
        assert res_6.status_code == 201
        data_6 = res_6.json()
        assert data_6["groups_count"] == 6
        assert len(data_6["groups"]) == 6
        expected_names_6 = [f"Group {chr(65 + i)}" for i in range(6)]
        assert [g["group_name"] for g in data_6["groups"]] == expected_names_6
        # Every group must have the exact same question count
        for g in data_6["groups"]:
            assert len(g["questions"]) == 3

        # 3. Ten groups (Group A through Group J)
        res_10 = await client.post(
            "/api/exams/generate",
            json={
                "title": "Enzyme Kinetics 10 Groups",
                "subject": "Biochemistry",
                "document_id": doc_id,
                "groups_count": 10,
                "question_types_config": {"mcq": 2, "true_false": 2},
            },
        )
        assert res_10.status_code == 201
        data_10 = res_10.json()
        assert data_10["groups_count"] == 10
        assert len(data_10["groups"]) == 10
        expected_names_10 = [f"Group {chr(65 + i)}" for i in range(10)]
        assert [g["group_name"] for g in data_10["groups"]] == expected_names_10
        for g in data_10["groups"]:
            assert len(g["questions"]) == 4

        # 4. Validation error when groups_count < 1
        bad_0 = await client.post(
            "/api/exams/generate",
            json={
                "title": "Invalid 0 Groups",
                "subject": "Biochemistry",
                "document_id": doc_id,
                "groups_count": 0,
                "question_types_config": {"mcq": 2},
            },
        )
        assert bad_0.status_code == 422

        # 5. Validation error when groups_count > 10
        bad_11 = await client.post(
            "/api/exams/generate",
            json={
                "title": "Invalid 11 Groups",
                "subject": "Biochemistry",
                "document_id": doc_id,
                "groups_count": 11,
                "question_types_config": {"mcq": 2},
            },
        )
        assert bad_11.status_code == 422


@pytest.mark.asyncio
async def test_exact_question_quotas_and_types():
    """Verifies:
    1. Teacher can specify MCQ only (e.g. 6 MCQs, 0 of others).
    2. Teacher can specify True/False only (e.g. 5 TF, 0 of others).
    3. Teacher can specify all 5 types (MCQ, TF, Fill in the Blank, Short Answer, Essay).
    4. Exact requested question count and types match 100%.
    5. Omitted question types default to 0 rather than unexpected defaults.
    6. Empty/zero total question quota returns 422.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        pdf_bytes = create_sample_pdf_bytes(
            "Thermodynamics is governed by conservation of energy and increasing entropy in closed systems. "
            "Gibbs free energy determines spontaneity: negative delta G indicates exergonic reactions."
        )
        up_res = await client.post(
            "/api/documents/upload",
            files={"file": ("Thermodynamics.pdf", pdf_bytes, "application/pdf")},
        )
        assert up_res.status_code == 201
        doc_id = up_res.json()["id"]

        # 1. MCQ Only: 5 MCQs, all others 0
        mcq_res = await client.post(
            "/api/exams/generate",
            json={
                "title": "Thermodynamics MCQ Only",
                "subject": "Physics",
                "document_id": doc_id,
                "groups_count": 2,
                "question_types_config": {"mcq": 5},
            },
        )
        assert mcq_res.status_code == 201
        mcq_exam = mcq_res.json()
        assert len(mcq_exam["groups"][0]["questions"]) == 5
        for q in mcq_exam["groups"][0]["questions"]:
            assert q["question_type"] == "mcq"
            assert isinstance(q["options"], list)
            assert len(q["options"]) == 4

        # 2. True/False Only: 4 True/False, all others 0
        tf_res = await client.post(
            "/api/exams/generate",
            json={
                "title": "Thermodynamics True/False Only",
                "subject": "Physics",
                "document_id": doc_id,
                "groups_count": 2,
                "question_types_config": {"true_false": 4},
            },
        )
        assert tf_res.status_code == 201
        tf_exam = tf_res.json()
        assert len(tf_exam["groups"][0]["questions"]) == 4
        for q in tf_exam["groups"][0]["questions"]:
            assert q["question_type"] == "true_false"

        # 3. All 5 Question Types: MCQ: 2, True/False: 2, Fill Blank: 1, Short Answer: 1, Essay: 1
        mixed_res = await client.post(
            "/api/exams/generate",
            json={
                "title": "Comprehensive 5-Type Exam",
                "subject": "Physics",
                "document_id": doc_id,
                "groups_count": 3,
                "question_types_config": {
                    "mcq": 2,
                    "true_false": 2,
                    "fill_blank": 1,
                    "short_answer": 1,
                    "essay": 1,
                },
            },
        )
        assert mixed_res.status_code == 201
        mixed_exam = mixed_res.json()
        group_a_questions = mixed_exam["groups"][0]["questions"]
        assert len(group_a_questions) == 7  # 2 + 2 + 1 + 1 + 1 = 7

        type_counts = {}
        for q in group_a_questions:
            t = q["question_type"]
            type_counts[t] = type_counts.get(t, 0) + 1

        assert type_counts["mcq"] == 2
        assert type_counts["true_false"] == 2
        assert type_counts["fill_blank"] == 1
        assert type_counts["short_answer"] == 1
        assert type_counts["essay"] == 1

        # 4. Zero total question quota raises 422
        zero_res = await client.post(
            "/api/exams/generate",
            json={
                "title": "Invalid Zero Questions",
                "subject": "Physics",
                "document_id": doc_id,
                "groups_count": 2,
                "question_types_config": {
                    "mcq": 0,
                    "true_false": 0,
                    "fill_blank": 0,
                    "short_answer": 0,
                    "essay": 0,
                },
            },
        )
        assert zero_res.status_code == 422


@pytest.mark.asyncio
async def test_synchronization_across_ten_groups_on_regeneration():
    """Verifies that an exam generated with 10 groups properly maintains
    synchronization and scoring when a question is regenerated.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        pdf_bytes = create_sample_pdf_bytes(
            "Neurobiology investigates action potential propagation along axon membranes. "
            "Myelin sheaths produced by Schwann cells allow saltatory conduction."
        )
        up_res = await client.post(
            "/api/documents/upload",
            files={"file": ("Neurobiology.pdf", pdf_bytes, "application/pdf")},
        )
        doc_id = up_res.json()["id"]

        gen_res = await client.post(
            "/api/exams/generate",
            json={
                "title": "Neurobiology 10-Group Exam",
                "subject": "Neuroscience",
                "document_id": doc_id,
                "groups_count": 10,
                "question_types_config": {"mcq": 2, "short_answer": 1},
            },
        )
        assert gen_res.status_code == 201
        exam = gen_res.json()
        assert len(exam["groups"]) == 10
        exam_id = exam["id"]
        target_q = exam["groups"][0]["questions"][0]
        target_q_id = target_q["id"]

        # Regenerate target question in Group A
        regen_res = await client.post(
            f"/api/exams/{exam_id}/questions/{target_q_id}/regenerate",
            json={"instructions": "Focus on saltatory conduction"},
        )
        assert regen_res.status_code == 200
        regen_data = regen_res.json()
        assert regen_data["id"] == target_q_id
        new_text = regen_data["question_text"]

        # Fetch exam again and verify question in all 10 groups
        get_res = await client.get(f"/api/exams/{exam_id}")
        assert get_res.status_code == 200
        updated_exam = get_res.json()

        for g in updated_exam["groups"]:
            matching = [q for q in g["questions"] if q["question_text"] == new_text]
            assert len(matching) == 1, f"Regenerated question was not synchronized in {g['group_name']}"
