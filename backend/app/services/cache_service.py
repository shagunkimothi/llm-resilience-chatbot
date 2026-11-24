"""Response cache built on LiteLLM's Cache object.

LiteLLM 1.110.3 removed the built-in "disk" cache type, so for CACHE_TYPE=disk we keep
litellm.Cache (its key hashing and API) and plug in a small diskcache-backed storage
backend - the same thing older LiteLLM versions did internally.

The cache key is computed from (model, messages) ONLY, so it never depends on which
API key answered, the timeout, or any other request option.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import diskcache
import litellm
from litellm.caching.base_cache import BaseCache
from litellm.caching.caching import Cache

from app.config import Settings

logger = logging.getLogger(__name__)


class DiskBackend(BaseCache):
    """Persistent key/value storage for litellm.Cache using diskcache."""

    def __init__(self, directory: str):
        super().__init__()
        Path(directory).mkdir(parents=True, exist_ok=True)
        self._dc = diskcache.Cache(directory)

    def set_cache(self, key, value, **kwargs):
        self._dc.set(key, value, expire=kwargs.get("ttl"))

    async def async_set_cache(self, key, value, **kwargs):
        self.set_cache(key, value, **kwargs)

    def get_cache(self, key, **kwargs):
        return self._dc.get(key)

    async def async_get_cache(self, key, **kwargs):
        return self.get_cache(key, **kwargs)

    async def async_set_cache_pipeline(self, cache_list, **kwargs):
        for key, value in cache_list:
            self.set_cache(key, value, **kwargs)

    async def batch_cache_write(self, key, value, **kwargs):
        self.set_cache(key, value, **kwargs)

    def flush_cache(self):
        self._dc.clear()

    async def disconnect(self):
        self._dc.close()

    def close(self):
        self._dc.close()


def init_cache(settings: Settings) -> Cache:
    """Create the cache and install it as litellm.cache.

    mode="default_off": litellm.completion() never reads/writes the cache by itself;
    this module does it explicitly with a key we control.
    """
    close_cache()
    cache = Cache(type="local", mode="default_off")
    if settings.cache_type.lower() == "disk":
        cache.cache = DiskBackend(settings.cache_dir)
    elif settings.cache_type.lower() != "local":
        raise ValueError(f"Unsupported CACHE_TYPE {settings.cache_type!r} (use 'disk' or 'local')")
    litellm.cache = cache
    logger.info("LLM cache enabled: type=%s", settings.cache_type)
    return cache


def close_cache() -> None:
    cache = getattr(litellm, "cache", None)
    backend = getattr(cache, "cache", None)
    if isinstance(backend, DiskBackend):
        backend.close()
    litellm.cache = None


def cache_enabled() -> bool:
    return getattr(litellm, "cache", None) is not None


def cache_key(model: str, messages: list[dict]) -> str:
    # Only model + messages are passed, so nothing else can influence the key.
    return litellm.cache.get_cache_key(model=model, messages=messages)


def get_cached(model: str, messages: list[dict]) -> dict[str, Any] | None:
    if not cache_enabled():
        return None
    try:
        value = litellm.cache.cache.get_cache(cache_key(model, messages))
        return value if isinstance(value, dict) and value.get("reply") else None
    except Exception:  # cache must never break a request
        logger.exception("cache read failed")
        return None


def store(model: str, messages: list[dict], entry: dict[str, Any]) -> None:
    if not cache_enabled():
        return
    try:
        litellm.cache.cache.set_cache(cache_key(model, messages), entry)
    except Exception:
        logger.exception("cache write failed")
