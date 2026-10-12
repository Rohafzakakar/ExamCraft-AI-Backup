import pytest
from httpx import AsyncClient, ASGITransport
from backend.app.main import app
from backend.app.core.config import settings
from backend.app.services.llm_session import (
    set_runtime_api_key,
    get_active_api_key,
    clear_runtime_api_key,
    is_llm_configured,
    mask_key,
)


@pytest.fixture(autouse=True)
def isolate_env_api_key():
    """Ensures test_llm_settings isolates runtime memory without interference from env."""
    original_env_key = settings.OPENROUTER_API_KEY
    settings.OPENROUTER_API_KEY = None
    yield
    settings.OPENROUTER_API_KEY = original_env_key


def test_mask_key_security():
    assert mask_key("") == ""
    assert mask_key("short") == "••••••••"
    key = "sk-or-v1-abcdef1234567890abcdef"
    masked = mask_key(key)
    assert "sk-or-v1" in masked
    assert "cdef" in masked
    assert "1234567890" not in masked
    assert masked.count("•") >= 8


def test_in_memory_key_lifecycle():
    clear_runtime_api_key("test_user_1")
    assert get_active_api_key("test_user_1") is None
    assert is_llm_configured("test_user_1") is False

    # Set key in memory
    set_runtime_api_key("sk-or-v1-samplemocktoken987654321", "test_user_1")
    assert get_active_api_key("test_user_1") == "sk-or-v1-samplemocktoken987654321"
    assert is_llm_configured("test_user_1") is True

    # Clear key from memory
    clear_runtime_api_key("test_user_1")
    assert get_active_api_key("test_user_1") is None
    assert is_llm_configured("test_user_1") is False


@pytest.mark.asyncio
async def test_llm_settings_endpoints():
    clear_runtime_api_key("default")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Initial status: not configured
        res = await client.get("/api/llm/status")
        assert res.status_code == 200
        data = res.json()
        assert data["provider"] == "openrouter"
        assert data["model"] == "openrouter/free"
        assert data["is_configured"] is False
        assert data["masked_key"] is None

        # 2. Set key via secure POST
        mock_key = "sk-or-v1-testsecretkeystoredinram123456"
        res = await client.post("/api/llm/key", json={"api_key": mock_key})
        assert res.status_code == 200
        data = res.json()
        assert data["is_configured"] is True
        assert data["masked_key"] is not None
        assert mock_key not in data["masked_key"]  # Full key NEVER exposed
        assert data["masked_key"].startswith("sk-or-v1")
        assert data["storage_source"] == "memory"

        # 3. Status confirms configured in memory
        res = await client.get("/api/llm/status")
        assert res.status_code == 200
        data = res.json()
        assert data["is_configured"] is True
        assert data["status_label"] == "OpenRouter key configured"

        # 4. Clear key via DELETE
        res = await client.delete("/api/llm/key")
        assert res.status_code == 200
        data = res.json()
        assert data["is_configured"] is False
        assert data["masked_key"] is None

        # 5. Status confirms unconfigured
        res = await client.get("/api/llm/status")
        assert res.status_code == 200
        assert res.json()["is_configured"] is False
