"""API tests. litellm.completion is mocked (see conftest.FakeLLM) - no real quota used."""
import sqlite3

import litellm
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings

from .conftest import FAKE_KEYS


def chat(client, session_id, message, headers=None, **extra):
    return client.post("/chat", json={"session_id": session_id, "message": message, **extra},
                       headers=headers or {})


def db_rows(env_path, session_id=None):
    con = sqlite3.connect(env_path / "db" / "app.db")
    try:
        if session_id is None:
            return con.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        return con.execute("SELECT COUNT(*) FROM messages WHERE session_id=?",
                           (session_id,)).fetchone()[0]
    finally:
        con.close()


def err(cls, msg="boom"):
    return cls(message=msg, llm_provider="gemini", model="gemini/gemini-3.5-flash-lite")


# ---------------------------------------------------------------- health
def test_health_ok(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "keys_configured": 2, "cache_enabled": True}


def test_health_503_without_keys(env, fake_llm, monkeypatch):
    monkeypatch.setenv("LLM_API_KEYS", "")
    get_settings.cache_clear()
    from app.main import app
    with TestClient(app) as c:
        r = c.get("/health")
    assert r.status_code == 503 and "detail" in r.json()


# ---------------------------------------------------------------- chat basics
def test_chat_live_response_shape(client, fake_llm):
    r = chat(client, "s1", "Hello there")
    assert r.status_code == 200
    body = r.json()
    assert body["session_id"] == "s1"
    assert isinstance(body["reply"], str) and body["reply"]
    md = body["metadata"]
    assert set(md) == {"resolution_source", "model", "latency_ms", "input_tokens",
                       "output_tokens", "key_id", "fallback_attempts"}
    assert md["resolution_source"] == "LIVE_INFERENCE"
    assert md["model"] == "gemini/gemini-3.5-flash-lite"  # LiteLLM name with provider prefix
    for f in ("latency_ms", "input_tokens", "output_tokens", "fallback_attempts"):
        assert type(md[f]) is int
    assert md["input_tokens"] == 20 and md["output_tokens"] == 5  # system + user
    assert md["key_id"] == "key_1" and md["fallback_attempts"] == 0
    # request options passed to LiteLLM
    call = fake_llm.calls[0]
    assert call["timeout"] == get_settings().llm_timeout and call["num_retries"] == 0


def test_multi_turn_sends_system_history_and_new_message(client, fake_llm):
    chat(client, "s1", "first question", system_prompt="Be brief.")
    chat(client, "s1", "second question")
    sent = fake_llm.calls[1]["messages"]
    assert sent == [
        {"role": "system", "content": "Be brief."},  # stored prompt reused
        {"role": "user", "content": "first question"},
        {"role": "assistant", "content": "echo: first question"},
        {"role": "user", "content": "second question"},
    ]


def test_default_system_prompt_used(client, fake_llm):
    chat(client, "s1", "hi")
    assert fake_llm.calls[0]["messages"][0] == {"role": "system", "content": "You are a test assistant."}


def test_session_isolation(client, fake_llm):
    chat(client, "a", "message for A")
    chat(client, "b", "message for B")
    assert fake_llm.calls[1]["messages"][1:] == [{"role": "user", "content": "message for B"}]
    a = client.get("/sessions/a/messages").json()["messages"]
    assert [m["content"] for m in a] == ["message for A", "echo: message for A"]


# ---------------------------------------------------------------- cache
def test_cache_hit_in_new_session(client, fake_llm):
    live = chat(client, "s1", "What is 2+2?").json()
    hit = chat(client, "s2", "What is 2+2?").json()
    assert len(fake_llm.calls) == 1  # second request never reached the provider
    lm, hm = live["metadata"], hit["metadata"]
    assert hm["resolution_source"] == "LLM_CACHE"
    assert hit["reply"] == live["reply"]
    assert (hm["input_tokens"], hm["output_tokens"]) == (lm["input_tokens"], lm["output_tokens"])
    assert hm["key_id"] is None and hm["fallback_attempts"] == 0
    assert hm["model"] == lm["model"] == "gemini/gemini-3.5-flash-lite"
    assert hm["latency_ms"] <= lm["latency_ms"]
    # cached exchange is still saved to the new session's history
    assert len(client.get("/sessions/s2/messages").json()["messages"]) == 2


def test_different_message_is_live(client, fake_llm):
    chat(client, "s1", "What is 2+2?")
    r = chat(client, "s2", "What is 3+3?").json()
    assert r["metadata"]["resolution_source"] == "LIVE_INFERENCE"
    assert len(fake_llm.calls) == 2


def test_cache_key_independent_of_api_key(client, fake_llm):
    fake_llm.fail_for[FAKE_KEYS[0]] = err(litellm.exceptions.ServiceUnavailableError)
    first = chat(client, "s1", "cache me").json()
    assert first["metadata"]["key_id"] == "key_2"
    fake_llm.fail_for.clear()
    hit = chat(client, "s2", "cache me").json()
    assert hit["metadata"]["resolution_source"] == "LLM_CACHE"
    assert hit["reply"] == first["reply"]


def test_cache_key_ignores_timeout_and_api_key():
    from litellm.caching.caching import Cache

    c = Cache(type="local", mode="default_off")
    m = [{"role": "user", "content": "x"}]
    base = c.get_cache_key(model="gemini/m", messages=m)
    assert c.get_cache_key(model="gemini/m", messages=m, api_key="a", timeout=1) == base


# ---------------------------------------------------------------- fallback + simulation
@pytest.mark.parametrize("status", [429, 500])
def test_simulated_key1_failure_falls_back_to_key2(client, fake_llm, status):
    r = chat(client, "s1", f"sim {status}", headers={"X-Simulate-Failure": f"key_1={status}"})
    assert r.status_code == 200
    md = r.json()["metadata"]
    assert md["key_id"] == "key_2" and md["fallback_attempts"] == 1
    assert md["resolution_source"] == "LIVE_INFERENCE"
    assert len(fake_llm.calls) == 1 and fake_llm.key_used(0) == "key_2"  # key_1 never called


def test_simulation_both_keys_fail(client, fake_llm, env):
    r = chat(client, "s1", "x", headers={"X-Simulate-Failure": "key_1=429,key_2=500"})
    assert r.status_code == 503 and r.json() == {"detail": "all providers unavailable"}
    assert fake_llm.calls == []


def test_simulation_wildcard_503_and_skips_cache(client, fake_llm, env):
    chat(client, "warm", "cached question")  # populate cache
    r = chat(client, "s9", "cached question", headers={"X-Simulate-Failure": "*=429"})
    assert r.status_code == 503
    assert r.json() == {"detail": "all providers unavailable"}
    assert db_rows(env, "s9") == 0
    assert client.get("/sessions/s9/messages").status_code == 404


def test_simulation_invalid_entries_ignored(client, fake_llm):
    r = chat(client, "s1", "x", headers={"X-Simulate-Failure": "key_1=418,bogus,key_9x=429"})
    assert r.status_code == 200 and r.json()["metadata"]["key_id"] == "key_1"


def test_simulation_header_ignored_when_disabled(env, fake_llm, monkeypatch):
    monkeypatch.setenv("ENABLE_FAILURE_SIMULATION", "false")
    get_settings.cache_clear()
    from app.main import app
    with TestClient(app) as c:
        r = chat(c, "s1", "x", headers={"X-Simulate-Failure": "*=429"})
    assert r.status_code == 200
    assert r.json()["metadata"]["key_id"] == "key_1"
    assert r.json()["metadata"]["fallback_attempts"] == 0


def test_real_error_fallback_and_exhaustion(client, fake_llm, env):
    fake_llm.fail_for[FAKE_KEYS[0]] = err(litellm.exceptions.RateLimitError)
    r = chat(client, "s1", "x")
    assert r.json()["metadata"]["key_id"] == "key_2"
    fake_llm.fail_for[FAKE_KEYS[1]] = err(litellm.exceptions.Timeout)
    r = chat(client, "s1", "y")
    assert r.status_code == 503 and r.json() == {"detail": "all providers unavailable"}
    assert db_rows(env, "s1") == 2  # only the first exchange


def test_non_retryable_error_does_not_fall_back(client, fake_llm, env):
    fake_llm.fail_for[FAKE_KEYS[0]] = err(litellm.exceptions.BadRequestError)
    r = chat(client, "s1", "x")
    assert r.status_code == 502 and "detail" in r.json()
    assert len(fake_llm.calls) == 1 and db_rows(env) == 0


def test_error_messages_never_contain_keys(client, fake_llm):
    fake_llm.fail_for[FAKE_KEYS[0]] = err(litellm.exceptions.RateLimitError, f"bad {FAKE_KEYS[0]}")
    fake_llm.fail_for[FAKE_KEYS[1]] = err(litellm.exceptions.RateLimitError, f"bad {FAKE_KEYS[1]}")
    r = chat(client, "s1", "x")
    assert r.status_code == 503
    assert not any(k in r.text for k in FAKE_KEYS)


def test_empty_reply_falls_back_to_next_key(client, fake_llm):
    def per_key(msgs):  # key_1 returns whitespace only, key_2 a real answer
        return "   " if fake_llm.calls[-1]["api_key"] == FAKE_KEYS[0] else "answer from key 2"

    fake_llm.reply_fn = per_key
    r = chat(client, "s1", "hi")
    assert r.status_code == 200
    body = r.json()
    assert body["reply"] == "answer from key 2"
    assert body["metadata"]["key_id"] == "key_2" and body["metadata"]["fallback_attempts"] == 1
    assert [fake_llm.key_used(i) for i in range(len(fake_llm.calls))] == ["key_1", "key_2"]


def test_empty_reply_on_all_keys_is_503_and_nothing_saved(client, fake_llm, env):
    fake_llm.reply_fn = lambda msgs: ""
    r = chat(client, "s1", "hi")
    assert r.status_code == 503 and r.json() == {"detail": "all providers unavailable"}
    assert len(fake_llm.calls) == 2 and db_rows(env) == 0
    assert client.get("/sessions/s1/messages").status_code == 404
    # an empty reply must never be cached either
    fake_llm.reply_fn = lambda msgs: "now it works"
    r = chat(client, "s2", "hi")
    assert r.json()["metadata"]["resolution_source"] == "LIVE_INFERENCE"


# ---------------------------------------------------------------- CORS
def test_allowed_origins_strip_whitespace_and_trailing_slash():
    from app.config import Settings

    s = Settings(_env_file=None,
                 allowed_origins=" http://localhost:5173/ , http://localhost:3000 ,, https://x.example// ,")
    assert s.origins == ["http://localhost:5173", "http://localhost:3000", "https://x.example"]


def _preflight(client, origin):
    return client.options("/chat", headers={
        "Origin": origin, "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-simulate-failure"})


def test_cors_preflight_allowed_origin(client):
    r = _preflight(client, "http://localhost:5173")
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "http://localhost:5173"
    allowed = r.headers["access-control-allow-headers"].lower()
    assert "content-type" in allowed and "x-simulate-failure" in allowed


def test_cors_preflight_disallowed_origin(client):
    r = _preflight(client, "https://evil.example")
    assert "access-control-allow-origin" not in r.headers


# ---------------------------------------------------------------- validation
@pytest.mark.parametrize("payload", [
    {"message": "hi"},                                   # missing session_id
    {"session_id": "s1"},                                # missing message
    {"session_id": "s1", "message": ""},                 # empty
    {"session_id": "s1", "message": "   \n\t "},         # whitespace only
    {"session_id": "s1", "message": "x" * 4001},         # too long
    {"session_id": "x" * 129, "message": "hi"},          # session_id too long
    {"session_id": "", "message": "hi"},                 # empty session_id
])
def test_chat_422(client, fake_llm, env, payload):
    r = client.post("/chat", json=payload)
    assert r.status_code == 422 and "detail" in r.json()
    assert fake_llm.calls == [] and db_rows(env) == 0


def test_message_4000_chars_after_strip_ok(client):
    assert chat(client, "s1", "  " + "x" * 4000 + "  ").status_code == 200


def test_malformed_json_422(client, fake_llm, env):
    r = client.post("/chat", content=b'{"session_id": "s1", "message": ',
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 422 and "detail" in r.json()
    assert db_rows(env) == 0


def test_unknown_session_404(client):
    r = client.get("/sessions/nope/messages")
    assert r.status_code == 404 and r.json() == {"detail": "session not found"}


def test_unexpected_error_returns_json_500(client, fake_llm, monkeypatch):
    from app import db

    def explode(*a, **k):
        raise RuntimeError("secret internals")

    monkeypatch.setattr(db, "save_exchange", explode)
    r = chat(client, "s1", "x")
    assert r.status_code == 500
    assert r.json() == {"detail": "internal server error"}
    assert "secret internals" not in r.text


# ---------------------------------------------------------------- history + persistence
def test_history_excludes_system_and_metadata_only_on_assistant(client):
    chat(client, "s1", "one", system_prompt="SYSTEM SECRET")
    chat(client, "s1", "two")
    body = client.get("/sessions/s1/messages").json()
    assert body["session_id"] == "s1"
    msgs = body["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant"]
    assert [m["content"] for m in msgs[::2]] == ["one", "two"]
    assert all("SYSTEM SECRET" not in m["content"] for m in msgs)
    assert all("metadata" not in m for m in msgs if m["role"] == "user")
    assert all(m["metadata"]["resolution_source"] for m in msgs if m["role"] == "assistant")


def test_db_schema(client, env):
    chat(client, "s1", "hi")
    con = sqlite3.connect(env / "db" / "app.db")
    cols = {r[1]: (r[2], r[3], r[5]) for r in con.execute("PRAGMA table_info(messages)")}
    ddl = con.execute("SELECT sql FROM sqlite_master WHERE name='messages'").fetchone()[0]
    assert "AUTOINCREMENT" in ddl.upper()
    assert cols["id"][0] == "INTEGER" and cols["id"][2] == 1
    cols["id"] = ("INTEGER", 0, 1)  # PK nullability is irrelevant
    assert cols == {"id": ("INTEGER", 0, 1), "session_id": ("TEXT", 1, 0), "role": ("TEXT", 1, 0),
                    "content": ("TEXT", 1, 0), "metadata": ("TEXT", 0, 0),
                    "created_at": ("TEXT", 1, 0)}
    idx = [r for r in con.execute("PRAGMA index_list(messages)")]
    cols_in_idx = [[c[2] for c in con.execute(f"PRAGMA index_info({i[1]})")] for i in idx]
    assert ["session_id", "id"] in cols_in_idx
    user_meta, created = con.execute(
        "SELECT metadata, created_at FROM messages WHERE role='user'").fetchone()
    assert user_meta is None and "+00:00" in created
    con.close()


def test_restart_persistence(env, fake_llm):
    from app.main import app
    with TestClient(app) as c:
        chat(c, "persist", "remember me")
    with TestClient(app) as c:  # lifespan reconfigures the DB on the same file
        msgs = c.get("/sessions/persist/messages").json()["messages"]
        assert [m["content"] for m in msgs] == ["remember me", "echo: remember me"]
        chat(c, "persist", "and again")
    assert len(fake_llm.calls[-1]["messages"]) == 4  # system + 2 history + new
