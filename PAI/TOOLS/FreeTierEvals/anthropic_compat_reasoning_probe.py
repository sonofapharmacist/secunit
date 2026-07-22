#!/usr/bin/env python3
"""
PAI Anthropic-compat 17-point reasoning probe — 2026-06-15.
R1-R6 from nim_eval.py / reasoning_eval.py (max 17 points total).
Tests reasoning depth beyond the 9-test battery — knights/knaves, STRIDE→JSON,
Flask vulns, logic grid, rate-limiter bugs, Redis-vs-DynamoDB tradeoff.

Anthropic format via Z.ai GLM-4.5-air endpoint.

Usage:
  python3 anthropic_compat_reasoning_probe.py --target glm
"""

import os, json, time, subprocess, sys, urllib.request, urllib.error, re

ENDPOINTS = {
    "sonnet": {
        "name": "Claude Sonnet 4.6 (Anthropic native)",
        "url": "https://api.anthropic.com/v1/messages",
        "model": "claude-sonnet-4-6",
        "passage_key": "api/anthropic",
        "is_reasoning": False,
    },
    "sonnet5": {
        "name": "Claude Sonnet 5 (Anthropic native)",
        "url": "https://api.anthropic.com/v1/messages",
        "model": "claude-sonnet-5",
        "passage_key": "api/anthropic",
        "is_reasoning": False,
    },
    "opus": {
        "name": "Claude Opus 4.8 (Anthropic native)",
        "url": "https://api.anthropic.com/v1/messages",
        "model": "claude-opus-4-8",
        "passage_key": "api/anthropic",
        "is_reasoning": False,
    },
    "haiku": {
        "name": "Claude Haiku 4.5 (Anthropic native)",
        "url": "https://api.anthropic.com/v1/messages",
        "model": "claude-haiku-4-5-20251001",
        "passage_key": "api/anthropic",
        "is_reasoning": False,
    },
    "glm": {
        "name": "Z.ai GLM-4.5-air",
        "url": "https://api.z.ai/api/anthropic/v1/messages",
        "model": "glm-4.5-air",
        "passage_key": "api/glm",
        "is_reasoning": True,
    },
    "glm47": {
        "name": "Z.ai GLM-4.7 (Tier 1 fallback #1)",
        "url": "https://api.z.ai/api/anthropic/v1/messages",
        "model": "glm-4.7",
        "passage_key": "api/glm",
        "is_reasoning": True,
    },
    "glm52": {
        "name": "Z.ai GLM-5.1 (top of Z.ai catalog — synthesis referenced glm-5.2[1m] which doesn't exist)",
        "url": "https://api.z.ai/api/anthropic/v1/messages",
        "model": "glm-5.1",
        "passage_key": "api/glm",
        "is_reasoning": True,
    },
    "glm52-1m": {
        "name": "Z.ai GLM-5.2 (1M ctx by default, 3x quota — emergency-only per 2026-06-16 quota wall finding)",
        "url": "https://api.z.ai/api/anthropic/v1/messages",
        "model": "glm-5.2",
        "passage_key": "api/glm",
        "is_reasoning": True,
    },
    "m3": {
        "name": "MiniMax M3 (512K)",
        "url": "https://api.minimax.io/anthropic/v1/messages",
        "model": "MiniMax-M3",
        "passage_key": "api/minimax",
        "is_reasoning": True,
    },
    # Claude Fable 5 — first of Claude 5 family, thinking always-on.
    # Per Ken Huang 2026-07-05: post-7/1 retraining flags security-adjacent
    # prompts more aggressively; refusals arrive as stop_reason="refusal".
    "fable5": {
        "name": "Claude Fable 5 (Claude 5 family, thinking always-on)",
        "url": "https://api.anthropic.com/v1/messages",
        "model": "claude-fable-5",
        "passage_key": "api/anthropic",
        "is_reasoning": True,
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


# Fable 5 effort dial: low | medium | high | xhigh | max (default high).
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


# ── Scorers ────────────────────────────────────────────────────────────────────

def _score_stride(raw: str) -> int:
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
    stride_cats = {"spoofing","tampering","repudiation","information disclosure",
                   "denial","elevation","dos","s","t","r","i","d","e"}
    valid = 0
    for item in data[:5]:
        if not isinstance(item, dict):
            continue
        cat = str(item.get("stride_category","")).lower()
        vec = str(item.get("attack_vector",""))
        if any(s in cat for s in stride_cats) and len(vec) > 10:
            valid += 1
    return min(valid, 5)


# ── Tests (R1-R6, max 17 points) ──────────────────────────────────────────────

TESTS = [
    {
        "id": "R1",
        "label": "Logic (knights/knaves)",
        "max_tokens": 1500,
        "max_score": 2,
        "scorer": lambda r: (
            2 if ("a=knight" in r.lower() or "a is a knight" in r.lower()) and
                 ("b=knave" in r.lower() or "b is a knave" in r.lower()) and
                 ("c=knave" in r.lower() or "c is a knave" in r.lower())
            else 1 if any(x in r.lower() for x in ["a=knight","a is a knight","a is knight"])
            else 0
        ),
        "prompt": (
            "Solve this logic puzzle. A, B, and C are each either a knight (always tells truth) "
            "or a knave (always lies).\n"
            "A says: \"B is a knave.\"\n"
            "B says: \"A and C are the same type.\"\n"
            "C says: \"B is a knight.\"\n\n"
            "Who is a knight and who is a knave? Show your reasoning, then give a final answer as: "
            "A=knight/knave, B=knight/knave, C=knight/knave."
        ),
    },
    {
        "id": "R2",
        "label": "STRIDE → JSON",
        "max_tokens": 2500,
        "max_score": 5,
        "scorer": _score_stride,
        "prompt": (
            "You are a security engineer. Analyze this system and produce a STRIDE threat model.\n\n"
            "System: REST API (Node.js), JWT auth (HS256, secret in env var), user file uploads stored "
            "in S3 with user-controlled filenames, admin panel at /admin protected only by a role field "
            "in the JWT payload, no input sanitization on search endpoint.\n\n"
            "Return a JSON array of exactly 5 threats. Each object must have: \"stride_category\", "
            "\"component\", \"attack_vector\", \"impact\". No markdown fences, just the raw JSON array."
        ),
    },
    {
        "id": "R3",
        "label": "Flask vulns",
        "max_tokens": 1200,
        "max_score": 3,
        "scorer": lambda r: sum([
            1 if any(x in r.lower() for x in ["sql inject","sqli","f-string","f\"select","format sql"]) else 0,
            1 if any(x in r.lower() for x in ["path travers","directory travers","../","arbitrary file","lfi"]) else 0,
            1 if any(x in r.lower() for x in ["no auth","missing auth","unauthenticat","no check","anyone can","unprotect"]) else 0,
        ]),
        "prompt": (
            "Find every security vulnerability in this Python Flask code. Be specific about what's wrong "
            "and why.\n\n"
            "```python\n"
            "from flask import Flask, request, jsonify\n"
            "import sqlite3\n\n"
            "app = Flask(__name__)\n\n"
            "@app.route('/user')\n"
            "def get_user():\n"
            "    user_id = request.args.get('id')\n"
            "    conn = sqlite3.connect('users.db')\n"
            "    cur = conn.cursor()\n"
            "    cur.execute(f\"SELECT * FROM users WHERE id = {user_id}\")\n"
            "    row = cur.fetchone()\n"
            "    return jsonify(row)\n\n"
            "@app.route('/file')\n"
            "def get_file():\n"
            "    filename = request.args.get('name')\n"
            "    path = f\"/var/data/{filename}\"\n"
            "    with open(path) as f:\n"
            "        return f.read()\n\n"
            "@app.route('/admin/delete', methods=['POST'])\n"
            "def delete_user():\n"
            "    uid = request.json.get('uid')\n"
            "    conn = sqlite3.connect('users.db')\n"
            "    cur = conn.cursor()\n"
            "    cur.execute(f\"DELETE FROM users WHERE id = {uid}\")\n"
            "    conn.commit()\n"
            "    return 'deleted'\n"
            "```"
        ),
    },
    {
        "id": "R4",
        "label": "Logic grid",
        "max_tokens": 2000,
        "max_score": 3,
        "scorer": lambda r: sum([
            1 if ("alice" in r.lower() and ("designer" in r.lower() or "cat" in r.lower())) else 0,
            1 if ("bob" in r.lower() and ("engineer" in r.lower() or "fish" in r.lower())) else 0,
            1 if ("carol" in r.lower() and "manager" in r.lower()) else 0,
        ]),
        "prompt": (
            "Solve this logic puzzle completely.\n\n"
            "Three people — Alice, Bob, Carol — each have a different job (engineer, designer, manager) "
            "and a different pet (cat, dog, fish).\n\n"
            "Clues:\n"
            "1. The engineer does not have a cat.\n"
            "2. Bob is not the manager.\n"
            "3. Carol has a dog.\n"
            "4. The designer has a cat.\n"
            "5. Alice is not the engineer.\n\n"
            "State each person's job and pet. Show your reasoning."
        ),
    },
    {
        "id": "R5",
        "label": "Rate limiter bugs",
        "max_tokens": 1500,
        "max_score": 2,
        "scorer": lambda r: sum([
            1 if any(x in r.lower() for x in ["off-by-one","off by one","11 request","allows 11","limit + 1","exceeds limit","one extra","11 calls"]) else 0,
            1 if any(x in r.lower() for x in ["memory leak","unbounded","never clean","never delet","grow indefin","accumulate","no cleanup","stale entry","not removed","no reset","window reset","not reset","window expir"]) else 0,
        ]),
        "prompt": (
            "Review this TypeScript rate limiter. What bugs or edge cases does it have? Be specific.\n\n"
            "```typescript\n"
            "const counts: Record<string, number> = {};\n"
            "const windows: Record<string, number> = {};\n\n"
            "export function rateLimit(userId: string, limit: number = 10): boolean {\n"
            "  const now = Date.now();\n"
            "  const windowMs = 60_000;\n\n"
            "  if (!windows[userId] || now - windows[userId] > windowMs) {\n"
            "    windows[userId] = now;\n"
            "    counts[userId] = 1;\n"
            "    return true;\n"
            "  }\n\n"
            "  counts[userId]++;\n"
            "  return counts[userId] <= limit;\n"
            "}\n"
            "```"
        ),
    },
    {
        "id": "R6",
        "label": "Redis vs DynamoDB",
        "max_tokens": 1500,
        "max_score": 2,
        "scorer": lambda r: sum([
            1 if sum(1 for kw in ["cost","latency","p99","operation","burden","ttl","expir"] if kw in r.lower()) >= 3 else 0,
            1 if (any(x in r.lower() for x in ["recommend","prefer","choose","go with","suggest","dynamo","redis"]) and
                  any(x in r.lower() for x in ["because","reason","due to","given","since","lower cost","simpler"])) else 0,
        ]),
        "prompt": (
            "We need to store 10 million active user sessions (each ~2KB). Compare Redis Cluster vs "
            "DynamoDB on these axes: (1) cost at 10M sessions, (2) latency p99, (3) operational burden, "
            "(4) TTL/expiry handling. Then give a clear recommendation with your primary reason.\n\n"
            "Be concise — max 300 words."
        ),
    },
]

MAX_SCORE_TOTAL = sum(t["max_score"] for t in TESTS)  # 17


# ── Anthropic-format caller ───────────────────────────────────────────────────

def call_anthropic(target_key: str, prompt: str, max_tokens: int, is_reasoning: bool) -> tuple[str, float, str]:
    cfg = ENDPOINTS[target_key]
    api_key = resolve_key(cfg["passage_key"])

    # Reasoning models need bigger budgets
    effective_max = max(max_tokens, 2048) if is_reasoning else max_tokens

    payload = {
        "model": cfg["model"],
        "max_tokens": effective_max,
        "messages": [{"role": "user", "content": prompt}],
    }
    # Fable 5: effort dial only; no temperature, no thinking param (always-on).
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
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.load(resp)
            elapsed = time.time() - t0
            stop_reason = result.get("stop_reason")
            content = result.get("content", [])
            # Fable 5 (and other Claude 5 family) refuses inside 200s.
            if stop_reason == "refusal":
                details = (result.get("stop_details") or {}).get("reason", "refused")
                return "", elapsed, f"REFUSAL:{details}"
            text_blocks = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
            text = "".join(text_blocks)
            if not text:
                return "", elapsed, f"ERR:empty:{json.dumps(result)[:150]}"
            return text, elapsed, ""
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:120]
        return "", time.time() - t0, f"HTTP{e.code}:{body}"
    except Exception as e:
        return "", time.time() - t0, f"EXC:{type(e).__name__}:{str(e)[:80]}"


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
    print(f"17-POINT REASONING PROBE — {cfg['name']}")
    print(f"  URL:    {cfg['url']}")
    print(f"  Model:  {cfg['model']}")
    print(f"  Max pts: {MAX_SCORE_TOTAL}")
    print(f"{'═' * 80}")

    print(f"\n{'Test':<6} {'Score':>8} {'/max':>6} {'Latency':>10}  Notes")
    print("─" * 100)

    results = []
    grand_total = 0
    grand_possible = 0
    wall_total = 0.0

    for t in TESTS:
        t0 = time.time()
        response, elapsed, err = call_anthropic(target_key, t["prompt"], t["max_tokens"], cfg["is_reasoning"])
        wall_total += elapsed
        if err:
            label = "REFUSAL" if err.startswith("REFUSAL:") else "ERR"
            print(f"  {t['id']:<4}  {label:>8} {'—':>6} {elapsed:>8.2f}s  {err[:60]}")
            results.append({"id": t["id"], "score": 0, "max": t["max_score"], "err": err, "raw": ""})
            grand_possible += t["max_score"]
            time.sleep(1.0)
            continue
        sc = t["scorer"](response)
        results.append({
            "id": t["id"], "score": sc, "max": t["max_score"],
            "elapsed": elapsed, "raw": response[:400], "err": "",
        })
        grand_total += sc
        grand_possible += t["max_score"]
        marker = "✓" if sc == t["max_score"] else ("~" if sc > 0 else "✗")
        print(f"  {t['id']:<4}  {marker} {sc}/{t['max_score']:<4} {'/':>3}{t['max_score']:<3} {elapsed:>8.2f}s  raw[:60]={response[:60]!r}")
        time.sleep(1.0)

    print("─" * 100)
    pct = 100 * grand_total / grand_possible if grand_possible else 0
    print(f"SCORE: {grand_total}/{grand_possible}  ({pct:.0f}%)  wall: {wall_total:.1f}s")

    # Save results — include effort suffix for Fable 5 runs so multiple effort levels
    # coexist on disk instead of clobbering each other.
    effort_tag = f"-{_effort_level()}" if cfg["model"] == "claude-fable-5" else ""
    out_path = f"/home/realuser/.claude/PAI/MEMORY/WORK/2026-06-15-shell-fallback-deeper-tests/reasoning-probe-{target_key}{effort_tag}.json"
    with open(out_path, "w") as f:
        json.dump({
            "target": cfg["name"],
            "model": cfg["model"],
            "endpoint": cfg["url"],
            "timestamp": "2026-06-15",
            "max_score_total": MAX_SCORE_TOTAL,
            "score": f"{grand_total}/{grand_possible}",
            "pct": pct,
            "wall_s": wall_total,
            "results": results,
        }, f, indent=2)
    print(f"\nResults saved: {out_path}")


if __name__ == "__main__":
    main()
