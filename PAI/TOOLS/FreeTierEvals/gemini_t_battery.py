#!/usr/bin/env python3
"""T1-T9 battery for Gemini Flash variants via Gemini native API.
thinkingBudget:0 for non-thinking models; thinking enabled for Flash 2.5+.
T8 (function calling) uses Gemini function declarations format.
"""
import os, json, time, subprocess, sys, urllib.request, urllib.error

BASE = "https://generativelanguage.googleapis.com/v1beta/models"

# Tier 1 RPM (AI Studio tldr-insights, 2026-07-06):
#   Flash-Lite 2.5 + 3.1: 4,000 RPM → sleep 0s
#   Flash 2.5 + 3.5:      1,000 RPM → sleep 0.5s
ENDPOINTS = {
    "flash_lite_25": {"name": "Gemini 2.5 Flash-Lite", "model": "gemini-2.5-flash-lite", "thinking": False, "sleep": 0},
    "flash_25":      {"name": "Gemini 2.5 Flash",      "model": "gemini-2.5-flash",      "thinking": True,  "sleep": 0.5},
    "flash_35":      {"name": "Gemini 3.5 Flash",      "model": "gemini-3.5-flash",      "thinking": True,  "sleep": 0.5},
    "flash_lite_31": {"name": "Gemini 3.1 Flash-Lite", "model": "gemini-3.1-flash-lite", "thinking": False, "sleep": 0},
    "flash_36":      {"name": "Gemini 3.6 Flash",      "model": "gemini-3.6-flash",      "thinking": True,  "sleep": 0.5},
    "flash_lite_35": {"name": "Gemini 3.5 Flash-Lite", "model": "gemini-3.5-flash-lite", "thinking": False, "sleep": 0},
}

def resolve_key():
    k = os.environ.get("GEMINI_API_KEY", "")
    if k: return k
    try:
        out = subprocess.run(["passage", "show", "api/gemini"], capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except Exception as e:
        print(f"FATAL: {e}", file=sys.stderr); sys.exit(1)

API_KEY = resolve_key()

def _strip_fence(s):
    s = s.strip()
    if s.startswith("```"):
        lines = s.split("\n")
        inner = lines[1:-1] if lines and lines[-1].strip() == "```" else lines[1:]
        s = "\n".join(inner).strip()
    return s

# Generation confirmed 2026-07-22: 3.6 Flash / 3.5 Flash-Lite reject thinkingBudget:0 with
# HTTP 400 INVALID_ARGUMENT (budget -1 and omitting the field both work) — thinking can no
# longer be fully disabled on these models. Older Flash variants accept budget 0 fine.
NO_ZERO_BUDGET_MODELS = {"gemini-3.6-flash", "gemini-3.5-flash-lite"}

# 3.6 Flash specifically: even at thinkingBudget:1 (the minimum legal value), thoughtsTokenCount
# ranged 6-2188 in spot checks (a C-battery test-gen prompt hit 2188, well above the original
# 1024 floor) and silently eats the response budget — under-provisioned calls come back
# truncated at finishReason:STOP with a fraction of the expected output, not even a diagnosable
# MAX_TOKENS. 3.5 Flash-Lite showed no such overhead with thinkingConfig omitted entirely
# (scored 46/53 clean), so it's not given this treatment. Overhead is additive to the requested
# budget, not a flat floor — must pad max_tokens by the reserve, not max() against it.
ALWAYS_THINKS_MODELS = {"gemini-3.6-flash"}
THINKING_OVERHEAD_RESERVE = 3000

def call_gemini(model, prompt, max_tokens, tools=None):
    url = f"{BASE}/{model}:generateContent?key={API_KEY}"
    if model in ALWAYS_THINKS_MODELS:
        gen_config = {"maxOutputTokens": max_tokens + THINKING_OVERHEAD_RESERVE, "temperature": 0.1,
                      "thinkingConfig": {"thinkingBudget": 1}}
    else:
        gen_config = {"maxOutputTokens": max_tokens, "temperature": 0.1}
        if model not in NO_ZERO_BUDGET_MODELS:
            gen_config["thinkingConfig"] = {"thinkingBudget": 0}
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": gen_config,
    }
    if tools:
        payload["tools"] = tools
    t0 = time.time()
    backoff = 5
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, json.dumps(payload).encode(), {"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                result = json.load(resp)
                elapsed = time.time() - t0
                err = result.get("error")
                if err: return f"ERR:{err.get('message','')[:60]}", elapsed
                candidates = result.get("candidates", [])
                if not candidates: return "NO_CANDIDATES", elapsed
                cand = candidates[0]
                parts = cand.get("content", {}).get("parts", [])
                for p in parts:
                    if p.get("functionCall"):
                        return "TOOL_CALLED", elapsed
                if cand.get("finishReason") == "STOP" and any(p.get("functionCall") for p in parts):
                    return "TOOL_CALLED", elapsed
                text = " ".join(p.get("text","") for p in parts
                               if p.get("text","").strip() and not p.get("thought", False))
                return text.strip(), elapsed
        except urllib.error.HTTPError as e:
            body = e.read().decode()[:80]
            if e.code == 503 and attempt < 4:
                print(f"    [503 retry {attempt+1}/4 — backoff {backoff}s]", flush=True)
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
                continue
            return f"HTTP{e.code}:{body}", time.time() - t0
        except Exception as e:
            return f"EXC:{str(e)[:60]}", time.time() - t0
    return "MAX_RETRIES", time.time() - t0

# T8 Gemini function declarations format
WEATHER_TOOL = [{
    "functionDeclarations": [{
        "name": "get_weather",
        "description": "Get the current weather for a city",
        "parameters": {
            "type": "OBJECT",
            "properties": {"city": {"type": "STRING", "description": "The city name"}},
            "required": ["city"]
        }
    }]
}]

TESTS = [
    ("T1", "MINIMAL — terse ack",
     "Say exactly: 'Acknowledged.' — nothing else.", None, 10,
     lambda r: r.strip() == "Acknowledged." or r.strip().startswith("Acknowledged")),
    ("T2", "Classify — simple lookup",
     """You are a task classifier. Classify as MINIMAL, NATIVE, or ALGORITHM.
Message: "What's the capital of France?"
Reply with ONLY the word: MINIMAL, NATIVE, or ALGORITHM.""", None, 8,
     lambda r: r.strip().upper().startswith("NATIVE")),
    ("T3", "Classify — multi-step",
     """You are a task classifier. Classify as MINIMAL, NATIVE, or ALGORITHM.
Message: "Refactor this entire authentication module to use JWTs, update all tests, and write a migration guide."
Reply with ONLY the word: MINIMAL, NATIVE, or ALGORITHM.""", None, 8,
     lambda r: r.strip().upper().startswith("ALGORITHM")),
    ("T4", "JSON — structured",
     'Return ONLY valid JSON: {"status": "ok", "count": 42}. No other text.', None, 40,
     lambda r: (lambda j: j.get("status")=="ok" and j.get("count")==42)(json.JSONDecoder().raw_decode(_strip_fence(r).strip())[0])),
    ("T5", "Reasoning — logic puzzle",
     "Alice is taller than Bob. Bob is taller than Carol. Who is shortest? Reply with just the name.", None, 50,
     lambda r: "carol" in r.strip().lower()),
    ("T6", "Code gen — TS palindrome",
     "Write a TypeScript function that returns true if a string is a palindrome. Just the function, no explanation.", None, 200,
     lambda r: "function" in r and ("return" in r or "=>" in r) and "palindrome" in r.lower()),
    ("T7", "Instruction — 3 bullets",
     "List 3 security vulnerability types. Reply in exactly 3 bullet points, each under 10 words.", None, 150,
     lambda r: r.count("•") + r.count("-") + r.count("*") >= 3 or r.count("\n") >= 2),
    ("T8", "Function calling",
     "What is the weather in Paris?", WEATHER_TOOL, 50,
     lambda r: r == "TOOL_CALLED"),
    ("T9", "STRIDE — SQL injection",
     """Classify this finding as STRIDE category. Reply with ONLY the letter.
Finding: An API endpoint accepts a user_id parameter from the URL and passes it directly to a SQL query without parameterization.
Reply with: S, T, R, I, D, or E (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege)""", None, 8,
     lambda r: r.strip().upper().startswith("T")),
]

def run_target(target_key):
    cfg = ENDPOINTS[target_key]
    model = cfg["model"]
    thinking = cfg["thinking"]
    print(f"=== T1-T9 Battery: {cfg['name']} ({model}) ===")
    t_start = time.time()
    total = 0
    for tid, label, prompt, tools, max_tok, scorer in TESTS:
        response, elapsed = call_gemini(model, prompt, max_tok, tools=tools)
        try:
            passed = scorer(response)
        except Exception:
            passed = False
        score = 1 if passed else 0
        total += score
        status = "PASS" if passed else "FAIL"
        preview = str(response)[:60].replace("\n"," ")
        print(f"  {tid} [{status}] {label}: {preview!r} ({elapsed:.1f}s)")
        s = cfg.get("sleep", 0)
        if s > 0:
            time.sleep(s)
    wall = time.time() - t_start
    print(f"\nSCORE: {total}/9  ({100*total//9}%)  wall: {wall:.1f}s")
    return total

if __name__ == "__main__":
    target = "flash_lite_25"
    for i, arg in enumerate(sys.argv[1:]):
        if arg == "--target" and i + 1 < len(sys.argv[1:]):
            target = sys.argv[i + 2]
    if target not in ENDPOINTS:
        print(f"Unknown target. Use: {', '.join(ENDPOINTS.keys())}")
        sys.exit(1)
    run_target(target)
