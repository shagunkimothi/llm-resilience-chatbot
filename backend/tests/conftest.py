"""Test fixtures: fake LLM (no real quota), temp SQLite DB and temp cache per test."""
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.services import llm_service

FAKE_KEYS = ["fake-test-key-1111", "fake-test-key-2222"]


class FakeLLM:
    """Stands in for litellm.completion. Records calls; can fail per api_key."""

    def __init__(self):
        self.calls: list[dict] = []
        self.fail_for: dict[str, Exception] = {}
        self.reply_fn = lambda messages: f"echo: {messages[-1]['content']}"

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        exc = self.fail_for.get(kwargs.get("api_key"))
        if exc is not None:
            raise exc
        msgs = kwargs["messages"]
        return SimpleNamespace(
            model="gemini-3.5-flash-lite",
            choices=[SimpleNamespace(message=SimpleNamespace(content=self.reply_fn(msgs)))],
            usage=SimpleNamespace(prompt_tokens=10 * len(msgs), completion_tokens=5),
        )

    def key_used(self, i: int) -> str:
        return f"key_{FAKE_KEYS.index(self.calls[i]['api_key']) + 1}"


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Isolated settings: fake keys, temp DB/cache, simulation enabled."""
    monkeypatch.setenv("LLM_API_KEYS", ",".join(FAKE_KEYS))
    monkeypatch.setenv("LLM_MODEL", "gemini/gemini-3.5-flash-lite")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(tmp_path / 'db' / 'app.db').as_posix()}")
    monkeypatch.setenv("CACHE_TYPE", "disk")
    monkeypatch.setenv("CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("ENABLE_FAILURE_SIMULATION", "true")
    monkeypatch.setenv("DEFAULT_SYSTEM_PROMPT", "You are a test assistant.")
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()


@pytest.fixture
def fake_llm(monkeypatch):
    fake = FakeLLM()
    monkeypatch.setattr(llm_service.litellm, "completion", fake)
    return fake


@pytest.fixture
def client(env, fake_llm):
    from app.main import app

    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
