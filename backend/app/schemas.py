from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, StringConstraints, field_validator

MessageText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]


class ChatRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    message: MessageText
    system_prompt: str | None = None

    @field_validator("system_prompt")
    @classmethod
    def _blank_prompt_is_none(cls, v: str | None) -> str | None:
        v = v.strip() if v is not None else None
        return v or None


class ChatMetadata(BaseModel):
    resolution_source: Literal["LIVE_INFERENCE", "LLM_CACHE"]
    model: str
    latency_ms: int
    input_tokens: int
    output_tokens: int
    key_id: str | None
    fallback_attempts: int


class ChatResponse(BaseModel):
    session_id: str
    reply: str
    metadata: ChatMetadata


class HealthResponse(BaseModel):
    status: Literal["ok"]
    keys_configured: int
    cache_enabled: bool


class HistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    metadata: dict[str, Any] | None = None


class HistoryResponse(BaseModel):
    session_id: str
    messages: list[HistoryMessage]
