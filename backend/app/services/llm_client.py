import json
import re
import asyncio
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional
import httpx

from backend.app.core.config import settings
from backend.app.services.llm_session import get_active_api_key


class LLMProviderInterface(ABC):
    """Abstract interface for LLM provider adapters."""

    @abstractmethod
    async def generate_chat(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.2,
        max_tokens: int = 4000,
        response_format: Optional[Dict[str, str]] = None,
        session_id: str = "default",
    ) -> str:
        """Generates chat completion string from prompt messages."""
        pass


def extract_json_from_llm_response(raw_text: str) -> Any:
    """Robustly extracts and parses JSON data from LLM responses.
    Handles markdown code blocks, conversational preambles, and trailing artifacts.
    """
    if not raw_text or not raw_text.strip():
        raise ValueError("Empty response received from LLM")

    cleaned = raw_text.strip()

    # Case 1: Markdown JSON block: ```json ... ``` or ``` ... ```
    json_block_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned, re.IGNORECASE)
    if json_block_match:
        extracted = json_block_match.group(1).strip()
        try:
            return json.loads(extracted)
        except json.JSONDecodeError:
            pass

    # Case 2: Direct raw JSON string (object or array)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # Case 3: Locate outermost JSON array [ ... ] or object { ... }
    # Try finding outermost object
    first_brace = cleaned.find("{")
    last_brace = cleaned.rfind("}")
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        candidate = cleaned[first_brace : last_brace + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            # Attempt to fix trailing commas
            fixed = re.sub(r",\s*([\]}])", r"\1", candidate)
            try:
                return json.loads(fixed)
            except json.JSONDecodeError:
                pass

    # Try finding outermost array
    first_bracket = cleaned.find("[")
    last_bracket = cleaned.rfind("]")
    if first_bracket != -1 and last_bracket != -1 and last_bracket > first_bracket:
        candidate = cleaned[first_bracket : last_bracket + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            fixed = re.sub(r",\s*([\]}])", r"\1", candidate)
            try:
                return json.loads(fixed)
            except json.JSONDecodeError:
                pass

    raise ValueError(f"Could not parse valid JSON from LLM output: {cleaned[:200]}...")


class OpenRouterClient(LLMProviderInterface):
    """OpenRouter Client with exponential backoff, JSON parsing, and zero key logging."""

    def __init__(
        self,
        model: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout_seconds: float = 65.0,
        max_retries: int = 3,
    ):
        self.model = model or settings.OPENROUTER_MODEL
        self.base_url = (base_url or settings.OPENROUTER_BASE_URL).rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.max_retries = max_retries

    async def generate_chat(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.2,
        max_tokens: int = 4000,
        response_format: Optional[Dict[str, str]] = None,
        session_id: str = "default",
    ) -> str:
        api_key = get_active_api_key(session_id)
        if not api_key:
            raise RuntimeError(
                "No OpenRouter API key configured in server memory. Please enter your API key in LLM Settings."
            )

        endpoint = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "HTTP-Referer": "https://examcraft.ai",
            "X-Title": "ExamCraft AI",
            "Content-Type": "application/json",
        }

        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        if response_format:
            payload["response_format"] = response_format

        last_error = None
        for attempt in range(1, self.max_retries + 1):
            try:
                async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                    response = await client.post(endpoint, headers=headers, json=payload)

                if response.status_code == 200:
                    data = response.json()
                    choices = data.get("choices", [])
                    if not choices:
                        raise ValueError("OpenRouter returned empty choices array")
                    content = choices[0].get("message", {}).get("content", "")
                    if not content:
                        raise ValueError("OpenRouter returned empty message content")
                    return content

                elif response.status_code == 429:
                    # Rate limit or quota exceeded
                    last_error = f"OpenRouter rate limit / 429 on attempt {attempt}: {response.text[:200]}"
                    if attempt < self.max_retries:
                        await asyncio.sleep(1.5 * attempt)
                        continue

                elif response.status_code in [500, 502, 503, 504]:
                    # Server side transient issue
                    last_error = f"OpenRouter server error {response.status_code} on attempt {attempt}"
                    if attempt < self.max_retries:
                        await asyncio.sleep(1.5 * attempt)
                        continue
                else:
                    # Non-retryable error (e.g., 400, 401, 403)
                    raise RuntimeError(
                        f"OpenRouter API error (HTTP {response.status_code}): {response.text[:250]}"
                    )

            except httpx.TimeoutException as e:
                last_error = f"OpenRouter request timed out ({self.timeout_seconds}s)"
                if attempt < self.max_retries:
                    await asyncio.sleep(1.0 * attempt)
                    continue
            except httpx.RequestError as e:
                last_error = f"OpenRouter network connection error: {str(e)}"
                if attempt < self.max_retries:
                    await asyncio.sleep(1.0 * attempt)
                    continue

        raise RuntimeError(f"OpenRouter generation failed after {self.max_retries} attempts: {last_error}")


_default_llm_client: Optional[LLMProviderInterface] = None


def get_llm_client() -> LLMProviderInterface:
    """Factory returning the configured active LLM provider client."""
    global _default_llm_client
    if _default_llm_client is None:
        _default_llm_client = OpenRouterClient()
    return _default_llm_client


def set_llm_client_override(client: Optional[LLMProviderInterface]) -> None:
    """Allows test fixtures to inject mock LLM client implementations."""
    global _default_llm_client
    _default_llm_client = client
