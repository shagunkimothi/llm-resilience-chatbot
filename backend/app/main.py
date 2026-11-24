import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import db
from app.config import get_settings
from app.routes import chat, health, sessions
from app.services import cache_service

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    db.configure_db(s.database_url)
    db.init_db()
    cache_service.init_cache(s)
    logger.info("startup: model=%s keys=%d", s.llm_model, len(s.api_keys))
    try:
        yield
    finally:
        cache_service.close_cache()
        db.dispose_db()


app = FastAPI(
    title="LLM Resilience Chatbot",
    description="AI chatbot with key failover and response caching",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Simulate-Failure"],
)


@app.exception_handler(Exception)
async def unhandled_exception(request: Request, exc: Exception):
    # Log the type only: exception text could contain provider details.
    logger.error("unhandled error on %s %s: %s", request.method, request.url.path,
                 type(exc).__name__)
    return JSONResponse(status_code=500, content={"detail": "internal server error"})


@app.get("/")
def root():
    return {"message": "LLM Resilience Chatbot API is running!"}


app.include_router(health.router)
app.include_router(chat.router)
app.include_router(sessions.router)
