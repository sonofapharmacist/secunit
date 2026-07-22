#!/usr/bin/env python3
"""
PAI Anthropic-compat shell fallback eval — 2026-06-15.
Tests GLM-4.5-air (Z.ai) and MiniMax-M3 (MiniMax) on the 9-test deeper battery
modeled on mistral_eval.py T1-T9.

Both endpoints are Anthropic-format:
  POST /v1/messages
  Headers: x-api-key, anthropic-version: 2023-06-01, content-type: application/json

Usage:
  python3 anthropic_compat_eval.py --target glm
  python3 anthropic_compat_eval.py --target m3
  python3 anthropic_compat_eval.py --target all
"""

import os, json, time, subprocess, sys, urllib.request, urllib.error

# ── Endpoints ─────────────────────────────────────────────────────────────────
ENDPOINTS = {
    "sonnet": {
        "name": "Claude Sonnet 4.6 (Anthropic native)",
        "url": "https://api.anthropic.com/v1/messages",
        "model": "claude-sonnet-4-6",
        "passage_key": "api/anthropic",
    },
    "sonnet5": {
        "name": "Claude Sonnet 5 (Anthropic native)",
        "url": "https://api.anthropic.com/v1/messages",
        "model": "claude-sonnet-5",
        "passage_key": "api/anthropic",
    },
    "opus": {
        "name": "Claude Opus 4.8 (Anthropic native)",
        "url": "https://api.anthropic.com/v1/messages",
        "model": "claude-opus-4-8",
        "passage_key": "api/anthropic",
    },
    "haiku": {
        "name": "Claude Haiku 4.5 (Anthropic native)",
        "url": "https://api.anthropic.com/v1/messages",
        "model": "claude-haiku-4-5-20251001",
        "passage_key": "api/anthropic",
    },
    "glm": {
        "name": "Z.ai GLM-4.5-air",
        "url": "https://api.z.ai/api/anthropic/v1/messages",
        "model": "glm-4.5-air",
        "passage_key": "api/glm",
    },
    "glm47": {
        "name": "Z.ai GLM-4.7 (Tier 1 fallback #1)",
        "url": "https://api.z.ai/api/anthropic/v1/messages",
        "model": "glm-4.7",
        "passage_key": "api/glm",
    },
    "glm52": {
        "name": "Z.ai GLM-5.1 (top of Z.ai catalog — synthesis referenced glm-5.2[1m] which doesn't exist)",
        "url": "https://api.z.ai/api/anthropic/v1/messages",
        "model": "glm-5.1",
        "passage_key": "api/glm",
    },
    "glm52-1m": {
        "name": "Z.ai GLM-5.2 (1M ctx by default, 3x quota — emergency-only per 2026-06-16 quota wall finding)",
        "url": "https://api.z.ai/api/anthropic/v1/messages",
        "model": "glm-5.2",
        "passage_key": "api/glm",
    },
    "m3": {
        "name": "MiniMax M3 (512K)",
        "url": "https://api.minimax.io/anthropic/v1/messages",
        "model": "MiniMax-M3",
        "passage_key": "api/minimax",
    },
    # Claude Fable 5 — first of Claude 5 family, gated behind always-on thinking;
    # no temperature/top_p/top_k; effort dial via output_config.effort.
    # 30-day retention mandatory (org default is fine; zero-retention orgs get a 400).
    # Per Ken Huang 2026-07-05: post-7/1 retraining flags security-adjacent prompts
    # more aggressively. Refusals arrive as stop_reason="refusal" in a 200 response.
    "fable5": {
        "name": "Claude Fable 5 (Claude 5 family, thinking always-on)",
        "url": "https://api.anthropic.com/v1/messages",
        "model": "claude-fable-5",
        "passage_key": "api/anthropic",
    },
}


def resolve_key(passage_key: str) -> str:
    try:
        out = subprocess.run(
            ["passage", "show", passage_key],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        env_key = os.environ.get("ANTHROPIC_API_KEY")
        if env_key:
            return env_key
        raise


# ── Test battery — modeled on mistral_eval.py T1-T9 ──────────────────────────

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
        "eval": lambda r: r.strip().upper() == "NATIVE",
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
        "eval": lambda r: r.strip().upper() == "ALGORITHM",
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
            "name": "get_weather",
            "description": "Get the current weather for a city",
            "input_schema": {
                "type": "object",
                "properties": {
                    "city": {"type": "string", "description": "The name of the city"}
                },
                "required": ["city"]
            }
        }],
        "eval": "TOOL_CALL",  # sentinel — handled in main loop
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
        j = json.loads(s)
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


# ── API call — Anthropic format ──────────────────────────────────────────────

# Fable 5 effort dial: low | medium | high | xhigh | max (default high).
# Threaded via --effort=<level> or --effort <level> on the CLI; applies only to Fable 5.
_DEFAULT_EFFORT = "high"
_VALID_EFFORT = {"low", "medium", "high", "xhigh", "max"}

def _effort_level() -> str:
    """Parse --effort=<level> or --effort <level> from argv. Default "high"."""
    args = sys.argv
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith("--effort="):
            v = a.split("=", 1)[1]
        elif a == "--effort" and i + 1 < len(args):
            v = args[i + 1]
            i += 1
        else:
            i += 1
            continue
        if v not in _VALID_EFFORT:
            raise SystemExit(f"--effort must be one of {sorted(_VALID_EFFORT)}, got {v!r}")
        return v
    return _DEFAULT_EFFORT


def call_api(target_key: str, prompt: str, tools=None, max_tokens: int = 512) -> tuple[str, dict, str]:
    """Returns (response_text_or_marker, usage, raw_or_error)."""
    cfg = ENDPOINTS[target_key]
    api_key = resolve_key(cfg["passage_key"])

    payload = {
        "model": cfg["model"],
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    if tools:
        payload["tools"] = tools
    # Fable 5: effort via output_config. Thinking is always-on, no temperature/top_p.
    if cfg["model"] == "claude-fable-5":
        payload["output_config"] = {"effort": _effort_level()}

    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        cfg["url"], data=data,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.load(resp)
            usage = result.get("usage", {})
            stop_reason = result.get("stop_reason")
            content = result.get("content", [])
            # Anthropic format: content is a list of blocks
            # tool_use blocks have type="tool_use"; text blocks have type="text"
            tool_calls = [b for b in content if isinstance(b, dict) and b.get("type") == "tool_use"]
            if tool_calls:
                return "TOOL_CALLED", usage, json.dumps(result)[:200]
            # Fable 5 (and any future Anthropic model) can refuse inside a 200.
            # stop_reason="refusal" is the canonical signal; log it and treat as a
            # clean failed test rather than crashing the run.
            if stop_reason == "refusal":
                details = (result.get("stop_details") or {}).get("reason", "refused")
                return f"REFUSAL:{details}", usage, json.dumps(result)[:200]
            text_blocks = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
            text = "".join(text_blocks)
            if not text:
                return f"ERR:empty_content:{json.dumps(result)[:200]}", usage, json.dumps(result)[:200]
            return text, usage, text[:80]
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return f"ERR:{e.code}:{body[:120]}", {}, f"HTTP {e.code}: {body[:120]}"
    except Exception as e:
        return f"ERR:{type(e).__name__}:{str(e)[:80]}", {}, f"{type(e).__name__}: {str(e)[:80]}"


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    target_filter = "all"
    for i, arg in enumerate(sys.argv):
        if arg == "--target" and i + 1 < len(sys.argv):
            target_filter = sys.argv[i + 1]

    targets = [k for k in ENDPOINTS.keys() if target_filter == "all" or k == target_filter]
    if not targets:
        print(f"Unknown target: {target_filter}. Use: glm, m3, all")
        sys.exit(1)

    for t in targets:
        run_target(t)


def run_target(target_key: str):
    cfg = ENDPOINTS[target_key]
    print(f"\n{'═' * 80}")
    print(f"TARGET: {cfg['name']}")
    print(f"  URL:    {cfg['url']}")
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
        elif response.startswith("REFUSAL:"):
            passed = False
            marker = "✗ REFUSAL"
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

    # Save results — include effort suffix for Fable 5 runs so multiple effort levels
    # coexist on disk instead of clobbering each other.
    effort_tag = f"-{_effort_level()}" if cfg["model"] == "claude-fable-5" else ""
    out_path = f"/home/realuser/.claude/PAI/MEMORY/WORK/2026-06-15-shell-fallback-deeper-tests/results-{target_key}{effort_tag}.json"
    with open(out_path, "w") as f:
        json.dump({
            "target": cfg["name"],
            "model": cfg["model"],
            "endpoint": cfg["url"],
            "timestamp": "2026-06-15",
            "score": f"{grand_total}/{len(TESTS)}",
            "results": results,
        }, f, indent=2)
    print(f"\nResults saved: {out_path}")


if __name__ == "__main__":
    main()
