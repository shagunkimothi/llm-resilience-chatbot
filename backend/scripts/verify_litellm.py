"""Standalone LiteLLM verification: per-key calls + key-fallback behaviour.

Never prints API keys (only key_N and last 4 chars).
Run from backend/:  python scripts/verify_litellm.py

Logic checks (does fallback happen?) are separated from provider outcomes
(did Gemini answer in time?), because the provider currently has intermittent
503s / timeouts that are outside our control.
"""
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # so 'app' imports work

import litellm
from app.config import get_settings
from app.services import llm_service
from app.services.llm_service import LLMError, complete, mask

PROMPT = [{"role": "user", "content": "Reply with just the word: pong"}]
KEY_TEST_TRIES = 3  # bounded tries for the per-key connectivity check only
s = get_settings()
keys = s.api_keys
results: list[tuple[str, bool]] = []


def show_attempts(attempts):
    for a in attempts:
        extra = "" if a.ok else f"  {a.error_type} status={a.status_code}  {(a.error or '')[:110]}"
        print(f"     {a.key_id}: {'OK  ' if a.ok else 'FAIL'} {a.latency_s:5.1f}s{extra}")


def run(**kw):
    """Returns (result_or_None, attempts)."""
    try:
        r = complete(PROMPT, **kw)
        return r, r.attempts
    except LLMError as e:
        return None, e.attempts


def check(name: str, passed: bool, note: str = ""):
    results.append((name, passed))
    print(f"  => {'PASS' if passed else 'FAIL'}: {name}{'  (' + note + ')' if note else ''}\n")


def provider_note(attempts, kid="key_2"):
    a = next((a for a in attempts if a.key_id == kid), None)
    if a is None:
        return f"{kid} not tried"
    return f"{kid} real call OK" if a.ok else f"{kid} real call: provider {a.error_type} {a.status_code}"


def failing_for(target_key: str, exc: Exception):
    """Wrap litellm.completion so calls using target_key raise exc; others go to the real API."""
    real = litellm.completion

    def fake(*args, **kwargs):
        if kwargs.get("api_key") == target_key:
            raise exc
        return real(*args, **kwargs)

    return mock.patch.object(llm_service.litellm, "completion", side_effect=fake)


def err(cls, msg):
    return cls(message=msg, llm_provider="gemini", model=s.llm_model)


print(f"model={s.llm_model}  timeout={s.llm_timeout}s  num_retries(per key)={s.llm_num_retries}")
print("keys: " + ", ".join(f"key_{i + 1} ({mask(k)})" for i, k in enumerate(keys)) + "\n")
if len(keys) < 2:
    sys.exit("Need 2 keys in LLM_API_KEYS")

# 1-2. Each key individually, real API, up to KEY_TEST_TRIES tries
for i, k in enumerate(keys):
    kid = f"key_{i + 1}"
    print(f"[{i + 1}] {kid} alone, real call (up to {KEY_TEST_TRIES} tries)")
    r = None
    for t in range(1, KEY_TEST_TRIES + 1):
        r, attempts = run(keys=[k], key_ids=[kid])
        print(f"   try {t}:")
        show_attempts(attempts)
        if r:
            print(f"     reply={r.content!r} model={r.model} in={r.prompt_tokens} out={r.completion_tokens}")
            break
    check(f"{kid} generates a response", bool(r and r.content), f"succeeded on try {t}" if r else "")

# 3. Real fallback: invalid placeholder key first, then real key_2
print("[3] invalid placeholder key, then key_2 (real calls)")
r, attempts = run(keys=["invalid-test-key-0000", keys[1]], key_ids=["bad_key", "key_2"])
show_attempts(attempts)
check("invalid key triggers fallback to key_2",
      len(attempts) == 2 and not attempts[0].ok, provider_note(attempts))

# 4-6. Simulated transient errors on key_1 -> real call on key_2
simulated = [
    ("503 ServiceUnavailable", err(litellm.exceptions.ServiceUnavailableError, "simulated high demand")),
    ("408 Timeout", err(litellm.exceptions.Timeout, "simulated read timeout")),
    ("429 RateLimit", err(litellm.exceptions.RateLimitError, "simulated quota")),
]
for n, (label, exc) in enumerate(simulated, start=4):
    print(f"[{n}] simulated {label} on key_1, real call on key_2")
    with failing_for(keys[0], exc):
        r, attempts = run()
    show_attempts(attempts)
    check(f"{label} on key_1 triggers fallback to key_2",
          len(attempts) == 2 and attempts[1].key_id == "key_2", provider_note(attempts))

# 7. Non-retryable error must NOT fall back (no wasted calls)
print("[7] simulated 400 BadRequest on key_1 (must not fall back)")
with failing_for(keys[0], err(litellm.exceptions.BadRequestError, "simulated bad request")):
    r, attempts = run()
show_attempts(attempts)
check("400 BadRequest does not fall back", r is None and len(attempts) == 1)

# 8. Both keys fail -> clean LLMError, bounded attempts, no key leak
print("[8] simulated 503 on both keys")
boom = err(litellm.exceptions.ServiceUnavailableError, "simulated outage")
with mock.patch.object(llm_service.litellm, "completion", side_effect=boom):
    try:
        complete(PROMPT)
        check("all keys failing -> LLMError after exactly 2 attempts", False)
    except LLMError as e:
        show_attempts(e.attempts)
        leaked = any(k in str(e) or any(k in (a.error or "") for a in e.attempts) for k in keys)
        print(f"     error={e!s}  key values leaked={leaked}")
        check("all keys failing -> LLMError after exactly 2 attempts", len(e.attempts) == 2 and not leaked)

passed = sum(p for _, p in results)
print(f"SUMMARY: {passed}/{len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
