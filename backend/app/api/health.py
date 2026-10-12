from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from backend.app.core.config import settings
from backend.app.core.database import get_db
from backend.app.services.vector_store import get_vector_repository
from backend.app.services.llm_session import is_llm_configured

router = APIRouter(prefix="/health", tags=["Health & Status"])


@router.get("")
async def get_health(db: AsyncSession = Depends(get_db)):
    """Health check endpoint validating database connectivity and system services."""
    db_status = "ok"
    try:
        await db.execute(text("SELECT 1"))
    except Exception as e:
        db_status = f"error: {str(e)}"

    vector_repo = get_vector_repository()

    return {
        "status": "healthy" if db_status == "ok" else "degraded",
        "app_name": settings.PROJECT_NAME,
        "version": settings.VERSION,
        "environment": settings.ENVIRONMENT,
        "database": db_status,
        "vector_store": {
            "type": settings.VECTOR_DB_TYPE,
            "status": "active" if vector_repo else "uninitialized",
        },
        "llm_provider": {
            "provider": "openrouter",
            "model": settings.OPENROUTER_MODEL,
            "configured": is_llm_configured(),
        },
    }
