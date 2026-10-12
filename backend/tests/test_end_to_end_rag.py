import io
import json
import pytest
import pymupdf
import docx
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.core.database import init_db
from backend.app.services.rag_service import get_rag_service
from backend.app.services.vector_store import get_vector_repository
from backend.app.services.embedding import get_embedding_service
from backend.app.services.llm_client import (
    LLMProviderInterface,
    set_llm_client_override,
)


class E2EMockOpenRouterClient(LLMProviderInterface):
    """Mock OpenRouter client returning structured psychometric questions with citations."""

    async def generate_chat(
        self,
        messages: list,
        temperature: float = 0.2,
        max_tokens: int = 4000,
        response_format: dict = None,
        session_id: str = "default",
    ) -> str:
        # Realistic 3-group base question bank
        mock_response = {
            "group_name": "Group A",
            "questions": [
                {
                    "question_number": 1,
                    "question_type": "mcq",
                    "difficulty": "easy",
                    "bloom_level": "remember",
                    "question_text": "What is the worst-case time complexity of QuickSort when using naive pivot selection?",
                    "options": ["O(n log n)", "O(n^2)", "O(n)", "O(log n)"],
                    "correct_answer": "O(n^2)",
                    "explanation": "When an array is already sorted and the first or last element is chosen as pivot, partition depth degrades to n.",
                    "marks": 2.0,
                    "source_document_name": "Computer_Science_Algorithms.pdf",
                    "source_page": 1,
                    "source_chapter": "Sorting Algorithms",
                    "source_section": "1.2 QuickSort Analysis",
                    "source_chunk_id": "chunk_algo_1",
                    "source_evidence": "In the worst case where partitions are extremely unbalanced, QuickSort exhibits quadratic O(n^2) runtime.",
                },
                {
                    "question_number": 2,
                    "question_type": "true_false",
                    "difficulty": "medium",
                    "bloom_level": "understand",
                    "question_text": "True or False: Hash tables guarantee worst-case O(1) retrieval time under any load factor.",
                    "options": ["True", "False"],
                    "correct_answer": "False",
                    "explanation": "Hash tables offer average O(1) operations, but worst-case degrades to O(n) upon high hash collision clustering.",
                    "marks": 1.0,
                    "source_document_name": "Computer_Science_Algorithms.pdf",
                    "source_page": 2,
                    "source_chapter": "Data Structures",
                    "source_section": "2.1 Hash Maps",
                    "source_chunk_id": "chunk_algo_2",
                    "source_evidence": "Under pathological collision scenarios or inadequate resizing, lookup operations in a separate-chaining hash table degrade to linear O(n).",
                },
                {
                    "question_number": 3,
                    "question_type": "short_answer",
                    "difficulty": "hard",
                    "bloom_level": "analyze",
                    "question_text": "Explain why Dijkstra's shortest-path algorithm fails to produce optimal paths in graphs containing negative-weight edges.",
                    "options": None,
                    "correct_answer": "Dijkstra greedily assumes once a vertex is marked settled its distance cannot decrease; negative edges violate this monotonic property.",
                    "explanation": "Greedy choice property is invalidated when a subsequent negative edge provides a shorter total path to an already visited vertex.",
                    "marks": 3.0,
                    "source_document_name": "Computer_Science_Algorithms.pdf",
                    "source_page": 2,
                    "source_chapter": "Graph Theory",
                    "source_section": "2.4 Dijkstra",
                    "source_chunk_id": "chunk_algo_2",
                    "source_evidence": "Dijkstra algorithm relies on non-negative edge weights; edge relaxation fails if later negative edges reduce previously finalized distance estimates.",
                },
            ],
        }
        return f"```json\n{json.dumps(mock_response, indent=2)}\n```"


@pytest.fixture(autouse=True)
def setup_mock_client():
    set_llm_client_override(E2EMockOpenRouterClient())
    yield
    set_llm_client_override(None)


def create_cs_educational_pdf() -> bytes:
    doc = pymupdf.open()
    # Page 1: Sorting Algorithms
    p1 = doc.new_page()
    p1.insert_text(
        pymupdf.Point(50, 72),
        "Chapter 1: Sorting Algorithms and Asymptotic Analysis\n\n"
        "Section 1.1: Merge Sort\n"
        "Merge Sort is an optimal divide-and-conquer algorithm with consistent O(n log n) performance across all input permutations.\n\n"
        "Section 1.2: QuickSort Analysis\n"
        "QuickSort partitions elements around a selected pivot. While average case is O(n log n), in the worst case where partitions are extremely unbalanced, QuickSort exhibits quadratic O(n^2) runtime."
    )
    # Page 2: Data Structures and Graphs
    p2 = doc.new_page()
    p2.insert_text(
        pymupdf.Point(50, 72),
        "Chapter 2: Data Structures and Graph Algorithms\n\n"
        "Section 2.1: Hash Maps\n"
        "Under pathological collision scenarios or inadequate resizing, lookup operations in a separate-chaining hash table degrade to linear O(n).\n\n"
        "Section 2.4: Dijkstra\n"
        "Dijkstra algorithm relies on non-negative edge weights; edge relaxation fails if later negative edges reduce previously finalized distance estimates."
    )
    buf = io.BytesIO()
    doc.save(buf)
    doc.close()
    return buf.getvalue()


@pytest.mark.asyncio
async def test_end_to_end_rag_and_at_least_three_exam_groups():
    await init_db()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Document Upload & Parsing
        pdf_bytes = create_cs_educational_pdf()
        upload_res = await client.post(
            "/api/documents/upload",
            files={"file": ("Computer_Science_Algorithms.pdf", pdf_bytes, "application/pdf")},
        )
        assert upload_res.status_code == 201
        doc_data = upload_res.json()
        doc_id = doc_data["id"]
        assert doc_data["total_pages"] == 2
        assert doc_data["chunks_count"] >= 2
        assert doc_data["status"] == "indexed"

        # 2. Selected Source/Page Retrieval
        page1_res = await client.get(f"/api/documents/{doc_id}/chunks?pages=1")
        assert page1_res.status_code == 200
        page1_chunks = page1_res.json()
        assert len(page1_chunks) >= 1
        assert all(c["page_number"] == 1 for c in page1_chunks)
        assert "Sorting" in page1_chunks[0]["content"]

        # 3. Direct RAG Context Retrieval Test
        rag_svc = get_rag_service()
        retrieved_contexts = await rag_svc.retrieve_approved_context(
            query="QuickSort worst case performance and partitions",
            document_id=doc_id,
            document_name="Computer_Science_Algorithms.pdf",
            approved_pages=[1, 2],
            top_k=2,
        )
        assert len(retrieved_contexts) >= 1
        assert "QuickSort" in retrieved_contexts[0].content

        # 4. Generate Exam with AT LEAST 3 GROUPS (Group A, Group B, Group C)
        exam_payload = {
            "document_id": doc_id,
            "title": "Computer Science Midterm Examination",
            "subject": "Algorithms & Complexity",
            "institution": "Department of Computer Science",
            "teacher_name": "Dr. Turing",
            "grade_level": "Undergraduate",
            "duration_minutes": 120,
            "total_marks": 100.0,
            "language": "en",
            "is_rtl": False,
            "bloom_enabled": True,
            "groups_count": 3,  # Requirement: Minimum 3 groups (Group A, Group B, Group C)
            "difficulty_distribution": {"easy": 40, "medium": 40, "hard": 20},
            "question_types_config": {
                "mcq": 1,
                "true_false": 1,
                "short_answer": 1,
                "fill_blank": 0,
                "essay": 0,
            },
        }

        gen_res = await client.post("/api/exams/generate", json=exam_payload)
        assert gen_res.status_code == 201
        exam = gen_res.json()

        # Verify 3 groups created
        assert exam["groups_count"] == 3
        assert len(exam["groups"]) == 3
        group_names = [g["group_name"] for g in exam["groups"]]
        assert group_names == ["Group A", "Group B", "Group C"]

        # 5. Verify Structured Question Output & Mandatory Metadata Across All 3 Groups
        for group in exam["groups"]:
            assert len(group["questions"]) == 3
            # Check total marks per group are equal
            group_marks = sum(q["marks"] for q in group["questions"])
            assert group_marks == 6.0  # 2.0 (MCQ) + 1.0 (T/F) + 3.0 (Short Answer)

            for q in group["questions"]:
                # Provenance assertions
                assert q["source_document_name"] == "Computer_Science_Algorithms.pdf"
                assert q["source_page"] in [1, 2]
                assert q["source_chunk_id"] is not None
                assert len(q["source_evidence"]) > 10
                # Psychometric metadata
                assert q["difficulty"] in ["easy", "medium", "hard"]
                assert q["bloom_level"] in ["remember", "understand", "apply", "analyze", "evaluate", "create"]

        # 6. Verify Anti-Cheating Isomorphic Answer-Key Synchronization
        key_res = await client.get(f"/api/exams/{exam['id']}/answer-key")
        assert key_res.status_code == 200
        keys = key_res.json()
        assert len(keys) == 3  # Answer key for Group A, Group B, Group C

        # Extract MCQ question from each group
        mcq_a = next(q for q in exam["groups"][0]["questions"] if q["question_type"] == "mcq")
        mcq_b = next(q for q in exam["groups"][1]["questions"] if q["question_type"] == "mcq")
        mcq_c = next(q for q in exam["groups"][2]["questions"] if q["question_type"] == "mcq")

        # Verify all 3 groups contain the same set of MCQ choices
        assert set(mcq_a["options"]) == set(mcq_b["options"]) == set(mcq_c["options"])

        # Verify that correct answer points to "O(n^2)" in all 3 groups even if option position shuffled
        assert "O(n^2)" in mcq_a["correct_answer"]
        assert "O(n^2)" in mcq_b["correct_answer"]
        assert "O(n^2)" in mcq_c["correct_answer"]

        # Verify question ordering variation across groups
        order_a = [q["question_text"] for q in exam["groups"][0]["questions"]]
        order_b = [q["question_text"] for q in exam["groups"][1]["questions"]]
        order_c = [q["question_text"] for q in exam["groups"][2]["questions"]]
        # Ordering is varied between Group A and Group B / C
        assert (order_a != order_b) or (order_a != order_c)


@pytest.mark.asyncio
async def test_duplicate_question_detection():
    """Verifies vector embedding similarity can detect duplicate questions."""
    embedding_svc = get_embedding_service()

    q1 = "What is the worst-case runtime complexity of the QuickSort algorithm?"
    q2 = "What is the worst-case runtime complexity of QuickSort algorithm?"
    q3 = "Explain how photosynthesis synthesizes glucose in plant chloroplasts."

    embeddings = embedding_svc.embed_batch([q1, q2, q3])
    emb1, emb2, emb3 = embeddings[0], embeddings[1], embeddings[2]

    # Cosine similarity between q1 and q2 (duplicates of same question)
    dot_1_2 = sum(a * b for a, b in zip(emb1, emb2))
    # Cosine similarity between q1 and q3 (completely different questions)
    dot_1_3 = sum(a * b for a, b in zip(emb1, emb3))

    assert dot_1_2 > 0.85, f"Expected duplicate similarity > 0.85, got {dot_1_2}"
    assert dot_1_3 < 0.40, f"Expected distinct similarity < 0.40, got {dot_1_3}"
