#!/usr/bin/env python3
"""Cohere free-tier eval — basic instruction suite + tool calling.

Cohere v2 Chat API response format: message.content[].text
NOT OpenAI-compatible — different from OR/Mistral/Gemini scripts.

API key: passage show api/cohere
Usage:   COHERE_API_KEY=$(passage show api/cohere) python3 cohere_eval.py

Model notes:
  - command-a-03-2025: non-thinking, best overall, 6/6 basic + tool call (tested 2026-06-11)
  - c4ai-aya-expanse-32b: correct ID — aya-expanse-32b returns 404
  - command-light: DEPRECATED — 404
  - command-a-plus-05-2026 / command-a-reasoning-08-2025: thinking models, need 800+ max_tokens
"""
import os, json, time, urllib.request, urllib.error

API_KEY = os.environ.get("COHERE_API_KEY", "")
BASE_URL = "https://api.cohere.com/v2/chat"

MODELS = [
    ("command-a-03-2025",       "Command-A"),        # non-thinking, 288K ctx, best
    ("command-r-plus-08-2024",  "Command-R+"),
    ("command-r-08-2024",       "Command-R"),
    ("command-r7b-12-2024",     "Command-R7B"),
    ("c4ai-aya-expanse-32b",    "Aya-Expanse-32B"),  # correct ID
    # Thinking models — need 800+ max_tokens; uncomment and raise budgets below
    # ("command-a-plus-05-2026",     "Command-A-Plus"),   # 436K ctx
    # ("command-a-reasoning-08-2025","Command-A-Reason"),
]

TESTS = [
    ("Terse",    "Say exactly: Acknowledged. Nothing else.",                                                           10,  lambda r: "acknowledged" in r.lower()),
    ("JSON",     'Reply with ONLY valid JSON, no markdown: {"status": "ok", "count": 42}',                            50,  lambda r: (lambda j: j.get("status")=="ok" and j.get("count")==42)(json.JSONDecoder().raw_decode(r.strip())[0])),
    ("Math",     "A train: 60mph for 2hrs, then 90mph for 1hr. Total distance? One line.",                            50,  lambda r: "210" in r),
    ("Cls-S",    "Classify as MINIMAL/NATIVE/ALGORITHM only: 'What is the capital of France?' One word.",             10,  lambda r: r.strip().upper().startswith("NATIVE")),
    ("Cls-C",    "Classify as MINIMAL/NATIVE/ALGORITHM only: 'Refactor auth to JWTs, update all tests, write migration guide.' One word.", 10, lambda r: r.strip().upper().startswith("ALGORITHM")),
    ("Security", "Name top 3 risks of storing session tokens in localStorage. 3 bullets, under 15 words each.",      120, lambda r: sum(1 for w in ["xss","cross-site","script","theft","hijack","steal","inject"] if w in r.lower()) >= 2),
]

TOOL_DEF = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string", "description": "The city name"}},
            "required": ["city"]
        }
    }
}]

def call(model, prompt, max_tokens, tools=None):
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0.1,
    }
    if tools:
        payload["tools"] = tools

    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE_URL, data=data, headers={
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.load(resp)
            elapsed = time.time() - t0
            msg = result.get("message", {})
            if tools:
                tool_calls = msg.get("tool_calls", [])
                return ("TOOL_CALLED" if tool_calls else "NO_TOOL"), elapsed, result
            content_parts = msg.get("content", [])
            # filter for text type (thinking models emit thinking blocks first)
            text = ""
            for p in content_parts:
                if isinstance(p, dict) and p.get("type") == "text":
                    text = p.get("text", "")
                    break
            if not text:
                return f"EMPTY:{json.dumps(content_parts)[:60]}", elapsed, result
            return text, elapsed, result
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:120]
        return f"HTTP{e.code}:{body}", -1, {}
    except Exception as e:
        return f"EXC:{str(e)[:80]}", -1, {}

print("\nCohere Free Tier — Basic + Tool-Call Evaluation")
print(f"{'Model':<22}" + "".join(f" {t[0][:8]:>9}" for t in TESTS) + f" {'Tool':>6} {'SCORE':>6}  TTFT   Notes")
print("-" * 105)

for model_id, label in MODELS:
    scores = []
    ttfts = []
    notes = []

    for name, prompt, max_tok, evalf in TESTS:
        response, elapsed, raw = call(model_id, prompt, max_tok)
        ttfts.append(elapsed if elapsed > 0 else None)
        if response.startswith(("HTTP", "EXC:", "EMPTY:")):
            scores.append(None)
            notes.append(f"{name}:{response[:30]}")
        else:
            try:
                passed = evalf(response)
            except Exception:
                passed = False
                notes.append(f"{name}:json_err")
            scores.append(passed)
        time.sleep(1.5)

    tool_resp, tool_elapsed, tool_raw = call(model_id, "What is the weather in Paris?", 200, tools=TOOL_DEF)
    tool_ok = (tool_resp == "TOOL_CALLED")
    if not tool_ok and not tool_resp.startswith(("HTTP", "EXC:")):
        notes.append("tool:text_instead")

    def fmt(s):
        if s is None: return "     ?"
        return "     ✓" if s else "     ✗"

    valid = [s for s in scores if s is not None]
    score_str = f"{sum(1 for s in valid if s)}/{len(valid)}"
    tool_str = "  ✓" if tool_ok else ("  ?" if tool_resp.startswith(("HTTP", "EXC:")) else "  ✗")
    valid_ttfts = [t for t in ttfts if t and t > 0]
    ttft_str = f"{min(valid_ttfts):.2f}s" if valid_ttfts else "  n/a"
    note_str = "; ".join(notes[:2]) if notes else ""
    print(f"{label:<22}" + "".join(fmt(s) for s in scores) + f"{tool_str} {score_str:>6}  {ttft_str}  {note_str}")
    time.sleep(3.0)

print("\nDone.")
