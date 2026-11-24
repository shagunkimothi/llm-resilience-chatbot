from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app import db
from app.config import get_settings
from app.schemas import HealthResponse
from app.services import cache_service

router = APIRouter()


@router.get("/health", response_model=HealthResponse, responses={503: {"description": "Not ready"}})
def health():
    keys = len(get_settings().api_keys)
    if not db.ping():
        return JSONResponse(status_code=503, content={"detail": "database unavailable"})
    if keys == 0:
        return JSONResponse(status_code=503, content={"detail": "no API keys configured"})
    if not cache_service.cache_enabled():
        return JSONResponse(status_code=503, content={"detail": "cache not initialized"})
    return HealthResponse(status="ok", keys_configured=keys, cache_enabled=True)
