#!/usr/bin/env python3
import os, json, time, urllib.request, urllib.error

API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
BASE_URL = "https://openrouter.ai/api/v1/chat/completions"

MODELS = [
    ("nvidia/nemotron-3-super-120b-a12b:free",  "Nemotron-120B"),
    ("nvidia/nemotron-3-nano-30b-a3b:free",      "Nemotron-30B"),
    ("qwen/qwen3-coder-480b-a35b:free",          "Qwen3-Coder-480B"),
    ("deepseek/deepseek-v4-flash:free",          "DS-V4-Flash"),
    ("meta-llama/llama-4-maverick:free",         "Llama4-Maverick"),
    ("google/gemma-3-27b-it:free",               "Gemma3-27B"),
]

TESTS = [
    ("Terse ack",    "Say exactly: Acknowledged. Nothing else.",                                                  10,  lambda r: "acknowledged" in r.lower()),
    ("JSON bare",    'Reply with ONLY valid JSON, no markdown: {"status": "ok", "count": 42}',                   40,  lambda r: (lambda j: j.get("status")=="ok" and j.get("count")==42)(json.loads(r.strip()))),
    ("Math",         "A train: 60mph for 2hrs, then 90mph for 1hr. Total distance? One line.",                   50,  lambda r: "210" in r),
    ("Classify-S",   "Classify as MINIMAL/NATIVE/ALGORITHM only: 'What is the capital of France?' One word.",   10,  lambda r: r.strip().upper().startswith("NATIVE")),
    ("Classify-C",   "Classify as MINIMAL/NATIVE/ALGORITHM only: 'Refactor auth to JWTs, update all tests, write migration guide.' One word.", 10, lambda r: r.strip().upper().startswith("ALGORITHM")),
    ("Security",     "Name top 3 risks of storing session tokens in localStorage. 3 bullets, under 15 words each.", 120, lambda r: sum(1 for w in ["xss","cross-site","script","theft","hijack","steal","inject"] if w in r.lower()) >= 2),
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
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.load(resp)
            elapsed = time.time() - t0
            choices = result.get("choices", [])
            if not choices:
                return f"NO_CHOICES:{json.dumps(result)[:60]}", -1
            content = choices[0].get("message", {}).get("content", "") or ""
            # check for error in content
            err = result.get("error")
            if err:
                return f"ERR:{str(err)[:60]}", -1
            return content, elapsed
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:80]
        return f"HTTP{e.code}:{body}", -1
    except Exception as e:
        return f"EXC:{str(e)[:60]}", -1

header = f"{'Model':<22}" + "".join(f" {t[0][:8]:>9}" for t in TESTS) + f" {'SCORE':>6} {'Notes'}"
print(header)
print("-" * 95)

for model_id, label in MODELS:
    scores = []
    latencies = []
    notes = []
    for name, prompt, max_tok, evalf in TESTS:
        response, elapsed = call(model_id, prompt, max_tok)
        latencies.append(elapsed)
        if response.startswith(("ERR:", "HTTP", "EXC:", "NO_")):
            scores.append(None)
            notes.append(response[:25])
        else:
            try:
                passed = evalf(response)
            except:
                passed = False
            scores.append(passed)
        time.sleep(1.0)

    def fmt(s):
        if s is None: return "     ?"
        return "     ✓" if s else "     ✗"

    total_valid = [s for s in scores if s is not None]
    score_str = f"{sum(1 for s in total_valid if s)}/{len(total_valid)}"
    note_str = "; ".join(notes[:2]) if notes else ""
    print(f"{label:<22}" + "".join(fmt(s) for s in scores) + f" {score_str:>6}  {note_str}")
    time.sleep(2.0)

