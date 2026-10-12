import os
import threading
from typing import Dict, Optional
from backend.app.core.config import settings

# Thread-safe in-memory storage for runtime API keys
# This dictionary is strictly held in process RAM and never written to disk or database.
_lock = threading.Lock()
_runtime_keys: Dict[str, str] = {}


def mask_key(key: str) -> str:
    """Masks an API key for safe display (e.g. sk-or-v1-••••••••ef12).
    Never exposes more than the prefix and last 4 characters.
    """
    if not key or not key.strip():
        return ""
    clean = key.strip()
    if len(clean) <= 8:
        return "••••••••"
    prefix = clean[:8] if clean.startswith("sk-or-") else clean[:4]
    suffix = clean[-4:]
    return f"{prefix}••••••••{suffix}"


def set_runtime_api_key(api_key: str, session_id: str = "default") -> None:
    """Stores the API key strictly in server memory for the runtime session."""
    with _lock:
        _runtime_keys[session_id] = api_key.strip()


def get_active_api_key(session_id: str = "default") -> Optional[str]:
    """Retrieves active key: checks in-memory runtime store first, then fallback env var."""
    with _lock:
        runtime_key = _runtime_keys.get(session_id)
        if runtime_key and runtime_key.strip():
            return runtime_key.strip()
        # Also check global default if session specific is not set
        if session_id != "default" and "default" in _runtime_keys:
            return _runtime_keys["default"].strip()

    # Fallback to environment variable if configured
    if settings.OPENROUTER_API_KEY and settings.OPENROUTER_API_KEY.strip():
        return settings.OPENROUTER_API_KEY.strip()

    return None


def clear_runtime_api_key(session_id: str = "default") -> None:
    """Evicts the API key from in-memory server storage."""
    with _lock:
        if session_id in _runtime_keys:
            del _runtime_keys[session_id]
        if "default" in _runtime_keys:
            del _runtime_keys["default"]


def is_llm_configured(session_id: str = "default") -> bool:
    """Returns True if a valid API key is present in memory or environment."""
    key = get_active_api_key(session_id)
    return bool(key and len(key) >= 8)


def get_llm_status(session_id: str = "default") -> dict:
    """Returns safe masked status information without ever leaking the full key."""
    active_key = get_active_api_key(session_id)
    is_set = bool(active_key and len(active_key) >= 8)
    
    with _lock:
        is_memory_session = bool(_runtime_keys.get(session_id) or _runtime_keys.get("default"))

    return {
        "provider": "openrouter",
        "model": settings.OPENROUTER_MODEL,
        "is_configured": is_set,
        "masked_key": mask_key(active_key) if is_set else None,
        "storage_source": "memory" if is_memory_session else ("environment" if is_set else "none"),
        "status_label": "OpenRouter key configured" if is_set else "No API key configured",
    }
