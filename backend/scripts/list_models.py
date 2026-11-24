"""Lists Gemini models that support generateContent. Never prints the key."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # so 'app' imports work

import httpx
from app.config import get_settings

s = get_settings()
if not s.api_keys:
    sys.exit("No API keys configured")

r = httpx.get(
    "https://generativelanguage.googleapis.com/v1beta/models",
    params={"pageSize": 200},
    headers={"x-goog-api-key": s.api_keys[0]},
    timeout=30,
)
r.raise_for_status()

for m in r.json().get("models", []):
    if "generateContent" in m.get("supportedGenerationMethods", []):
        print(m["name"].removeprefix("models/"))
