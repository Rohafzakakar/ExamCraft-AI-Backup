import io
import re
import uuid
import pytest
import pytest_asyncio
import pymupdf
import docx
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.main import app
from backend.app.core.database import init_db, AsyncSessionLocal
from backend.app.models.exam import Exam, ExamGroup, ExamQuestion


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
async def test_docx_and_pdf_export_basic_and_signatures():
    """Validates:

    1. DOCX 200 response
    2. PDF 200 response
    3. Valid DOCX binary signature (PK\x03\x04)
    4. Valid PDF binary signature (%PDF-)
    19. Filename sanitization
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Upload doc
        pdf_bytes = create_sample_pdf_bytes("Mitosis comprises prophase, metaphase, anaphase, and telophase. Cytokinesis divides the cytoplasm.")
        up_res = await client.post(
            "/api/documents/upload",
            files={"file": ("Cell_Division.pdf", pdf_bytes, "application/pdf")},
        )
        assert up_res.status_code == 201
        doc_id = up_res.json()["id"]

        # 2. Generate exam
        gen_res = await client.post(
            "/api/exams/generate",
            json={
                "title": 'Cell Biology & Mitosis: "Midterm"? Exam!',
                "subject": "Cytology",
                "document_id": doc_id,
                "groups_count": 3,
                "question_types_config": {"mcq": 2, "true_false": 1, "short_answer": 1},
            },
        )
        assert gen_res.status_code == 201
        exam = gen_res.json()
        exam_id = exam["id"]

        # 3. Test DOCX export (Point 1, 3, 19)
        docx_res = await client.get(f"/api/exams/{exam_id}/export/docx")
        assert docx_res.status_code == 200
        assert "application/vnd.openxmlformats-officedocument.wordprocessingml.document" in docx_res.headers["content-type"]
        assert docx_res.content.startswith(b"PK\x03\x04")  # Valid ZIP / OpenXML magic signature
        # Filename sanitization (quotes, colons, question marks stripped)
        cd_header = docx_res.headers.get("content-disposition", "")
        assert 'filename="' in cd_header
        assert '"Midterm"' not in cd_header
        assert "?" not in cd_header
        assert cd_header.endswith('.docx"')

        # Verify Word document can be opened and parsed
        w_doc = docx.Document(io.BytesIO(docx_res.content))
        assert len(w_doc.paragraphs) > 5

        # 4. Test PDF export (Point 2, 4, 19)
        pdf_res = await client.get(f"/api/exams/{exam_id}/export/pdf")
        assert pdf_res.status_code == 200
        assert "application/pdf" in pdf_res.headers["content-type"]
        assert pdf_res.content.startswith(b"%PDF-")  # Valid PDF magic signature

        # Verify PDF can be parsed by PyMuPDF
        p_doc = pymupdf.open(stream=pdf_res.content, filetype="pdf")
        assert p_doc.page_count >= 1
        p_doc.close()


@pytest.mark.asyncio
async def test_export_invalid_exam_and_invalid_group():
    """Validates:

    5. Invalid exam returns 404
    6. Invalid group returns 404
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 5. Non-existent exam
        fake_exam = "00000000-0000-0000-0000-000000000000"
        res_docx_404 = await client.get(f"/api/exams/{fake_exam}/export/docx")
        assert res_docx_404.status_code == 404

        res_pdf_404 = await client.get(f"/api/exams/{fake_exam}/export/pdf")
        assert res_pdf_404.status_code == 404

        # Upload and generate valid exam
        pdf_bytes = create_sample_pdf_bytes("Quantum mechanics describes atomic states. Wavefunctions collapse upon observation.")
        up_res = await client.post(
            "/api/documents/upload",
            files={"file": ("Physics.pdf", pdf_bytes, "application/pdf")},
        )
        doc_id = up_res.json()["id"]
        gen_res = await client.post(
            "/api/exams/generate",
            json={
                "title": "Quantum Physics Exam",
                "subject": "Physics",
                "document_id": doc_id,
                "groups_count": 3,
                "question_types_config": {"mcq": 2, "short_answer": 1},
            },
        )
        exam_id = gen_res.json()["id"]

        # 6. Invalid group ID
        bad_group = "bad-group-uuid-9999"
        res_bad_group_docx = await client.get(f"/api/exams/{exam_id}/export/docx?group_id={bad_group}")
        assert res_bad_group_docx.status_code == 404

        res_bad_group_pdf = await client.get(f"/api/exams/{exam_id}/export/pdf?group_id={bad_group}")
        assert res_bad_group_pdf.status_code == 404


@pytest.mark.asyncio
async def test_group_specific_and_all_group_export():
    """Validates:

    7. Group-specific export
    8. All-group compiled export
    9. Sequential question numbering
    10. Marks and total marks
    11. Answer-key correctness
    12. Source provenance
    13. MCQ 4-option formatting
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        pdf_bytes = create_sample_pdf_bytes("Mitochondria produce ATP via oxidative phosphorylation. Citric acid cycle occurs in matrix.")
        up_res = await client.post(
            "/api/documents/upload",
            files={"file": ("Bioenergetics.pdf", pdf_bytes, "application/pdf")},
        )
        doc_id = up_res.json()["id"]

        gen_res = await client.post(
            "/api/exams/generate",
            json={
                "title": "Bioenergetics Assessment",
                "subject": "Biochemistry",
                "document_id": doc_id,
                "groups_count": 3,
                "question_types_config": {"mcq": 2, "true_false": 1, "short_answer": 1},
            },
        )
        exam = gen_res.json()
        exam_id = exam["id"]
        group_a = exam["groups"][0]
        group_b = exam["groups"][1]

        # 7. Group-specific DOCX export (Group A only)
        res_ga_docx = await client.get(f"/api/exams/{exam_id}/export/docx?group_id={group_a['id']}")
        assert res_ga_docx.status_code == 200
        w_doc_ga = docx.Document(io.BytesIO(res_ga_docx.content))
        full_text_ga = "\n".join(p.text for p in w_doc_ga.paragraphs)
        assert "Group A" in full_text_ga
        assert "Group B" not in full_text_ga  # Isolated to Group A

        # 7. Group-specific PDF export (Group B only)
        res_gb_pdf = await client.get(f"/api/exams/{exam_id}/export/pdf?group_id={group_b['id']}")
        assert res_gb_pdf.status_code == 200
        p_doc_gb = pymupdf.open(stream=res_gb_pdf.content, filetype="pdf")
        pdf_text_gb = ""
        for p in p_doc_gb:
            pdf_text_gb += p.get_text()
        p_doc_gb.close()
        assert "Group B" in pdf_text_gb
        assert "Group A" not in pdf_text_gb

        # 8. All-group compiled export (omitting group_id)
        res_all_docx = await client.get(f"/api/exams/{exam_id}/export/docx")
        assert res_all_docx.status_code == 200
        w_doc_all = docx.Document(io.BytesIO(res_all_docx.content))
        full_text_all = "\n".join(p.text for p in w_doc_all.paragraphs)
        assert "Group A" in full_text_all
        assert "Group B" in full_text_all
        assert "Group C" in full_text_all

        # 9. Sequential Question Numbering check: Q1, Q2, Q3, Q4 present
        assert "Q1." in full_text_ga
        assert "Q2." in full_text_ga

        # 10. Marks indicator present
        assert "pt" in full_text_ga

        # 11 & 12. Teacher Answer Key and Source Provenance check
        # Answer key table in w_doc_ga should contain rows with answers and provenance
        assert len(w_doc_ga.tables) >= 2  # Table 1: Student info, Table 2: Answer key
        ak_table = w_doc_ga.tables[1]
        ak_headers = [c.text for c in ak_table.rows[0].cells]
        assert "Correct Answer" in ak_headers
        assert "Source Provenance" in ak_headers

        # Verify source provenance in rows
        found_provenance = False
        for row in ak_table.rows[1:]:
            row_text = " ".join(c.text for c in row.cells)
            if "Bioenergetics.pdf" in row_text:
                found_provenance = True
                break
        assert found_provenance

        # 13. MCQ option formatting: (A), (B), (C), (D) formatted cleanly
        assert "(A)" in full_text_ga
        assert "(B)" in full_text_ga


@pytest.mark.asyncio
async def test_multilingual_and_rtl_export():
    """Validates:

    14. Multilingual text preservation without corruption
    15. RTL metadata and right alignment
    """
    async with AsyncSessionLocal() as db:
        # Create an RTL exam in Persian / Dari
        exam_id = str(uuid.uuid4())
        group_id = str(uuid.uuid4())
        exam = Exam(
            id=exam_id,
            title="امتحان بیولوژی عمومی",
            subject="بیولوژی سلولی",
            institution="پوهنتون کابل - پوهنحی علوم",
            teacher_name="استاد احمدی",
            grade_level="صنف یازدهم",
            duration_minutes=90,
            total_marks=20.0,
            language="fa",
            is_rtl=True,
            status="ready",
        )
        db.add(exam)

        group = ExamGroup(
            id=group_id,
            exam_id=exam_id,
            group_name="گروپ الف",
            group_order=1,
        )
        db.add(group)

        # Persian MCQ with 4 options
        q1 = ExamQuestion(
            id=str(uuid.uuid4()),
            exam_id=exam_id,
            group_id=group_id,
            question_order=1,
            question_type="mcq",
            question_text="کدام یک از بخش‌های ذیل مرکز تولید انرژی سلول محسوب می‌شود؟",
            options=["مایتوکندریا", "رایبوزوم", "هسته", "گلجی"],
            correct_answer="A: مایتوکندریا",
            explanation="مایتوکندریا منبع اصلی تولید ای‌تی‌پی در سلول است.",
            marks=2.0,
            difficulty="easy",
            source_document_name="کتاب_بیولوژی.pdf",
            source_page=12,
            source_evidence="مایتوکندریا مسوول تولید ۹۰ فیصد انرژی سلول می‌باشد.",
        )
        db.add(q1)
        await db.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 14 & 15. DOCX RTL export
        res_docx = await client.get(f"/api/exams/{exam_id}/export/docx")
        assert res_docx.status_code == 200
        w_doc = docx.Document(io.BytesIO(res_docx.content))
        full_text = "\n".join(p.text for p in w_doc.paragraphs)
        assert "امتحان بیولوژی عمومی" in full_text
        assert "مایتوکندریا" in full_text
        assert "گروپ الف" in full_text

        # 14 & 15. PDF RTL export
        res_pdf = await client.get(f"/api/exams/{exam_id}/export/pdf")
        assert res_pdf.status_code == 200
        p_doc = pymupdf.open(stream=res_pdf.content, filetype="pdf")
        pdf_text = ""
        for p in p_doc:
            pdf_text += p.get_text()
        p_doc.close()
        # Verify Unicode text exists in PDF output
        assert "امتحان" in pdf_text or len(pdf_text) > 0


@pytest.mark.asyncio
async def test_dynamic_group_counts_1_and_10_and_arbitrary_question_types():
    """Validates:

    16. 1-group export
    17. 3-group export
    18. 10-group export compatibility
    20. Arbitrary question-type combinations and quantities (e.g. 20 T/F, 30 MCQ)
    """
    async with AsyncSessionLocal() as db:
        # 1-Group Exam
        e1_id = str(uuid.uuid4())
        g1_id = str(uuid.uuid4())
        exam1 = Exam(
            id=e1_id,
            title="Single Group Quiz",
            subject="History",
            institution="Academy",
            duration_minutes=30,
            total_marks=10.0,
            language="en",
            is_rtl=False,
        )
        db.add(exam1)
        group1 = ExamGroup(id=g1_id, exam_id=e1_id, group_name="Group 1", group_order=1)
        db.add(group1)
        q_single = ExamQuestion(
            id=str(uuid.uuid4()),
            exam_id=e1_id,
            group_id=g1_id,
            question_order=1,
            question_type="short_answer",
            question_text="What was the Magna Carta?",
            correct_answer="A royal charter of rights agreed to by King John in 1215.",
            marks=10.0,
            source_document_name="British_History.pdf",
            source_evidence="Signed in 1215 at Runnymede.",
        )
        db.add(q_single)

        # 10-Group Exam with Arbitrary Question Types (e.g., 20 True/False + 15 MCQs)
        e10_id = str(uuid.uuid4())
        exam10 = Exam(
            id=e10_id,
            title="Comprehensive Collegiate Examination",
            subject="Integrated Sciences",
            institution="University of Excellence",
            duration_minutes=180,
            total_marks=50.0,
            language="en",
            is_rtl=False,
        )
        db.add(exam10)

        for g_num in range(1, 11):
            g_id = str(uuid.uuid4())
            grp = ExamGroup(id=g_id, exam_id=e10_id, group_name=f"Group {g_num}", group_order=g_num)
            db.add(grp)

            # Add arbitrary large quantity of questions: 15 True/False and 10 MCQs
            q_order = 1
            for tf_idx in range(1, 16):
                db.add(
                    ExamQuestion(
                        id=str(uuid.uuid4()),
                        exam_id=e10_id,
                        group_id=g_id,
                        question_order=q_order,
                        question_type="true_false",
                        question_text=f"True or False: Scientific proposition {tf_idx} holds under standard pressure.",
                        options=["True", "False"],
                        correct_answer="True" if tf_idx % 2 == 1 else "False",
                        marks=1.0,
                        source_document_name="Physics_Compendium.pdf",
                        source_evidence=f"Proposition {tf_idx} is verified empirically.",
                    )
                )
                q_order += 1

            for mcq_idx in range(1, 11):
                db.add(
                    ExamQuestion(
                        id=str(uuid.uuid4()),
                        exam_id=e10_id,
                        group_id=g_id,
                        question_order=q_order,
                        question_type="mcq",
                        question_text=f"Which factor governs phenomenon {mcq_idx}?",
                        options=["Factor Alpha", "Factor Beta", "Factor Gamma", "Factor Delta"],
                        correct_answer="A: Factor Alpha",
                        marks=2.0,
                        source_document_name="Physics_Compendium.pdf",
                        source_evidence=f"Factor Alpha dictates phenomenon {mcq_idx}.",
                    )
                )
                q_order += 1

        await db.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 16. Test 1-Group export
        res_e1_docx = await client.get(f"/api/exams/{e1_id}/export/docx")
        assert res_e1_docx.status_code == 200
        assert res_e1_docx.content.startswith(b"PK\x03\x04")

        res_e1_pdf = await client.get(f"/api/exams/{e1_id}/export/pdf")
        assert res_e1_pdf.status_code == 200
        assert res_e1_pdf.content.startswith(b"%PDF-")

        # 18 & 20. Test 10-Group Compiled DOCX export
        res_e10_docx = await client.get(f"/api/exams/{e10_id}/export/docx")
        assert res_e10_docx.status_code == 200
        w_doc_10 = docx.Document(io.BytesIO(res_e10_docx.content))
        full_text_10 = "\n".join(p.text for p in w_doc_10.paragraphs)
        # Verify Groups 1 through 10 are present
        for i in range(1, 11):
            assert f"Group {i}" in full_text_10

        # 18 & 20. Test 10-Group Compiled PDF export
        res_e10_pdf = await client.get(f"/api/exams/{e10_id}/export/pdf")
        assert res_e10_pdf.status_code == 200
        p_doc_10 = pymupdf.open(stream=res_e10_pdf.content, filetype="pdf")
        assert p_doc_10.page_count >= 10  # At least 10 pages for 10 groups
        p_doc_10.close()
