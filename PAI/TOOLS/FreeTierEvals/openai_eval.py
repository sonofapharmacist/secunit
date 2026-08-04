#!/usr/bin/env python3
"""
PAI OpenAI-native shell fallback eval — 2026-06-16.
Tests the gpt-5.x and gpt-4.x lines on the 9-test deeper battery
modeled on mistral_eval.py T1-T9.

OpenAI format:
  POST /v1/chat/completions
  Headers: Authorization: Bearer ..., Content-Type: application/json

Usage:
  python3 openai_eval.py --target gpt55
  python3 openai_eval.py --target all
"""

import os, json, time, subprocess, sys, urllib.request, urllib.error

# ── Endpoints ────────────────────────────────────────────────────────────────
ENDPOINTS = {
    "gpt55": {
        "name": "OpenAI GPT-5.5 (top tier, native)",
        "model": "gpt-5.5",
        "passage_key": "api/openai",
    },
    "gpt54": {
        "name": "OpenAI GPT-5.4 (current Forge default)",
        "model": "gpt-5.4",
        "passage_key": "api/openai",
    },
    "gpt52": {
        "name": "OpenAI GPT-5.2",
        "model": "gpt-5.2",
        "passage_key": "api/openai",
    },
    "gpt5mini": {
        "name": "OpenAI GPT-5-mini (cost-optimized flagship)",
        "model": "gpt-5-mini",
        "passage_key": "api/openai",
    },
    "gpt41": {
        "name": "OpenAI GPT-4.1 (mature frontier)",
        "model": "gpt-4.1",
        "passage_key": "api/openai",
    },
    "gpt4o": {
        "name": "OpenAI GPT-4o (legacy default)",
        "model": "gpt-4o",
        "passage_key": "api/openai",
    },
    # GPT-5.6 family via OpenRouter (same price as OpenAI native per 2026-07-30
    # pricing announcement; no direct OpenAI-native access at bench time).
    "gpt56sol": {
        "name": "OpenAI GPT-5.6 Sol (flagship, via OpenRouter)",
        "model": "openai/gpt-5.6-sol",
        "passage_key": "api/openrouter",
        "url": "https://openrouter.ai/api/v1/chat/completions",
    },
    "gpt56terra": {
        "name": "OpenAI GPT-5.6 Terra (balanced, via OpenRouter)",
        "model": "openai/gpt-5.6-terra",
        "passage_key": "api/openrouter",
        "url": "https://openrouter.ai/api/v1/chat/completions",
    },
    "gpt56luna": {
        "name": "OpenAI GPT-5.6 Luna (fast/cheap, via OpenRouter)",
        "model": "openai/gpt-5.6-luna",
        "passage_key": "api/openrouter",
        "url": "https://openrouter.ai/api/v1/chat/completions",
    },
}

DEFAULT_URL = "https://api.openai.com/v1/chat/completions"


def resolve_key(passage_key: str) -> str:
    try:
        out = subprocess.run(
            ["passage", "show", passage_key],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        env_key = os.environ.get("OPENAI_API_KEY")
        if env_key:
            return env_key
        raise


# ── Test battery — modeled on anthropic_compat_eval.py T1-T9 ─────────────────

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
        "prompt": (
            "You are a task classifier. Classify as MINIMAL, NATIVE, or ALGORITHM.\n"
            "MINIMAL = ack/greeting/rating. NATIVE = single-step. ALGORITHM = multi-step.\n"
            "Message: \"What's the capital of France?\"\n"
            "Reply with ONLY the word: MINIMAL, NATIVE, or ALGORITHM."
        ),
        "eval": lambda r: r.strip().upper().startswith("NATIVE"),
        "scoring": "exact",
    },
    {
        "id": "T3_classify2",
        "label": "Classify — multi-step task",
        "prompt": (
            "You are a task classifier. Classify as MINIMAL, NATIVE, or ALGORITHM.\n"
            "Message: \"Refactor this entire authentication module to use JWTs, update all tests, "
            "and write a migration guide.\"\n"
            "Reply with ONLY the word: MINIMAL, NATIVE, or ALGORITHM."
        ),
        "eval": lambda r: r.strip().upper().startswith("ALGORITHM"),
        "scoring": "exact",
    },
    {
        "id": "T4_json",
        "label": "JSON — structured",
        "prompt": 'Return ONLY valid JSON: {"status": "ok", "count": 42}. No other text.',
        "eval": lambda r: _check_json(r),
        "scoring": "parse+match",
    },
    {
        "id": "T5_reasoning",
        "label": "Reasoning — logic puzzle",
        "prompt": (
            "Alice is taller than Bob. Bob is taller than Carol. Who is shortest? "
            "Reply with just the name."
        ),
        "eval": lambda r: "carol" in r.strip().lower(),
        "scoring": "contains",
    },
    {
        "id": "T6_code",
        "label": "Code gen — TypeScript function",
        "prompt": (
            "Write a TypeScript function that returns true if a string is a palindrome. "
            "Just the function, no explanation."
        ),
        "eval": lambda r: "function" in r and ("return" in r or "=>" in r) and "palindrome" in r.lower(),
        "scoring": "code-check",
    },
    {
        "id": "T7_instruction_follow",
        "label": "Instruction — length constraint",
        "prompt": (
            "List 3 security vulnerability types. Reply in exactly 3 bullet points, each under 10 words."
        ),
        "eval": lambda r: r.count("•") + r.count("-") + r.count("*") >= 3 or r.count("\n") >= 2,
        "scoring": "format",
    },
    {
        "id": "T8_tool_call",
        "label": "Function calling",
        "prompt": "What is the weather in Paris?",
        "tools": [{
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get the current weather for a city",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "city": {"type": "string", "description": "The name of the city"}
                    },
                    "required": ["city"]
                }
            }
        }],
        "eval": "TOOL_CALL",
        "scoring": "tool-use",
    },
    {
        "id": "T9_strategic_reasoning",
        "label": "STRIDE — security classification",
        "prompt": (
            "Classify this finding as STRIDE category. Reply with ONLY the letter.\n"
            "Finding: An API endpoint accepts a user_id parameter from the URL and passes it directly "
            "to a SQL query without parameterization.\n"
            "Reply with: S, T, R, I, D, or E (Spoofing, Tampering, Repudiation, Information Disclosure, "
            "Denial of Service, Elevation of Privilege)"
        ),
        "eval": lambda r: r.strip().upper().startswith("T"),
        "scoring": "exact",
    },
]


def _check_json(raw: str) -> bool:
    s = _strip_fence(raw)
    try:
        j = json.JSONDecoder().raw_decode(s.strip())[0]
        return j.get("status") == "ok" and j.get("count") == 42
    except Exception:
        return False


def _strip_fence(s: str) -> str:
    s = s.strip()
    if s.startswith("```"):
        s = s.strip("`")
        if s.startswith("json"):
            s = s[4:]
        s = s.strip()
    if s.lower().startswith("json"):
        s = s[4:].lstrip()
    return s


# ── API call — OpenAI format ────────────────────────────────────────────────

def call_api(target_key: str, prompt: str, tools=None, max_tokens: int = 512) -> tuple[str, dict, str]:
    """Returns (response_text_or_marker, usage, raw_or_error)."""
    cfg = ENDPOINTS[target_key]
    api_key = resolve_key(cfg["passage_key"])
    url = cfg.get("url", DEFAULT_URL)
    # OpenAI native gpt-5.x rejects `max_tokens` and requires `max_completion_tokens`;
    # OpenRouter's OpenAI-compat layer wants standard `max_tokens`.
    token_field = "max_completion_tokens" if url == DEFAULT_URL else "max_tokens"

    payload = {
        "model": cfg["model"],
        token_field: max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    if tools:
        payload["tools"] = tools

    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.load(resp)
            choices = result.get("choices", [])
            usage = result.get("usage", {})
            if not choices:
                return f"ERR:no_choices:{json.dumps(result)[:200]}", usage, json.dumps(result)[:200]
            msg = choices[0].get("message", {})
            content = msg.get("content")
            tool_calls = msg.get("tool_calls")
            if tool_calls:
                return "TOOL_CALLED", usage, json.dumps(result)[:200]
            if content is None:
                return f"ERR:content_null:{json.dumps(result)[:200]}", usage, json.dumps(result)[:200]
            if isinstance(content, list):
                # Reasoning models sometimes return content as a list of blocks
                text = "".join(
                    b.get("text", "") for b in content
                    if isinstance(b, dict) and b.get("type") in ("text", None)
                )
                if not text:
                    return f"ERR:no_text_blocks:{json.dumps(result)[:200]}", usage, json.dumps(result)[:200]
                return text, usage, text[:80]
            return content, usage, content[:80]
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode()[:120]
        except Exception:
            pass
        return f"ERR:{e.code}:{body}", {}, f"HTTP {e.code}: {body}"
    except Exception as e:
        return f"ERR:{type(e).__name__}:{str(e)[:80]}", {}, f"{type(e).__name__}: {str(e)[:80]}"


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    target_filter = "all"
    for i, arg in enumerate(sys.argv):
        if arg == "--target" and i + 1 < len(sys.argv):
            target_filter = sys.argv[i + 1]

    targets = [k for k in ENDPOINTS.keys() if target_filter == "all" or k == target_filter]
    if not targets:
        print(f"Unknown target: {target_filter}. Use: {', '.join(ENDPOINTS.keys())}, all")
        sys.exit(1)

    for t in targets:
        run_target(t)


def run_target(target_key: str):
    cfg = ENDPOINTS[target_key]
    print(f"\n{'═' * 80}")
    print(f"TARGET: {cfg['name']}")
    print(f"  Model:  {cfg['model']}")
    print(f"  Key:    passage {cfg['passage_key']}")
    print(f"{'═' * 80}")
    print(f"{'Test':<22} {'Result':>8} {'Latency':>10} {'Raw (first 60ch)':<60}")
    print("-" * 100)

    results = []
    grand_total = 0
    for t in TESTS:
        tools = t.get("tools")
        t0 = time.time()
        try:
            response, usage, raw = call_api(target_key, t["prompt"], tools=tools, max_tokens=512)
        except Exception as e:
            response, usage, raw = f"ERR:TOP:{type(e).__name__}", {}, str(e)[:60]
        elapsed = time.time() - t0

        if response == "TOOL_CALLED":
            passed = True
            marker = "✓ TOOL"
        elif response.startswith("ERR:"):
            passed = False
            marker = "✗ ERR"
        else:
            try:
                passed = t["eval"](response)
            except Exception as e:
                passed = False
                marker = f"✗ EVAL:{type(e).__name__}"
            else:
                marker = "✓" if passed else "✗"

        results.append({"id": t["id"], "passed": passed, "raw": raw, "elapsed": elapsed, "marker": marker, "response": response[:120]})
        grand_total += int(passed)
        print(f"{t['id']:<22} {marker:>8} {elapsed:>8.2f}s  {raw[:60]:<60}")

    print("-" * 100)
    print(f"SCORE: {grand_total}/{len(TESTS)}  ({int(grand_total/len(TESTS)*100)}%)")

    out_path = f"/home/realuser/.claude/PAI/MEMORY/WORK/2026-06-15-shell-fallback-deeper-tests/results-openai-{target_key}.json"
    with open(out_path, "w") as f:
        json.dump({
            "target": cfg["name"],
            "model": cfg["model"],
            "endpoint": "https://api.openai.com/v1/chat/completions",
            "timestamp": "2026-06-16",
            "score": f"{grand_total}/{len(TESTS)}",
            "results": results,
        }, f, indent=2)
    print(f"\nResults saved: {out_path}")


if __name__ == "__main__":
    main()
