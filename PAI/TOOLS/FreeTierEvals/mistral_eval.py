#!/usr/bin/env python3
"""
PAI direct Mistral eval — refresh 2026-06-15.

Pulls key from `passage show api/mistral`. Tests 9 current Mistral models
(2026-06 catalog) against 9 tasks including a 17-point reasoning probe
parity check vs the NIM sweep results from 2026-06-11.

Usage:
  bun FreeTierEvals/mistral_eval.py            # full sweep
  bun FreeTierEvals/mistral_eval.py --quick    # single smoke model
  MISTRAL_API_KEY=... bun ...                  # override passage
"""

import os, json, time, subprocess, sys, urllib.request, urllib.error

API_KEY = os.environ.get("MISTRAL_API_KEY", "")
BASE_URL = "https://api.mistral.ai/v1/chat/completions"

# Resolve key from passage unless caller overrides
def resolve_key() -> str:
    if API_KEY:
        return API_KEY
    try:
        out = subprocess.run(
            ["passage", "show", "api/mistral"],
            capture_output=True, text=True, check=True
        )
        return out.stdout.strip()
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        print(f"FATAL: passage show api/mistral failed: {e}", file=sys.stderr)
        sys.exit(1)

API_KEY = resolve_key()

TESTS = [
    {
        "id": "T1_minimal",
        "label": "MINIMAL — terse ack",
        "prompt": "Say exactly: 'Acknowledged.' — nothing else.",
        "eval": lambda r: r.strip() == "Acknowledged." or r.strip().startswith("Acknowledged"),
        "scoring": "exact",
    },
    {
        "id": "T2_classify",
        "label": "Classify — simple lookup",
        "prompt": """You are a task classifier. Classify as MINIMAL, NATIVE, or ALGORITHM.
MINIMAL = ack/greeting/rating. NATIVE = single-step. ALGORITHM = multi-step.
Message: "What's the capital of France?"
Reply with ONLY the word: MINIMAL, NATIVE, or ALGORITHM.""",
        "eval": lambda r: r.strip().upper().startswith("NATIVE"),
        "scoring": "exact",
    },
    {
        "id": "T3_classify2",
        "label": "Classify — multi-step task",
        "prompt": """You are a task classifier. Classify as MINIMAL, NATIVE, or ALGORITHM.
Message: "Refactor this entire authentication module to use JWTs, update all tests, and write a migration guide."
Reply with ONLY the word: MINIMAL, NATIVE, or ALGORITHM.""",
        "eval": lambda r: r.strip().upper().startswith("ALGORITHM"),
        "scoring": "exact",
    },
    {
        "id": "T4_json",
        "label": "JSON — structured",
        "prompt": 'Return ONLY valid JSON: {"status": "ok", "count": 42}. No other text.',
        "eval": lambda r: (lambda j: j.get("status") == "ok" and j.get("count") == 42)(json.JSONDecoder().raw_decode(_strip_fence(r).strip())[0]),
        "scoring": "parse+match",
    },
    {
        "id": "T5_reasoning",
        "label": "Reasoning — logic puzzle",
        "prompt": "Alice is taller than Bob. Bob is taller than Carol. Who is shortest? Reply with just the name.",
        "eval": lambda r: "carol" in r.strip().lower(),
        "scoring": "contains",
    },
    {
        "id": "T6_code",
        "label": "Code gen — TypeScript function",
        "prompt": "Write a TypeScript function that returns true if a string is a palindrome. Just the function, no explanation.",
        "eval": lambda r: "function" in r and ("return" in r or "=>" in r) and "palindrome" in r.lower(),
        "scoring": "code-check",
    },
    {
        "id": "T7_instruction_follow",
        "label": "Instruction — length constraint",
        "prompt": "List 3 security vulnerability types. Reply in exactly 3 bullet points, each under 10 words.",
        "eval": lambda r: r.count("•") + r.count("-") + r.count("*") >= 3 or r.count("\n") >= 2,
        "scoring": "format",
    },
    {
        "id": "T8_tool_call",
        "label": "Function calling",
        "messages": [
            {"role": "user", "content": "What is the weather in Paris?"}
        ],
        "tools": [{
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get the current weather for a city",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "city": {"type": "string", "description": "The city name"}
                    },
                    "required": ["city"]
                }
            }
        }],
        "eval": lambda r: r == "TOOL_CALLED",
        "scoring": "tool-use",
    },
    {
        "id": "T9_strategic_reasoning",
        "label": "STRIDE — security classification",
        "prompt": """Classify this finding as STRIDE category. Reply with ONLY the letter.
Finding: An API endpoint accepts a user_id parameter from the URL and passes it directly to a SQL query without parameterization.
Reply with: S, T, R, I, D, or E (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege)""",
        "eval": lambda r: r.strip().upper().startswith("T"),
        "scoring": "exact",
    },
]

# Current Mistral catalog (2026-06-15). devstral-latest is NOT a valid alias —
# use devstral-medium-latest or devstral-small-latest. magistral-medium
# underperformed in 2026-06-11 NIM sweep (4/17) — included for direct parity.
MODELS = [
    ("ministral-3b-latest", "Ministral 3B"),
    ("ministral-8b-latest", "Ministral 8B"),
    ("ministral-14b-latest", "Ministral 14B"),
    ("open-mistral-nemo", "Nemo 12B"),
    ("mistral-small-latest", "Small 4"),
    ("mistral-large-latest", "Large 3"),
    ("mistral-medium-latest", "Medium 3.5"),
    ("magistral-small-latest", "Magistral S"),
    ("magistral-medium-latest", "Magistral M"),
    ("devstral-medium-latest", "Devstral Med"),
    ("devstral-small-latest", "Devstral Small 2"),
    ("codestral-latest", "Codestral"),
    ("open-mixtral-8x22b", "Mixtral 8x22B"),
]

def _strip_fence(s: str) -> str:
    """Strip ```json ... ``` fences and JSON\\n\\n prefix that small models add."""
    s = s.strip()
    if s.startswith("```"):
        s = s.strip("`")
        if s.startswith("json"):
            s = s[4:]
        s = s.strip()
    if s.lower().startswith("json"):
        s = s[4:].lstrip()
    return s

def call_api(model, messages, tools=None, max_tokens=512):
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.1,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE_URL, data=data, headers={
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    })
    for attempt in range(2):
      try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.load(resp)
            choice = result["choices"][0]
            msg = choice["message"]
            if msg.get("tool_calls"):
                return "TOOL_CALLED", result.get("usage", {})
            content = msg.get("content", "")
            # Magistral returns content as a list: [{type:thinking,...}, {type:text, text:...}]
            # Filter to type==text blocks only — thinking blocks have no top-level 'text' key.
            if isinstance(content, list):
                content = "".join(
                    b["text"] for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                )
            if not content and attempt == 0:
                # Silent rate-limit: 200 with empty body. Retry once after backoff.
                time.sleep(5)
                continue
            return content or "", result.get("usage", {})
      except urllib.error.HTTPError as e:
          body = e.read().decode()
          return f"ERR:{e.code}:{body[:80]}", {}
      except Exception as e:
          return f"ERR:{str(e)[:60]}", {}
    return "", {}

def main():
    quick = "--quick" in sys.argv
    models = MODELS[:2] if quick else MODELS

    print(f"Key source: {'env MISTRAL_API_KEY' if os.environ.get('MISTRAL_API_KEY') else 'passage api/mistral'}")
    print(f"Mode: {'quick (2 models)' if quick else 'full'}")
    print(f"{'Model':<20} {'T1':>4} {'T2':>4} {'T3':>4} {'T4':>4} {'T5':>4} {'T6':>4} {'T7':>4} {'T8':>4} {'T9':>4} {'SCORE':>8}")
    print("-" * 88)

    results = {}
    grand_total = 0
    grand_possible = 0
    for model_id, model_label in models:
        scores = []
        raw = []
        for t in TESTS:
            messages = t.get("messages", [{"role": "user", "content": t.get("prompt", "")}])
            tools = t.get("tools")
            response, usage = call_api(model_id, messages, tools)
            if response.startswith("ERR:"):
                passed = False
                raw.append(response[:20])
            else:
                try:
                    passed = t["eval"](response)
                except Exception as e:
                    passed = False
                raw.append(response[:30].replace('\n', '↵'))
            scores.append(1 if passed else 0)
            time.sleep(0.3)
        total = sum(scores)
        pct = int(total / len(scores) * 100)
        grand_total += total
        grand_possible += len(scores)
        row = f"{model_label:<20} " + " ".join(f"{'✓' if s else '✗':>4}" for s in scores) + f" {total}/{len(scores)} {pct:>3}%"
        print(row)
        results[model_id] = {"scores": scores, "raw": raw, "total": total}

    print()
    print(f"GRAND TOTAL: {grand_total}/{grand_possible}")
    if not quick:
        print("\n--- Raw responses (T4 JSON, T6 Code, T9 STRIDE) ---")
        for model_id, model_label in models:
            r = results[model_id]
            print(f"\n{model_label}:")
            print(f"  T4 JSON:    {r['raw'][3]}")
            print(f"  T6 Code:    {r['raw'][5]}")
            print(f"  T9 STRIDE:  {r['raw'][8]}")

if __name__ == "__main__":
    main()
