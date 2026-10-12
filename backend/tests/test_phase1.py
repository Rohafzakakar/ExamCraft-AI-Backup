import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from backend.app.core.config import settings
from backend.app.core.database import Base, engine
from backend.app.core.security import (
    create_access_token,
    decode_access_token,
    get_password_hash,
    verify_password,
)
from backend.app.main import app
from backend.app.schemas.exam import DifficultyDistribution, QuestionTypesDistribution
from backend.app.services.vector_store import PgVectorRepository


@pytest_asyncio.fixture(autouse=True)
async def prepare_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest.mark.asyncio
async def test_config_and_settings():
    assert settings.PROJECT_NAME == "ExamCraft AI"
    assert settings.API_V1_STR == "/api"
    assert settings.LLM_PROVIDER in ["openrouter", "gemini", "openai", "ollama"]
    assert settings.DUPLICATE_SIMILARITY_THRESHOLD == 0.82


@pytest.mark.asyncio
async def test_security_passwords_and_tokens():
    raw_pwd = "TeacherPassword123!"
    hashed = get_password_hash(raw_pwd)
    assert hashed != raw_pwd
    assert verify_password(raw_pwd, hashed) is True
    assert verify_password("WrongPassword", hashed) is False

    token = create_access_token(subject="user_12345")
    payload = decode_access_token(token)
    assert payload is not None
    assert payload["sub"] == "user_12345"


@pytest.mark.asyncio
async def test_schemas_validation():
    valid_diff = DifficultyDistribution(easy=40, medium=40, hard=20)
    assert valid_diff.easy + valid_diff.medium + valid_diff.hard == 100

    with pytest.raises(ValueError):
        DifficultyDistribution(easy=50, medium=50, hard=10)

    valid_qtypes = QuestionTypesDistribution(mcq=5, true_false=3, short_answer=2)
    assert valid_qtypes.mcq == 5

    with pytest.raises(ValueError):
        QuestionTypesDistribution(mcq=0, true_false=0, fill_blank=0, short_answer=0, essay=0)


@pytest.mark.asyncio
async def test_vector_repository_abstraction():
    repo = PgVectorRepository()
    vec1 = [1.0, 0.0, 0.0]
    vec2 = [1.0, 0.0, 0.0]
    vec3 = [0.0, 1.0, 0.0]

    sim_identical = repo.compute_cosine_similarity(vec1, vec2)
    sim_orthogonal = repo.compute_cosine_similarity(vec1, vec3)

    assert pytest.approx(sim_identical, 0.01) == 1.0
    assert pytest.approx(sim_orthogonal, 0.01) == 0.0


@pytest.mark.asyncio
async def test_api_health_and_guest_endpoints():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/health")
        assert res.status_code == 200
        data = res.json()
        assert data["status"] in ["healthy", "degraded"]
        assert data["app_name"] == "ExamCraft AI"

        guest_res = await client.post("/api/auth/guest")
        assert guest_res.status_code == 200
        guest_data = guest_res.json()
        assert guest_data["session_id"].startswith("guest_")


@pytest.mark.asyncio
async def test_api_register_and_login():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        email = "professor.kakar@university.edu"
        password = "SecurePassword2026!"
        reg_res = await client.post(
            "/api/auth/register",
            json={
                "email": email,
                "password": password,
                "full_name": "Prof. Madina Kakar",
                "institution": "Faculty of Computer Science",
            },
        )
        assert reg_res.status_code == 201

        login_res = await client.post(
            "/api/auth/login",
            json={"email": email, "password": password},
        )
        assert login_res.status_code == 200
        token = login_res.json()["access_token"]

        me_res = await client.get(
            "/api/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert me_res.status_code == 200
        assert me_res.json()["full_name"] == "Prof. Madina Kakar"
