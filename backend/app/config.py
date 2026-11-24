from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_ENV = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ROOT_ENV, env_file_encoding="utf-8", extra="ignore"
    )

    llm_api_keys: str = ""
    # The "gemini/" prefix routes LiteLLM to the Gemini API (AI Studio keys);
    # without it LiteLLM would route to Vertex AI.
    llm_model: str = "gemini/gemini-3.5-flash-lite"
    # Seconds per request attempt (per key).
    llm_timeout: float = Field(default=20.0, gt=0, le=120)
    # LiteLLM's own retries on the SAME key. 0 = fail over to the next key instead.
    llm_num_retries: int = Field(default=0, ge=0, le=3)
    database_url: str = "sqlite:///./data/app.db"
    allowed_origins: str = "http://localhost:3000,http://localhost:5173"
    enable_failure_simulation: bool = False
    default_system_prompt: str = "You are a helpful assistant."
    cache_type: str = "disk"
    cache_dir: str = "./data/llm_cache"

    @property
    def api_keys(self) -> list[str]:
        return [k.strip() for k in self.llm_api_keys.split(",") if k.strip()]

    @property
    def origins(self) -> list[str]:
        # Browsers send Origin without a trailing "/", so strip it for exact matching.
        return [o.strip().rstrip("/") for o in self.allowed_origins.split(",") if o.strip().rstrip("/")]


@lru_cache
def get_settings() -> Settings:
    return Settings()
