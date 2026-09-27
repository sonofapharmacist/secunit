#!/usr/bin/env python3
import os, json, time, urllib.request, urllib.error

API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
BASE_URL = "https://openrouter.ai/api/v1/chat/completions"

# Current verified free models — prioritized for PAI routing relevance
MODELS = [
    ("nvidia/nemotron-3-super-120b-a12b:free",    "Nemotron-120B"),
    ("nvidia/nemotron-3-ultra-550b-a55b:free",    "Nemotron-550B"),
    ("openai/gpt-oss-120b:free",                  "GPT-OSS-120B"),
    ("openai/gpt-oss-20b:free",                   "GPT-OSS-20B"),
    ("qwen/qwen3-coder:free",                     "Qwen3-Coder"),
    ("google/gemma-4-26b-a4b-it:free",            "Gemma4-26B"),
    ("nousresearch/hermes-3-llama-3.1-405b:free", "Hermes3-405B"),
    ("meta-llama/llama-3.3-70b-instruct:free",    "Llama3.3-70B"),
]

TESTS = [
    ("Terse",    "Say exactly: Acknowledged. Nothing else.",                                                     10,  lambda r: "acknowledged" in r.lower()),
    ("JSON",     'Reply with ONLY valid JSON, no markdown fences: {"status": "ok", "count": 42}',               40,  lambda r: (lambda j: j.get("status")=="ok" and j.get("count")==42)(json.JSONDecoder().raw_decode(r.strip())[0])),
    ("Math",     "A train: 60mph for 2hrs, then 90mph for 1hr. Total distance? One line.",                      50,  lambda r: "210" in r),
    ("Cls-S",    "Reply ONE word ONLY — MINIMAL, NATIVE, or ALGORITHM: 'What is the capital of France?'",       8,   lambda r: "NATIVE" in r.upper()),
    ("Cls-C",    "Reply ONE word ONLY — MINIMAL, NATIVE, or ALGORITHM: 'Refactor auth to JWTs, update all tests, write migration guide.'", 8, lambda r: "ALGORITHM" in r.upper()),
    ("Security", "Top 3 risks of storing session tokens in localStorage. 3 bullets, under 15 words each.",      120, lambda r: sum(1 for w in ["xss","cross-site","script","theft","hijack","steal","inject"] if w in r.lower()) >= 2),
]

def call(model, prompt, max_tokens):
    payload = {"model": model, "messages": [{"role":"user","content": prompt}],
               "max_tokens": max_tokens, "temperature": 0.1}
    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE_URL, data=data, headers={
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://pai.local",
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            result = json.load(resp)
            elapsed = time.time() - t0
            err = result.get("error")
            if err:
                return f"ERR:{str(err)[:80]}", -1
            choices = result.get("choices", [])
            if not choices:
                return f"EMPTY", -1
            content = choices[0].get("message", {}).get("content", "") or ""
            usage = result.get("usage", {})
            return content, elapsed
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:100]
        return f"HTTP{e.code}:{body}", -1
    except Exception as e:
        return f"EXC:{str(e)[:60]}", -1

header = f"{'Model':<20}" + "".join(f" {t[0]:>8}" for t in TESTS) + f"  {'SCORE':>5}  TTFT"
print(header)
print("-" * 90)

for model_id, label in MODELS:
    scores = []
    first_latency = None
    errors = []
    for i, (name, prompt, max_tok, evalf) in enumerate(TESTS):
        response, elapsed = call(model_id, prompt, max_tok)
        if i == 0:
            first_latency = elapsed
        if response.startswith(("ERR:", "HTTP", "EXC:", "EMPTY")):
            scores.append(None)
            errors.append(f"{name}:{response[:30]}")
        else:
            try:
                passed = evalf(response)
            except:
                passed = False
            scores.append(passed)
        time.sleep(1.5)

    def fmt(s):
        if s is None: return "       ?"
        return "       ✓" if s else "       ✗"

    valid = [s for s in scores if s is not None]
    score_str = f"{sum(1 for s in valid if s)}/{len(valid)}"
    ttft = f"{first_latency:.2f}s" if first_latency and first_latency > 0 else "err"
    err_str = " | "+errors[0][:40] if errors else ""
    print(f"{label:<20}" + "".join(fmt(s) for s in scores) + f"  {score_str:>5}  {ttft}{err_str}")
    time.sleep(3.0)

