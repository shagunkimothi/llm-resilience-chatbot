"""Calls the LLM once per key. Prints key ids, never the keys themselves."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # so 'app' imports work

import litellm
from app.config import get_settings

s = get_settings()
print(f"model={s.llm_model}  keys={len(s.api_keys)}")

for i, key in enumerate(s.api_keys, start=1):
    try:
        r = litellm.completion(
            model=s.llm_model,
            messages=[{"role": "user", "content": "Reply with just the word: pong"}],
            api_key=key,
            num_retries=0,
        )
        print(f"key_{i}: OK   reply={r.choices[0].message.content.strip()!r}  "
              f"in={r.usage.prompt_tokens} out={r.usage.completion_tokens}  model={r.model}")
    except Exception as e:
        print(f"key_{i}: FAIL {type(e).__name__}: {str(e)[:150]}")