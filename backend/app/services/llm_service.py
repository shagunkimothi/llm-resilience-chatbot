"""LiteLLM wrapper with ordered API-key failover.

Keys are identified only as key_1, key_2, ... (plus last 4 chars for humans).
Real key values are never logged, returned, or included in error messages.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field

import litellm

from app.config import Settings, get_settings

logger = logging.getLogger(__name__)
litellm.suppress_debug_info = True

class EmptyResponseError(Exception):
    """The provider answered successfully but with an empty/whitespace-only reply."""


# Errors where trying a different key can help (provider overload, key-specific problems).
FALLBACK_ERRORS: tuple[type[Exception], ...] = (
    EmptyResponseError,
    litellm.exceptions.Timeout,
    litellm.exceptions.ServiceUnavailableError,
    litellm.exceptions.InternalServerError,
    litellm.exceptions.RateLimitError,
    litellm.exceptions.APIConnectionError,
    litellm.exceptions.AuthenticationError,
    litellm.exceptions.PermissionDeniedError,
)
# Gemini reports a bad key as HTTP 400, which LiteLLM maps to BadRequestError.
_KEY_PROBLEM_MARKERS = ("api key not valid", "api_key_invalid", "api key expired")


def key_id(index: int) -> str:
    return f"key_{index + 1}"


def mask(key: str) -> str:
    return f"...{key[-4:]}" if len(key) >= 4 else "...????"


def _scrub(text: str, keys: list[str]) -> str:
    for k in keys:
        if k:
            text = text.replace(k, f"<{mask(k)}>")
    return text


def is_fallback_error(exc: Exception) -> bool:
    if isinstance(exc, FALLBACK_ERRORS):
        return True
    if isinstance(exc, litellm.exceptions.BadRequestError):
        return any(m in str(exc).lower() for m in _KEY_PROBLEM_MARKERS)
    status = getattr(exc, "status_code", None)
    return isinstance(status, int) and status >= 500


@dataclass
class Attempt:
    key_id: str
    ok: bool
    latency_s: float
    error_type: str | None = None
    status_code: int | None = None
    error: str | None = None


@dataclass
class LLMResult:
    content: str
    key_id: str
    model: str
    prompt_tokens: int | None
    completion_tokens: int | None
    attempts: list[Attempt] = field(default_factory=list)


class LLMError(Exception):
    """Raised when no key produced a response. Message contains no key values.

    kind: "exhausted" (every key failed with a fallback-eligible error),
          "fatal"     (non-retryable provider error, e.g. 400/404),
          "no_keys"   (LLM_API_KEYS is empty).
    """

    def __init__(self, message: str, attempts: list[Attempt], kind: str = "exhausted"):
        super().__init__(message)
        self.attempts = attempts
        self.kind = kind


# ---- Failure simulation (X-Simulate-Failure header) -------------------------------
_SIMULATED_ERRORS: dict[int, type[Exception]] = {
    429: litellm.exceptions.RateLimitError,
    500: litellm.exceptions.InternalServerError,
    502: litellm.exceptions.BadGatewayError,
    503: litellm.exceptions.ServiceUnavailableError,
}


def parse_simulation(header: str | None) -> dict[str, int]:
    """'key_1=429,key_2=500' / '*=503' -> {'key_1': 429, ...}. Invalid entries are ignored."""
    plan: dict[str, int] = {}
    for part in (header or "").split(","):
        name, sep, status = part.strip().partition("=")
        name, status = name.strip(), status.strip()
        if not sep or not status.isdigit() or int(status) not in _SIMULATED_ERRORS:
            continue
        if name == "*" or re.fullmatch(r"key_\d+", name):
            plan[name] = int(status)
    return plan


def _simulated_error(plan: dict[str, int], kid: str, model: str) -> Exception | None:
    status = plan.get(kid, plan.get("*"))
    if status is None:
        return None
    return _SIMULATED_ERRORS[status](
        message=f"simulated {status} for {kid}", llm_provider="gemini", model=model
    )


def complete(
    messages: list[dict],
    *,
    settings: Settings | None = None,
    keys: list[str] | None = None,
    key_ids: list[str] | None = None,
    simulate: dict[str, int] | None = None,
) -> LLMResult:
    """Call the configured model, trying each key in order on transient/key errors.

    key_ids optionally labels a custom `keys` list (defaults to key_1, key_2, ...).
    simulate maps key_id (or "*") -> HTTP status; that key raises the matching LiteLLM
    exception inside this loop WITHOUT calling the provider.
    """
    s = settings or get_settings()
    keys = s.api_keys if keys is None else keys
    if not keys:
        raise LLMError("No API keys configured (LLM_API_KEYS is empty)", [], kind="no_keys")
    ids = key_ids or [key_id(i) for i in range(len(keys))]
    plan = simulate or {}

    attempts: list[Attempt] = []
    for i, key in enumerate(keys):
        kid = ids[i]
        t0 = time.perf_counter()
        try:
            sim = _simulated_error(plan, kid, s.llm_model)
            if sim is not None:
                raise sim
            r = litellm.completion(
                model=s.llm_model,
                messages=messages,
                api_key=key,
                timeout=s.llm_timeout,
                num_retries=s.llm_num_retries,
            )
            content = (r.choices[0].message.content or "").strip()
            if not content:
                raise EmptyResponseError(f"empty reply from provider for {kid}")
        except Exception as exc:  # noqa: BLE001 - classified below
            att = Attempt(
                key_id=kid,
                ok=False,
                latency_s=time.perf_counter() - t0,
                error_type=type(exc).__name__,
                status_code=getattr(exc, "status_code", None),
                error=_scrub(" ".join(str(exc).split()), keys)[:300],
            )
            attempts.append(att)
            if is_fallback_error(exc) and i < len(keys) - 1:
                logger.warning("LLM %s failed (%s %s); falling back to %s",
                               kid, att.error_type, att.status_code, ids[i + 1])
                continue
            if is_fallback_error(exc):
                raise LLMError(f"All {len(keys)} keys failed", attempts) from None
            raise LLMError(f"Non-retryable error on {kid}: {att.error_type}", attempts,
                           kind="fatal") from None

        attempts.append(Attempt(key_id=kid, ok=True, latency_s=time.perf_counter() - t0))
        usage = getattr(r, "usage", None)
        return LLMResult(
            content=content,
            key_id=kid,
            model=r.model,
            prompt_tokens=getattr(usage, "prompt_tokens", None),
            completion_tokens=getattr(usage, "completion_tokens", None),
            attempts=attempts,
        )

    raise LLMError(f"All {len(keys)} keys failed", attempts)  # unreachable, for type checkers
