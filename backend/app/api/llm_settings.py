import time
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
import httpx

from backend.app.core.config import settings
from backend.app.services.llm_session import (
    set_runtime_api_key,
    get_active_api_key,
    clear_runtime_api_key,
    get_llm_status,
)
from backend.app.api.auth import get_current_user_optional
from backend.app.models.user import User

router = APIRouter(prefix="/llm", tags=["LLM Settings"])


class SetApiKeyRequest(BaseModel):
    api_key: str = Field(..., min_length=10, max_length=256, description="OpenRouter API key")


class LLMStatusResponse(BaseModel):
    provider: str
    model: str
    is_configured: bool
    masked_key: Optional[str] = None
    storage_source: str
    status_label: str


class ConnectionTestResponse(BaseModel):
    success: bool
    status_code: Optional[int] = None
    message: str
    latency_ms: Optional[float] = None
    provider: str = "openrouter"
    model: str


def _get_session_id(current_user: Optional[User]) -> str:
    """Returns user ID if authenticated, else default session identifier."""
    if current_user and current_user.id:
        return current_user.id
    return "default"


@router.get("/status", response_model=LLMStatusResponse)
async def get_status(current_user: Optional[User] = Depends(get_current_user_optional)):
    """Returns safe masked configuration status for OpenRouter in server memory.
    Never exposes the full key.
    """
    session_id = _get_session_id(current_user)
    return get_llm_status(session_id)


@router.post("/key", response_model=LLMStatusResponse)
async def set_key(
    payload: SetApiKeyRequest,
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """Securely receives the OpenRouter API key and saves it strictly in
    server memory for the active session. Never persists to disk or DB.
    """
    raw_key = payload.api_key.strip()
    if not raw_key or len(raw_key) < 10:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid API key format. Please provide a valid OpenRouter API key.",
        )

    session_id = _get_session_id(current_user)
    set_runtime_api_key(raw_key, session_id=session_id)

    return get_llm_status(session_id)


@router.delete("/key", response_model=LLMStatusResponse)
async def clear_key(current_user: Optional[User] = Depends(get_current_user_optional)):
    """Evicts the API key from active server memory."""
    session_id = _get_session_id(current_user)
    clear_runtime_api_key(session_id=session_id)
    return get_llm_status(session_id)


@router.post("/test-connection", response_model=ConnectionTestResponse)
async def test_connection(current_user: Optional[User] = Depends(get_current_user_optional)):
    """Verifies authentication with OpenRouter using the server-memory key.
    Does not expose or echo the key in the response or logs.
    """
    session_id = _get_session_id(current_user)
    active_key = get_active_api_key(session_id)

    if not active_key:
        return ConnectionTestResponse(
            success=False,
            message="No OpenRouter API key is configured. Please set a key first.",
            model=settings.OPENROUTER_MODEL,
        )

    start_time = time.perf_counter()
    headers = {
        "Authorization": f"Bearer {active_key}",
        "HTTP-Referer": "https://examcraft.ai",
        "X-Title": "ExamCraft AI",
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Query OpenRouter key auth verification endpoint
            response = await client.get(
                f"{settings.OPENROUTER_BASE_URL}/auth/key",
                headers=headers,
            )

        latency = round((time.perf_counter() - start_time) * 1000, 1)

        if response.status_code == 200:
            return ConnectionTestResponse(
                success=True,
                status_code=200,
                message=f"OpenRouter connection verified successfully ({latency}ms). Ready for examination generation.",
                latency_ms=latency,
                model=settings.OPENROUTER_MODEL,
            )
        elif response.status_code == 401:
            return ConnectionTestResponse(
                success=False,
                status_code=401,
                message="OpenRouter authentication failed (401 Unauthorized). The provided API key is invalid or expired.",
                latency_ms=latency,
                model=settings.OPENROUTER_MODEL,
            )
        else:
            return ConnectionTestResponse(
                success=False,
                status_code=response.status_code,
                message=f"OpenRouter responded with HTTP {response.status_code}. Please check your account balance or key permissions.",
                latency_ms=latency,
                model=settings.OPENROUTER_MODEL,
            )
    except httpx.TimeoutException:
        return ConnectionTestResponse(
            success=False,
            message="Connection to OpenRouter timed out (10s limit). Please check your internet connectivity.",
            model=settings.OPENROUTER_MODEL,
        )
    except Exception as e:
        return ConnectionTestResponse(
            success=False,
            message=f"Network error while connecting to OpenRouter: {str(e)}",
            model=settings.OPENROUTER_MODEL,
        )
