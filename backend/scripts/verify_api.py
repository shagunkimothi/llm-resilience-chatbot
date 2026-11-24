"""Live contract check against a running backend. Usage: python scripts/verify_api.py [base_url]"""
import sys, time, uuid
import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
c = httpx.Client(base_url=BASE, timeout=60)
results = []
META = {"resolution_source": str, "model": str, "latency_ms": int, "input_tokens": int,
        "output_tokens": int, "fallback_attempts": int}

def check(name, ok, info=""):
    results.append(ok)
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  -> {info}" if info and not ok else ""))

def sid(): return f"s-{uuid.uuid4().hex[:8]}"

def chat(session, msg, sim=None, retry=True):
    h = {"X-Simulate-Failure": sim} if sim else {}
    r = c.post("/chat", json={"session_id": session, "message": msg}, headers=h)
    if r.status_code == 503 and not sim and retry:
        print("   (real provider 503, retrying once)"); time.sleep(2)
        r = c.post("/chat", json={"session_id": session, "message": msg}, headers=h)
    return r

def valid_meta(m):
    return all(isinstance(m.get(k), t) and not isinstance(m.get(k), bool) for k, t in META.items()) \
        and "key_id" in m

r = c.get("/health"); j = r.json()
check("health 200 + fields", r.status_code == 200 and j.get("status") == "ok"
      and isinstance(j.get("keys_configured"), int) and j["keys_configured"] >= 2
      and j.get("cache_enabled") is True, j)

uniq = uuid.uuid4().hex[:6]
first = f"My favourite colour is turquoise (ref {uniq}). Reply with just OK."
sA = sid(); r = chat(sA, first); live = r.json()
m = live.get("metadata", {})
check("chat 200, live, all metadata fields/types", r.status_code == 200 and live.get("session_id") == sA
      and isinstance(live.get("reply"), str) and live["reply"].strip() and valid_meta(m)
      and m["resolution_source"] == "LIVE_INFERENCE" and m["key_id"] in ("key_1", "key_2"), live)

sB = sid(); r = chat(sB, first); hit = r.json(); hm = hit.get("metadata", {})
check("same first msg, new session -> LLM_CACHE", r.status_code == 200 and hm.get("resolution_source") == "LLM_CACHE", hit)
check("cache: identical reply", hit.get("reply") == live.get("reply"))
check("cache: same tokens", (hm.get("input_tokens"), hm.get("output_tokens")) == (m.get("input_tokens"), m.get("output_tokens")), (hm, m))
check("cache: key_id null, fallback_attempts 0", hm.get("key_id") is None and hm.get("fallback_attempts") == 0, hm)
check("cache faster than live", hm.get("latency_ms", 10**9) < m.get("latency_ms", 0), (hm.get("latency_ms"), m.get("latency_ms")))

r = chat(sA, "What is my favourite colour? One word.")
check("multi-turn remembers", r.status_code == 200 and "turquoise" in r.json().get("reply", "").lower(), r.json())
check("2nd turn not from cache", r.json().get("metadata", {}).get("resolution_source") == "LIVE_INFERENCE")

r = c.get(f"/sessions/{sA}/messages"); h = r.json(); msgs = h.get("messages", [])
check("history 200, 4 msgs, oldest first, no system", r.status_code == 200 and h.get("session_id") == sA
      and [x["role"] for x in msgs] == ["user", "assistant", "user", "assistant"]
      and msgs[0]["content"] == first, [x.get("role") for x in msgs])
check("only assistant rows have metadata", all(("metadata" in x) == (x["role"] == "assistant") for x in msgs)
      and msgs[1]["metadata"].get("resolution_source") == "LIVE_INFERENCE")

for sim in ("key_1=429", "key_1=500"):
    r = chat(sid(), f"Say hi ({sim}, {uuid.uuid4().hex[:6]})", sim=sim); j = r.json(); fm = j.get("metadata", {})
    check(f"{sim} -> 200 key_2, fallback_attempts 1", r.status_code == 200 and fm.get("key_id") == "key_2"
          and fm.get("fallback_attempts") == 1 and fm.get("resolution_source") == "LIVE_INFERENCE", j)

for sim in ("*=429", "key_1=429,key_2=500"):
    s = sid(); r = chat(s, "Hello there", sim=sim)
    check(f"{sim} -> 503 exact body", r.status_code == 503 and r.json() == {"detail": "all providers unavailable"}, (r.status_code, r.text))
    check(f"{sim} -> nothing saved (404)", c.get(f"/sessions/{s}/messages").status_code == 404)
s = sid(); chat(s, first)
r = chat(s, first, sim="*=429")
check("*=429 on a cached msg still 503", r.status_code == 503, r.status_code)

bad = {"empty msg": {"session_id": sid(), "message": ""},
       "whitespace msg": {"session_id": sid(), "message": "   "},
       "4001 chars": {"session_id": sid(), "message": "a" * 4001},
       "missing session_id": {"message": "hi"},
       "missing message": {"session_id": sid()},
       "129-char session_id": {"session_id": "s" * 129, "message": "hi"}}
for name, body in bad.items():
    r = c.post("/chat", json=body)
    check(f"422 {name}", r.status_code == 422 and "detail" in r.json(), (r.status_code, r.text[:120]))
r = c.post("/chat", content="{bad json", headers={"Content-Type": "application/json"})
check("422 malformed JSON", r.status_code == 422 and "detail" in r.json())
check("4000 chars accepted boundary (no 422)", c.post("/chat", json={"session_id": sid(), "message": "a" * 4000},
      headers={"X-Simulate-Failure": "*=429"}).status_code == 503)

r = c.get("/sessions/does-not-exist-123/messages")
check("404 exact body", r.status_code == 404 and r.json() == {"detail": "session not found"}, r.text)

r = c.options("/chat", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST",
                                "Access-Control-Request-Headers": "content-type,x-simulate-failure"})
check("CORS allows localhost:5173", r.headers.get("access-control-allow-origin") in ("http://localhost:5173", "*"), dict(r.headers))

print(f"\n{sum(results)}/{len(results)} checks passed")
