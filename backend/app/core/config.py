import os
from typing import List, Literal, Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    PROJECT_NAME: str = "ExamCraft AI"
    VERSION: str = "1.0.0"
    API_V1_STR: str = "/api"
    ENVIRONMENT: str = "development"
    DEBUG: bool = True

    # Security & JWT
    SECRET_KEY: str = "examcraft_capstone_super_secret_jwt_key_2026_change_in_prod"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 days

    # Database: Zero-config SQLite async database
    DATABASE_URL: str = "sqlite+aiosqlite:///./examcraft.db"
    VECTOR_DB_TYPE: Literal["pgvector", "memory"] = "pgvector"

    # LLM Provider Configuration: OpenRouter with openrouter/free
    LLM_PROVIDER: str = "openrouter"
    OPENROUTER_API_KEY: Optional[str] = None
    OPENROUTER_MODEL: str = "openrouter/free"
    OPENROUTER_BASE_URL: str = "https://openrouter.ai/api/v1"

    # RAG & Generation Parameters
    CHUNK_SIZE_TOKENS: int = 400
    CHUNK_OVERLAP_TOKENS: int = 50
    RETRIEVAL_TOP_K: int = 5
    DUPLICATE_SIMILARITY_THRESHOLD: float = 0.82
    UPLOAD_MAX_BYTES: int = 25 * 1024 * 1024  # 25MB

    # CORS
    BACKEND_CORS_ORIGINS: List[str] = ["*"]

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

    def get_effective_database_url(self) -> str:
        """Returns the active zero-config SQLite async database URL."""
        return self.DATABASE_URL


settings = Settings()
