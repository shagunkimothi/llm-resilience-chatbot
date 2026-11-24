# Resilient Chat — LLM Chatbot with Key Failover and Response Caching

A chat app whose backend tries an ordered pool of LLM API keys, falling over to the next key on rate limits, outages and timeouts, and replays identical prompts from a response cache.
Every reply reports where it came from (`LIVE_INFERENCE` / `LLM_CACHE`), which key answered, latency and token usage; conversations persist in SQLite.

**Stack:** React + Vite (frontend) · FastAPI (backend) · LiteLLM (Gemini) · SQLite via SQLAlchemy · Docker / docker compose (nginx serves the frontend)

## 1. Live URLs

- Frontend: `<FRONTEND_URL>`
- Backend: `<BACKEND_URL>` (health: `<BACKEND_URL>/health`)
- Repository: `<REPO_URL>`
- Demo video: `<VIDEO_URL>`

Hosting: backend on Railway (`backend/railway.json`, same Dockerfile), frontend on Netlify (`frontend/netlify.toml`). The deployed backend runs with `ENABLE_FAILURE_SIMULATION=true` so failover can be demonstrated; the free host may cold-start (~50 s on the first request).

## 2. Run locally: with Docker and without

**Prerequisites:** Docker Desktop and GNU make (on Windows without GNU make, `mingw32-make` works with the same targets, or run the `docker compose` commands directly). Without Docker: Python 3.12 and Node 22. You need at least one Gemini API key (two or more to see failover).

### With Docker

```bash
cp .env.example .env          # Windows: copy .env.example .env
# edit .env: LLM_API_KEYS=<key_1>,<key_2>
make up                       # docker compose up --build -d
```

- Frontend: http://localhost:3000 · Backend: http://localhost:8000 (`/health`, `/docs`)
- `make ps`, `make logs`, `make down` (stops and removes containers, **keeps** the volume)
- Two containers: `llm-backend` and `llm-frontend` (nginx, waits for the backend healthcheck). SQLite is not a container: it is the file `/data/app.db` (plus the cache in `/data/llm_cache`) on the named volume `llm_appdata`, so history survives `restart` and `down`/`up`. `docker compose down -v` wipes it.
- `.env` is passed at runtime via `env_file`; it is excluded from both images by `.dockerignore`.

### Without Docker

Backend (reads the **root** `.env`; run from `backend/`):

```bash
cp .env.example .env                                   # once, at the repo root
cd backend
python -m venv venv
source venv/bin/activate                               # Windows: venv\Scripts\activate
pip install -r requirements-dev.txt                    # runtime deps + pytest/httpx
uvicorn app.main:app --port 8000
```

Frontend (second terminal):

```bash
cd frontend
npm ci
cp .env.example .env      # optional; Windows: copy .env.example .env  (VITE_API_URL, default http://localhost:8000)
npm run dev               # http://localhost:5173
```

### Tests

```bash
make test                                  # Windows venv path is the default
make test PY=backend/venv/bin/python       # macOS / Linux
```

`make test` installs `backend/requirements-dev.txt`, then runs backend **pytest (39 tests)** and frontend **Vitest + Testing Library (22 tests)**. Both use mocks, so no API key or network is needed.

### Environment variables (`.env.example`)

| Variable | Meaning | Default in `.env.example` |
|---|---|---|
| `LLM_API_KEYS` | Comma-separated key pool, tried in order as `key_1`, `key_2`, … | `your_key_1,your_key_2` |
| `LLM_MODEL` | LiteLLM model name (`gemini/` prefix = Gemini API) | `gemini/gemini-3.5-flash-lite` |
| `LLM_TIMEOUT` | Seconds per attempt, per key (0–120) | `20` |
| `LLM_NUM_RETRIES` | LiteLLM retries on the *same* key; `0` = fail over instead | `0` |
| `DATABASE_URL` | SQLAlchemy URL (Docker overrides to `sqlite:////data/app.db`) | `sqlite:///./data/app.db` |
| `ALLOWED_ORIGINS` | CORS allow-list, comma-separated | `http://localhost:3000,http://localhost:5173` |
| `ENABLE_FAILURE_SIMULATION` | Honor the `X-Simulate-Failure` header (code default `false`) | `true` |
| `DEFAULT_SYSTEM_PROMPT` | Used when a session has no system prompt | `You are a helpful assistant.` |
| `CACHE_TYPE` | `disk` (persistent) or `local` (in-memory) | `disk` |
| `CACHE_DIR` | Disk cache folder (Docker overrides to `/data/llm_cache`) | `./data/llm_cache` |
| `VITE_API_URL` | Frontend → backend base URL (build-time; trailing `/` stripped) | `http://localhost:8000` |

## 3. Design decisions: key fallback, caching, SQLite session storage

### Request flow

```
Browser (React)
   │ POST /chat {session_id, message, system_prompt?}   [+ X-Simulate-Failure]
   ▼
FastAPI /chat ──► validate (422) ──► load history from SQLite
   │              messages = [system] + history + [new user message]
   ▼
cache lookup (model + messages) ── hit ──► reply, LLM_CACHE, key_id null ─┐
   │ miss (or simulation header active: cache skipped)                     │
   ▼                                                                       │
key pool: key_1 → key_2 → … (one LiteLLM call each, per-attempt timeout)   │
   │ all failed / non-retryable ──► 503 {"detail":"all providers unavailable"}  (nothing saved)
   │ success ──► store in cache                                            │
   ▼                                                                       │
save user + assistant rows in ONE transaction ◄────────────────────────────┘
   ▼
200 {session_id, reply, metadata{resolution_source, model, latency_ms,
                                 input_tokens, output_tokens, key_id, fallback_attempts}}
```

### Key fallback (`backend/app/services/llm_service.py`)

- **Ordered pool.** `LLM_API_KEYS` becomes `key_1 … key_n`. Each request starts with `key_1` and moves to the next key only on a *fallback-eligible* error. LiteLLM runs with `num_retries=0` (`LLM_NUM_RETRIES`) and `timeout=LLM_TIMEOUT` per attempt, so a slow or limited key costs one bounded attempt instead of hidden retries.
- **Falls over on:** rate limit / quota (429), 5xx (`InternalServerError`, `ServiceUnavailableError`, any status ≥ 500), `Timeout`, `APIConnectionError`, auth / permission errors, Gemini's "API key not valid" 400, and an **empty reply** (treated as a failed attempt).
- **Does not fall over on:** other 400 / 404 errors (bad request, unknown model). Another key would fail the same way, so the request stops and returns **503** `{"detail":"all providers unavailable"}`. Exhausting every key, or having no keys, returns the same 503.
- **`fallback_attempts`** is the number of failed keys before the one that answered (`key_1=429` → `key_2`, `fallback_attempts: 1`).
- **Why an explicit loop instead of a LiteLLM Router:** the response must report exactly *which* key answered and how many failed before it. A loop over plain `litellm.completion()` calls gives that directly. It also provides a clean hook for failure simulation and keeps the retry policy visible in about 60 lines.
- **Keys are never exposed.** Responses and logs carry only `key_1`, `key_2`, …. Provider error text is scrubbed of key values before it is logged, and the global 500 handler logs only the exception type.

**`X-Simulate-Failure`** (for example `key_1=429`, `key_1=429,key_2=500`, `*=429`):
- **Format:** comma-separated `key_N=status` or `*=status`, with status 429, 500, 502 or 503. Invalid entries are ignored.
- **Gate:** the header is honored only when `ENABLE_FAILURE_SIMULATION=true`; otherwise it is ignored.
- **Behavior:** a simulated key raises the matching LiteLLM exception inside the same loop *before* any provider call, so it exercises the real fallback path without spending quota.
- **Cache bypass:** while the header is active the cache is skipped, so `*=429` is always 503, even for a cached prompt.

### Caching (`backend/app/services/cache_service.py`)

- **Implementation.** A `litellm.Cache` handles key hashing (`get_cache_key`). LiteLLM 1.110.3 removed its built-in `disk` type, so a small `diskcache` backend is plugged in for `CACHE_TYPE=disk`; `local` uses LiteLLM's in-memory cache. The cache runs in `default_off` mode and is read and written explicitly, so the key is exactly what we pass.
- **Cache key = model + the full message list** (system prompt + history + new message). It is independent of which API key answered, the timeout, and other options. "Same first message in a new chat" is therefore a hit, while a follow-up in an existing chat (different history) is not.
- **A hit** returns the identical reply and the stored token usage, with `resolution_source: "LLM_CACHE"`, `key_id: null`, `fallback_attempts: 0` and a latency of a few ms.
- **Only successful live replies are cached**; errors and empty replies never are.
- **Trade-off:** identical prompts replay deterministically. That saves quota and latency and makes the demo reproducible, but repeated identical questions never get a fresh answer. There is no TTL: entries live until the cache dir is cleared.

### SQLite session storage (`backend/app/db.py`)

- **Schema** (SQLAlchemy, `create_all` on startup):
  - `messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id, role, content, metadata, created_at)`: the required table. `metadata` holds the JSON reply metadata, on assistant rows only.
  - `sessions(session_id PRIMARY KEY, system_prompt, created_at)`: remembers each session's system prompt, so later turns reuse it.
  - an index `ix_messages_session_id_id (session_id, id)` for ordered history reads.
- **Atomic writes.** The user row and assistant row are written in **one transaction, only after a successful reply**. 422 and 503 never touch history, and a session never holds a question without its answer.
- **Location** comes from `DATABASE_URL` (the parent folder is created automatically). In Docker it is `/data/app.db` on the `llm_appdata` volume.
- **Persistence in production:** Railway builds and runs the same `backend/Dockerfile`, with a Railway volume mounted at `/data`. `DATABASE_URL` and `CACHE_DIR` already point there, so SQLite history (and the cache) persist across redeploys and restarts, just as the `llm_appdata` volume does locally (`docker compose restart backend`, `make down && make up`).

### Error handling and CORS

- **Errors are always JSON** `{"detail": ...}`:
  - 422: validation (empty or whitespace message, more than 4000 chars, `session_id` missing or over 128 chars, malformed JSON)
  - 404: `{"detail":"session not found"}`
  - 503: providers unavailable
  - 500: a global handler returns `{"detail":"internal server error"}` without a stack trace
- **CORS** allows only `ALLOWED_ORIGINS`, methods `GET`/`POST`/`OPTIONS`, and the headers `Content-Type` and `X-Simulate-Failure`.
- **Frontend errors:** each failure is shown as a readable chat bubble:
  - 422: "Invalid message: …"
  - 503: "All providers are unavailable right now…"
  - network failure: "Can't reach the server at …"
  - any other status: "Something went wrong (HTTP n)."

  A React error boundary prevents a blank screen.

### Image size

The backend runtime image is about **174 MB compressed** (743 MB on disk). Most of that is LiteLLM's dependency chain (openai, tokenizers, huggingface-hub, boto3, aiohttp). The multi-stage build keeps pip caches and build layers out. Only `/opt/venv` and `app/` are copied, tests and scripts are excluded, and pytest/httpx live in `requirements-dev.txt`. The frontend image (nginx + static build) is about 29 MB compressed.

## 4. Verification: how to see failover, cache hits and per-message token usage

Bash examples against a local backend; set `B=<BACKEND_URL>` for the deployed one. Values such as latency and tokens will differ.

```bash
B=http://localhost:8000
```

**Health**
```bash
curl -s $B/health
# {"status":"ok","keys_configured":2,"cache_enabled":true}
```

**Live reply (new session)**
```bash
curl -s -X POST $B/chat -H "Content-Type: application/json" \
  -d '{"session_id":"s-demo-1","message":"Capital of France?"}'
```
```json
{"session_id":"s-demo-1","reply":"The capital of France is Paris.",
 "metadata":{"resolution_source":"LIVE_INFERENCE","model":"gemini/gemini-3.5-flash-lite",
             "latency_ms":1848,"input_tokens":11,"output_tokens":7,"key_id":"key_1","fallback_attempts":0}}
```

**Cache hit: the same message in a NEW session**
```bash
curl -s -X POST $B/chat -H "Content-Type: application/json" \
  -d '{"session_id":"s-demo-2","message":"Capital of France?"}'
# identical reply, "resolution_source":"LLM_CACHE", "key_id":null, "fallback_attempts":0, latency_ms of a few ms
```

**Memory: follow-up in the same session, then history**
```bash
curl -s -X POST $B/chat -H "Content-Type: application/json" \
  -d '{"session_id":"s-demo-1","message":"And its population, roughly?"}'
# answers about Paris (history was sent), LIVE_INFERENCE (different message list => no cache hit)
curl -s $B/sessions/s-demo-1/messages
# {"session_id":"s-demo-1","messages":[{"role":"user",...},{"role":"assistant",...,"metadata":{...}}, ...]}  oldest first, no system row
```

**Failover** (requires `ENABLE_FAILURE_SIMULATION=true`)
```bash
curl -s -X POST $B/chat -H "Content-Type: application/json" -H "X-Simulate-Failure: key_1=429" \
  -d '{"session_id":"s-demo-3","message":"Say hi"}'
# 200, "key_id":"key_2", "fallback_attempts":1, LIVE_INFERENCE
curl -s -X POST $B/chat -H "Content-Type: application/json" -H "X-Simulate-Failure: key_1=500" \
  -d '{"session_id":"s-demo-4","message":"Say hi"}'
# 200, "key_id":"key_2", "fallback_attempts":1
curl -s -i -X POST $B/chat -H "Content-Type: application/json" -H "X-Simulate-Failure: *=429" \
  -d '{"session_id":"s-demo-5","message":"Say hi"}'
# HTTP 503  {"detail":"all providers unavailable"}
curl -s -i $B/sessions/s-demo-5/messages
# HTTP 404  {"detail":"session not found"}   (nothing was saved)
```

**Validation and not-found**
```bash
curl -s -i -X POST $B/chat -H "Content-Type: application/json" -d '{"session_id":"s-x","message":"   "}'
# HTTP 422  {"detail":[{"type":"string_too_short",...,"msg":"String should have at least 1 character",...}]}
curl -s -i $B/sessions/does-not-exist/messages
# HTTP 404  {"detail":"session not found"}
```

**Token usage per message.** `input_tokens` is the provider's prompt-token count for *this request only*: system prompt + full history + new message. It grows as a conversation gets longer. `output_tokens` is the reply's completion tokens. A cache hit returns the usage stored with the original reply. The UI shows both under every assistant reply (`meta-input-tokens`, `meta-output-tokens`), alongside source, model, latency, key and fallbacks.

**In the UI.**
- **Simulating failover:** use *Settings → Developer: simulate failure* in the sidebar (None, `key_1=429`, `key_1=500`, `key_1=429,key_2=500`, `*=429`), or click the **Test failover** card on the empty chat screen, which selects `key_1=429` and fills a sample question.
- **Seeing a cache hit:** send the same first message in a **New chat**. The reply comes back as `LLM_CACHE` with green styling.

**Automated live check:** `python backend/scripts/verify_api.py <BASE_URL>` runs 28 contract checks against a running backend. It covers health, live vs cache, memory, history, failover, 503 with nothing saved, the 422 boundaries, 404 and CORS. It needs `httpx` from `requirements-dev.txt` and uses a few real LLM calls.

## 5. Setup Used: your editor and AI tools

- **Editor:** VS Code
- **AI tools:** Claude (claude.ai) for planning and review; Claude Code for implementation and testing
- **OS:** Windows 11

## 6. Bonus features (if any)

| Feature | Why |
|---|---|
| Failure-simulation select (Settings) and a **Test failover** card in the UI | Demonstrate failover live without real outages or spending quota. |
| `key_id` and `fallback_attempts` shown on every reply | Makes it visible which key answered and how many failed first. |
| In-page chat history sidebar; switching chats reloads them via `GET /sessions/{id}/messages` | Shows the stored history and metadata come back from SQLite, not from browser state. |
| Distinct `LLM_CACHE` styling (green pill) vs `LIVE_INFERENCE` (purple) | Cache hits are recognizable at a glance. |
| Per-session system prompt, stored in a `sessions` table | Later turns reuse the prompt without resending it. |
| React error boundary plus readable error bubbles | The UI never goes blank on a crash or a failed request. |
| Empty replies treated as a failed attempt | A blank answer falls over to the next key instead of being shown or cached. |
| Per-attempt timeout and `num_retries=0` | Bounded worst-case latency; a slow key fails over quickly. |
| `backend/scripts/verify_api.py` (28 live contract checks) | One command verifies a deployment end to end. |
| Frontend tests (22, Vitest + Testing Library) next to backend pytest (39) | The UI contract (`data-testid`s, meta values, errors) is regression-tested. |
| Non-root backend container, healthchecks on both containers, `depends_on: service_healthy` | Safer runtime; the frontend starts only once the API is ready. |
| Exact-pinned dependencies (pip `==`, npm exact versions, `npm ci`) | Reproducible builds. |
| Helper scripts `check_keys.py`, `list_models.py`, `verify_litellm.py` | Check each key and the model setup without ever printing keys. |
