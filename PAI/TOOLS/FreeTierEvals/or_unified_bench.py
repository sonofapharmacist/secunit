#!/usr/bin/env python3
"""
OpenRouter 53-pt unified bench — runs T1-T9 + R1-R6 + C1-C6+C8 against
OpenRouter-hosted targets.

Mirrors the structure of unified_bench.ts but lives in Python because T/R
prompts originate from anthropic_compat_*_reasoning scripts (Anthropic format)
and OpenRouter uses OpenAI-compat chat/completions.

Uses the TEST PROMPTS from:
  - T1-T9:  anthropic_compat_eval.py (inlined below)
  - R1-R6:  anthropic_compat_reasoning_probe.py (inlined below)
  - C1-C6+C8: NOT inlined — calls coding_battery.py via subprocess for the
              C battery since the C scoring functions are too large to
              duplicate responsibly.

Usage:
  python3 or_unified_bench.py --model or_hy3
  python3 or_unified_bench.py --model or_longcat2
"""

import os, json, time, subprocess, sys, urllib.request, urllib.error, re, argparse

# ── OpenRouter endpoints (subset of coding_battery.py ENDPOINTS) ─────────────

ENDPOINTS = {
    "or_hy3": {
        "name": "Tencent Hy3 (OpenRouter 65% off)",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "tencent/hy3",
        "passage_key": "api/openrouter",
        "max_tokens": 4096,
        "is_reasoning": False,
        "extra_payload": {"reasoning": {"effort": "none"}},
    },
    "or_longcat2": {
        "name": "Meituan LongCat 2.0 (OpenRouter 60% off)",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "meituan/longcat-2.0",
        "passage_key": "api/openrouter",
        "max_tokens": 16000,
        "is_reasoning": True,
        "extra_payload": {"reasoning": {"effort": "none"}},
    },
    "or_inkling": {
        "name": "Thinking Machines Inkling (975B/41B MoE, OpenRouter)",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "thinkingmachines/inkling",
        "passage_key": "api/openrouter",
        "max_tokens": 16000,
        "is_reasoning": True,
        "extra_payload": {"reasoning": {"effort": "none"}},
    },
    "or_inkling_small": {
        "name": "Thinking Machines Inkling-Small (276B/12B MoE, OpenRouter)",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "thinkingmachines/inkling-small",
        "passage_key": "api/openrouter",
        "max_tokens": 16000,
        "is_reasoning": True,
        "extra_payload": {"reasoning": {"effort": "none"}},
    },
    "or_laguna_s21": {
        "name": "Poolside Laguna S 2.1 (118B/8B MoE, OpenRouter free tier)",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "poolside/laguna-s-2.1:free",
        "passage_key": "api/openrouter",
        "max_tokens": 16000,
        "is_reasoning": True,
        "extra_payload": {"reasoning": {"effort": "none"}},
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
        env_key = os.environ.get("OPENROUTER_API_KEY", "")
        if env_key:
            return env_key
        raise SystemExit(f"FATAL: passage show {passage_key} failed and no env override")


def call_openai_compat(cfg: dict, prompt: str, max_tokens: int = None) -> tuple[str, float, str]:
    """OpenAI-compat chat/completions call. Adds extra_payload if present."""
    api_key = resolve_key(cfg["passage_key"])
    mt = max_tokens or cfg.get("max_tokens", 4096)
    payload = {
        "model": cfg["model"],
        "max_tokens": mt,
        "messages": [{"role": "user", "content": prompt}],
    }
    extra = cfg.get("extra_payload") or {}
    if extra:
        payload.update(extra)

    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        cfg["url"], data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.load(resp)
            elapsed = time.time() - t0
            choices = result.get("choices", [])
            if not choices:
                return "", elapsed, f"ERR:no_choices:{json.dumps(result)[:150]}"
            msg = choices[0].get("message", {})
            content = msg.get("content", "")
            if isinstance(content, list):
                content = "".join(
                    b.get("text", "") for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                )
            if not content:
                return "", elapsed, f"ERR:empty:{json.dumps(result)[:150]}"
            return content, elapsed, ""
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:120]
        return "", time.time() - t0, f"HTTP{e.code}:{body}"
    except Exception as e:
        return "", time.time() - t0, f"EXC:{type(e).__name__}:{str(e)[:80]}"


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


# ── T1-T9 prompt + scorer set (from anthropic_compat_eval.py) ────────────────

T_TESTS = [
    ("T1", "MINIMAL", lambda r: r.strip() == "Acknowledged." or r.strip().startswith("Acknowledged"),
     "Say exactly: 'Acknowledged.' — nothing else.", 1),
    ("T2", "Classify simple", lambda r: r.strip().upper().startswith("NATIVE"),
     "You are a task classifier. Classify as MINIMAL, NATIVE, or ALGORITHM.\n"
     "MINIMAL = ack/greeting/rating. NATIVE = single-step. ALGORITHM = multi-step.\n"
     "Message: \"What's the capital of France?\"\n"
     "Reply with ONLY the word: MINIMAL, NATIVE, or ALGORITHM.", 1),
    ("T3", "Classify multi-step", lambda r: r.strip().upper().startswith("ALGORITHM"),
     "You are a task classifier. Classify as MINIMAL, NATIVE, or ALGORITHM.\n"
     "Message: \"Refactor this entire authentication module to use JWTs, update all tests, "
     "and write a migration guide.\"\n"
     "Reply with ONLY the word: MINIMAL, NATIVE, or ALGORITHM.", 1),
    ("T4", "JSON", lambda r: (lambda j: j.get("status") == "ok" and j.get("count") == 42)(json.JSONDecoder().raw_decode(_strip_fence(r).strip())[0]),
     'Return ONLY valid JSON: {"status": "ok", "count": 42}. No other text.', 1),
    ("T5", "Reasoning", lambda r: "carol" in r.strip().lower(),
     "Alice is taller than Bob. Bob is taller than Carol. Who is shortest? Reply with just the name.", 1),
    ("T6", "Code TS", lambda r: "function" in r and ("return" in r or "=>" in r) and "palindrome" in r.lower(),
     "Write a TypeScript function that returns true if a string is a palindrome. Just the function, no explanation.", 1),
    ("T7", "Instruction follow", lambda r: r.count("•") + r.count("-") + r.count("*") >= 3 or r.count("\n") >= 2,
     "List 3 security vulnerability types. Reply in exactly 3 bullet points, each under 10 words.", 1),
    ("T8", "Tool call", lambda r: r == "TOOL_CALLED",  # T8 has tool call format — handled separately
     "What is the weather in Paris?", 1),
    ("T9", "STRIDE", lambda r: r.strip().upper().startswith("T"),
     "Classify this finding as STRIDE category. Reply with ONLY the letter.\n"
     "Finding: An API endpoint accepts a user_id parameter from the URL and passes it directly to a SQL query without parameterization.\n"
     "Reply with: S, T, R, I, D, or E (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege)", 1),
]
T_MAX = 9  # 9 tests, 1 pt each


def _t8_tool_call(cfg: dict) -> tuple[bool, float, str]:
    """T8 requires a tool call; many OpenAI-compat providers don't support function calling reliably.
    Try with tools; if no tool_call returned, return 0."""
    api_key = resolve_key(cfg["passage_key"])
    payload = {
        "model": cfg["model"],
        "max_tokens": 512,
        "messages": [{"role": "user", "content": "What is the weather in Paris?"}],
        "tools": [{
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get the current weather for a city",
                "parameters": {
                    "type": "object",
                    "properties": {"city": {"type": "string", "description": "The city name"}},
                    "required": ["city"],
                },
            },
        }],
        "tool_choice": "auto",
    }
    extra = cfg.get("extra_payload") or {}
    if extra:
        payload.update(extra)
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        cfg["url"], data=data,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.load(resp)
            elapsed = time.time() - t0
            msg = result.get("choices", [{}])[0].get("message", {})
            if msg.get("tool_calls"):
                return True, elapsed, ""
            return False, elapsed, "no tool_call in response"
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:80]
        return False, time.time() - t0, f"HTTP{e.code}:{body}"
    except Exception as e:
        return False, time.time() - t0, f"EXC:{e}"


# ── R1-R6 (from anthropic_compat_reasoning_probe.py, simplified) ────────────

R_TESTS = [
    ("R1", "Logic knights/knaves", 2,
     "Solve this logic puzzle. A, B, and C are each either a knight (always tells truth) or a knave (always lies).\n"
     "A says: \"B is a knave.\"\n"
     "B says: \"A and C are the same type.\"\n"
     "C says: \"B is a knight.\"\n\n"
     "Who is a knight and who is a knave? Show your reasoning, then give a final answer as: "
     "A=knight/knave, B=knight/knave, C=knight/knave.",
     lambda r: (
         2 if ("a=knight" in r.lower() or "a is a knight" in r.lower())
             and ("b=knave" in r.lower() or "b is a knave" in r.lower())
             and ("c=knave" in r.lower() or "c is a knave" in r.lower())
         else 1 if any(x in r.lower() for x in ["a=knight", "a is a knight", "a is knight"])
         else 0
     )),
    ("R2", "STRIDE JSON", 5,
     "You are a security engineer. Analyze this system and produce a STRIDE threat model.\n\n"
     "System: REST API (Node.js), JWT auth (HS256, secret in env var), user file uploads stored "
     "in S3 with user-controlled filenames, admin panel at /admin protected only by a role field "
     "in the JWT payload, no input sanitization on search endpoint.\n\n"
     "Return a JSON array of exactly 5 threats. Each object must have: \"stride_category\", "
     "\"component\", \"attack_vector\", \"impact\". No markdown fences, just the raw JSON array.",
     # R2 scorer: parse JSON, count valid STRIDE categories
     None),  # handled separately
    ("R3", "Flask vulns", 3,
     "Find every security vulnerability in this Python Flask code. Be specific about what's wrong and why.\n\n"
     "```python\nfrom flask import Flask, request, jsonify\nimport sqlite3\napp = Flask(__name__)\n"
     "@app.route('/user')\ndef get_user():\n    user_id = request.args.get('id')\n"
     "    conn = sqlite3.connect('users.db')\n    cur = conn.cursor()\n"
     "    cur.execute(f\"SELECT * FROM users WHERE id = {user_id}\")\n    row = cur.fetchone()\n"
     "    return jsonify(row)\n"
     "@app.route('/file')\ndef get_file():\n    filename = request.args.get('name')\n"
     "    path = f\"/var/data/{filename}\"\n    with open(path) as f:\n        return f.read()\n"
     "@app.route('/admin/delete', methods=['POST'])\ndef delete_user():\n"
     "    uid = request.json.get('uid')\n    conn = sqlite3.connect('users.db')\n"
     "    cur = conn.cursor()\n    cur.execute(f\"DELETE FROM users WHERE id = {uid}\")\n"
     "    conn.commit()\n    return 'deleted'\n```",
     lambda r: sum([
         1 if any(x in r.lower() for x in ["sql inject", "sqli", "f-string", 'f"select', "format sql"]) else 0,
         1 if any(x in r.lower() for x in ["path travers", "directory travers", "../", "arbitrary file", "lfi"]) else 0,
         1 if any(x in r.lower() for x in ["no auth", "missing auth", "unauthenticat", "no check", "anyone can", "unprotect"]) else 0,
     ])),
    ("R4", "Logic grid", 3,
     "Solve this logic puzzle completely.\n\n"
     "Three people — Alice, Bob, Carol — each have a different job (engineer, designer, manager) "
     "and a different pet (cat, dog, fish).\n\n"
     "Clues:\n"
     "1. The engineer does not have a cat.\n"
     "2. Bob is not the manager.\n"
     "3. Carol has a fish.\n"
     "4. Alice is not the engineer.\n"
     "5. The manager has a dog.\n\n"
     "Who has each job and each pet?",
     lambda r: sum([
         1 if ("alice" in r.lower() and ("designer" in r.lower() or "cat" in r.lower())) else 0,
         1 if ("bob" in r.lower() and ("engineer" in r.lower() or "fish" in r.lower())) else 0,
         1 if ("carol" in r.lower() and "manager" in r.lower()) else 0,
     ])),
    ("R5", "Rate limiter bugs", 2,
     "Find bugs in this Python rate limiter. Be specific about what's wrong and why.\n\n"
     "```python\nimport time\nfrom collections import defaultdict\n\n"
     "class RateLimiter:\n    def __init__(self):\n        self.calls = defaultdict(list)\n"
     "    def allow(self, key, max_calls, window_sec):\n"
     "        now = time.time()\n"
     "        self.calls[key] = [t for t in self.calls[key] if t > now - window_sec]\n"
     "        if len(self.calls[key]) < max_calls:\n"
     "            self.calls[key].append(now)\n"
     "            return True\n"
     "        return False\n```",
     lambda r: sum([
         1 if any(x in r.lower() for x in ["memory leak", "unbounded", "no cleanup", "grows", "never delete", "no eviction"]) else 0,
         1 if any(x in r.lower() for x in ["not thread", "race condition", "concurrent", "atomic", "lock"]) else 0,
     ])),
    ("R6", "Redis vs DynamoDB", 2,
     "Compare Redis and DynamoDB for a session-store use case. Cover: (1) latency, (2) persistence, "
     "(3) cost at ~10M sessions, (4) TTL/expiry handling. Then give a clear recommendation with your primary reason.\n\n"
     "Be concise — max 300 words.",
     None),  # R6 is opinion-based; default: 1 pt if response > 100 words and mentions at least 3 of {latency, persistence, cost, TTL}
]
R_MAX = 17


def _score_r2(raw: str) -> int:
    answer = raw
    answer = re.sub(r'```[a-z]*\n?', '', answer).strip()
    try:
        data = json.loads(answer)
        if not isinstance(data, list):
            m = re.search(r'\[.*\]', answer, re.DOTALL)
            data = json.loads(m.group()) if m else []
    except Exception:
        m = re.search(r'\[.*?\]', raw, re.DOTALL)
        if not m:
            return 0
        try:
            data = json.loads(m.group())
        except Exception:
            return 0
    stride_cats = {"spoofing", "tampering", "repudiation", "information disclosure",
                   "denial", "elevation", "dos", "s", "t", "r", "i", "d", "e"}
    valid = 0
    for item in data[:5]:
        if not isinstance(item, dict):
            continue
        cat = str(item.get("stride_category", "")).lower()
        vec = str(item.get("attack_vector", ""))
        if any(s in cat for s in stride_cats) and len(vec) > 10:
            valid += 1
    return min(valid, 5)


def _score_r6(raw: str) -> int:
    """R6: opinion-based. 1 pt if response has at least 3 of the 4 axes with a clear recommendation."""
    r = raw.lower()
    axes = sum([
        1 if "latency" in r or "lat" in r else 0,
        1 if "persist" in r or "durability" in r or "durable" in r else 0,
        1 if "cost" in r or "price" in r or "expensive" in r or "cheap" in r else 0,
        1 if "ttl" in r or "expir" in r or "eviction" in r else 0,
    ])
    word_count = len(raw.split())
    if axes >= 3 and word_count >= 100 and any(k in r for k in ["recommend", "go with", "use ", "better", "worse"]):
        return 2
    if axes >= 2 or word_count >= 100:
        return 1
    return 0


# ── C battery: shell out to coding_battery.py ────────────────────────────────

def run_c_battery(target_key: str) -> tuple[int, int, str]:
    """Run coding_battery.py with --target. Returns (score, max, raw_output)."""
    proc = subprocess.run(
        ["python3", "/home/realuser/.claude/PAI/TOOLS/FreeTierEvals/coding_battery.py",
         "--target", target_key],
        capture_output=True, text=True, timeout=900,
    )
    out = proc.stdout
    # Parse "SCORE: X/27" from output
    m = re.search(r"SCORE:\s*(\d+)\s*/\s*(\d+)", out)
    if m:
        return int(m.group(1)), int(m.group(2)), out
    return 0, 27, out + "\n[stderr]\n" + proc.stderr


# ── Main runner ───────────────────────────────────────────────────────────────

def run_target(target_key: str) -> dict:
    cfg = ENDPOINTS[target_key]
    print(f"\n{'═' * 80}")
    print(f"53-PT UNIFIED BENCH — {cfg['name']}  ({target_key})")
    print(f"  URL:    {cfg['url']}")
    print(f"  Model:  {cfg['model']}")
    print(f"  Extra:  {cfg.get('extra_payload', {})}")
    print(f"{'═' * 80}")

    results = {"t": [], "r": [], "c": None}
    t_total = 0
    r_total = 0
    wall_start = time.time()

    # ── T1-T9 ──
    print(f"\n=== T1-T9 (max {T_MAX}) ===")
    for tid, label, scorer, prompt, max_pts in T_TESTS:
        if tid == "T8":
            ok, elapsed, err = _t8_tool_call(cfg)
            score = max_pts if ok else 0
        else:
            resp, elapsed, err = call_openai_compat(cfg, prompt)
            if err:
                score = 0
            else:
                try:
                    score = max_pts if scorer(resp) else 0
                except Exception as e:
                    score = 0
                    err = f"scorer_exc:{e}"
        t_total += score
        results["t"].append({"id": tid, "score": score, "max": max_pts, "wall": elapsed, "err": err or ""})
        print(f"  {tid}: {score}/{max_pts}  ({elapsed:.1f}s)  {err or ''}")

    # ── R1-R6 ──
    print(f"\n=== R1-R6 (max {R_MAX}) ===")
    for tid, label, max_pts, prompt, scorer in R_TESTS:
        resp, elapsed, err = call_openai_compat(cfg, prompt, max_tokens=3000)
        if err:
            score = 0
        else:
            if scorer is None:
                score = (_score_r2 if tid == "R2" else _score_r6)(resp)
            else:
                try:
                    score = scorer(resp)
                except Exception as e:
                    score = 0
                    err = f"scorer_exc:{e}"
        r_total += score
        results["r"].append({"id": tid, "score": score, "max": max_pts, "wall": elapsed, "err": err or ""})
        print(f"  {tid}: {score}/{max_pts}  ({elapsed:.1f}s)  {err or ''}")

    # ── C1-C6+C8 ──
    print(f"\n=== C1-C6+C8 (max 27) — running coding_battery.py ===")
    c_score, c_max, c_raw = run_c_battery(target_key)
    c_elapsed = time.time() - wall_start - sum(r["wall"] for r in results["t"] + results["r"])
    results["c"] = {"score": c_score, "max": c_max, "wall": c_elapsed, "raw": c_raw[:500]}
    print(f"  C: {c_score}/{c_max}  ({c_elapsed:.1f}s)")

    wall_total = time.time() - wall_start
    total = t_total + r_total + c_score
    total_max = T_MAX + R_MAX + 27

    print(f"\n{'─' * 80}")
    print(f"  TOTAL: {total}/{total_max}  ({100 * total / total_max:.1f}%)  wall: {wall_total:.1f}s")
    print(f"  T: {t_total}/{T_MAX}   R: {r_total}/{R_MAX}   C: {c_score}/{c_max}")
    print(f"{'═' * 80}")

    return {
        "model": cfg["name"],
        "target": target_key,
        "t_score": t_total, "t_max": T_MAX,
        "r_score": r_total, "r_max": R_MAX,
        "c_score": c_score, "c_max": c_max,
        "total": total, "total_max": total_max,
        "wall_total": wall_total,
        "results": results,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def main():
    parser = argparse.ArgumentParser(description="53-pt unified bench for OpenRouter targets")
    parser.add_argument("--model", required=True, help="Target key (or_hy3, or_longcat2)")
    args = parser.parse_args()

    if args.model not in ENDPOINTS:
        print(f"Unknown target: {args.model}. Available: {', '.join(ENDPOINTS.keys())}")
        sys.exit(1)

    result = run_target(args.model)

    # Save to JSON
    out_path = f"/home/realuser/.claude/PAI/MEMORY/WORK/2026-08-01-discounted-models-bench/or_unified_{args.model}.json"
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2, default=str)
    print(f"\nSaved: {out_path}")


if __name__ == "__main__":
    main()
