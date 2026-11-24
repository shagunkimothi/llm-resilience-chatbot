"""POST /chat: system + history + new message -> cache -> key loop -> save -> respond."""
import logging
import time

from fastapi import APIRouter, Header, HTTPException

from app import db
from app.config import get_settings
from app.schemas import ChatMetadata, ChatRequest, ChatResponse
from app.services import cache_service, llm_service
from app.services.llm_service import LLMError

logger = logging.getLogger(__name__)
router = APIRouter()


def build_messages(session_id: str, user_text: str, system_prompt: str) -> list[dict]:
    history = [{"role": m.role, "content": m.content} for m in db.get_history(session_id)]
    return [{"role": "system", "content": system_prompt}, *history,
            {"role": "user", "content": user_text}]


@router.post("/chat", response_model=ChatResponse,
             responses={503: {"description": "All providers unavailable"}})
def chat(req: ChatRequest, x_simulate_failure: str | None = Header(default=None)):
    t0 = time.perf_counter()
    s = get_settings()

    simulate = llm_service.parse_simulation(x_simulate_failure) if s.enable_failure_simulation else {}
    system_prompt = req.system_prompt or db.get_system_prompt(req.session_id) or s.default_system_prompt
    messages = build_messages(req.session_id, req.message, system_prompt)

    cached = None if simulate else cache_service.get_cached(s.llm_model, messages)
    if cached:
        reply, model = cached["reply"], cached["model"]
        input_tokens, output_tokens = cached["input_tokens"], cached["output_tokens"]
        source, kid, fallback_attempts = "LLM_CACHE", None, 0
    else:
        try:
            result = llm_service.complete(messages, settings=s, simulate=simulate)
        except LLMError as e:
            logger.warning("chat failed: kind=%s attempts=%s", e.kind,
                           [(a.key_id, a.error_type, a.status_code) for a in e.attempts])
            # Every failure (exhausted, fatal 400/404, no keys) maps to the same 503; the
            # kind is only logged. Nothing is saved for a failed exchange.
            raise HTTPException(status_code=503, detail="all providers unavailable") from None
        # Report the configured LiteLLM model name (with provider prefix, e.g.
        # "gemini/gemini-3.5-flash-lite"); response.model drops the prefix.
        # Empty replies never get here: llm_service treats them as a failed attempt.
        reply, model = result.content, s.llm_model
        input_tokens, output_tokens = result.prompt_tokens or 0, result.completion_tokens or 0
        source, kid, fallback_attempts = "LIVE_INFERENCE", result.key_id, len(result.attempts) - 1
        cache_service.store(s.llm_model, messages, {
            "reply": reply, "model": model,
            "input_tokens": input_tokens, "output_tokens": output_tokens,
        })

    metadata = ChatMetadata(
        resolution_source=source, model=model,
        latency_ms=int(round((time.perf_counter() - t0) * 1000)),
        input_tokens=input_tokens, output_tokens=output_tokens,
        key_id=kid, fallback_attempts=fallback_attempts,
    )
    db.save_exchange(req.session_id, req.message, reply, metadata.model_dump(),
                     system_prompt=req.system_prompt)
    return ChatResponse(session_id=req.session_id, reply=reply, metadata=metadata)
