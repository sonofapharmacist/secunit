#!/usr/bin/env python3
"""
PAI Gemini R1-R6 reasoning probe — unified 53-pt suite parity.
Same prompts and scorers as mistral_reasoning_probe.py / anthropic_compat_reasoning_probe.py.
Uses Gemini native API (generativelanguage.googleapis.com), not OpenAI-compat.

Usage:
  python3 gemini_reasoning_probe.py --target flash_lite_25
  python3 gemini_reasoning_probe.py --target flash_25
  python3 gemini_reasoning_probe.py --target flash_35
  python3 gemini_reasoning_probe.py --target flash_lite_31
  python3 gemini_reasoning_probe.py --target all
"""
import os, json, time, subprocess, sys, urllib.request, urllib.error, re

BASE = "https://generativelanguage.googleapis.com/v1beta/models"

# Tier 1 RPM limits from AI Studio (tldr-insights project, 2026-07-06):
#   Flash-Lite (2.5 + 3.1): 4,000 RPM → sleep 0s (response latency >> rate limit gap)
#   Flash 2.5 + 3.5:        1,000 RPM → sleep 0.5s (light safety margin)
ENDPOINTS = {
    "flash_lite_25": {
        "name": "Gemini 2.5 Flash-Lite",
        "model": "gemini-2.5-flash-lite",
        "passage_key": "api/gemini",
        "thinking": False,
        "sleep": 0,   # 4K RPM Tier 1
    },
    "flash_25": {
        "name": "Gemini 2.5 Flash",
        "model": "gemini-2.5-flash",
        "passage_key": "api/gemini",
        "thinking": True,
        "sleep": 0.5,  # 1K RPM Tier 1
    },
    "flash_35": {
        "name": "Gemini 3.5 Flash",
        "model": "gemini-3.5-flash",
        "passage_key": "api/gemini",
        "thinking": True,
        "sleep": 0.5,  # 1K RPM Tier 1
    },
    "flash_lite_31": {
        "name": "Gemini 3.1 Flash-Lite",
        "model": "gemini-3.1-flash-lite",
        "passage_key": "api/gemini",
        "thinking": False,
        "sleep": 0,   # 4K RPM Tier 1
    },
    "flash_36": {
        "name": "Gemini 3.6 Flash",
        "model": "gemini-3.6-flash",
        "passage_key": "api/gemini",
        "thinking": True,
        "sleep": 0.5,  # assumed 1K RPM Tier 1, unverified for new model
    },
    "flash_lite_35": {
        "name": "Gemini 3.5 Flash-Lite",
        "model": "gemini-3.5-flash-lite",
        "passage_key": "api/gemini",
        "thinking": False,
        "sleep": 0,   # assumed 4K RPM Tier 1, unverified for new model
    },
}


def resolve_key(passage_key: str) -> str:
    try:
        out = subprocess.run(
            ["passage", "show", passage_key],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except Exception as e:
        print(f"FATAL: passage show {passage_key} failed: {e}", file=sys.stderr)
        sys.exit(1)


def _strip_fence(s: str) -> str:
    s = s.strip()
    if s.startswith("```"):
        lines = s.split("\n")
        # Drop first line (```json or ```) and last line (```)
        inner = lines[1:-1] if lines[-1].strip() == "```" else lines[1:]
        s = "\n".join(inner).strip()
    return s


# ── Scorers (identical to mistral_reasoning_probe.py) ──────────────────────────

def _score_stride(raw: str) -> int:
    answer = _strip_fence(raw)
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


TESTS = [
    {
        "id": "R1", "label": "Logic (knights/knaves)", "max_tokens": 1500, "max_score": 2,
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
        "id": "R2", "label": "STRIDE → JSON", "max_tokens": 2500, "max_score": 5,
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
        "id": "R3", "label": "Flask vulns", "max_tokens": 1200, "max_score": 3,
        "scorer": lambda r: sum([
            1 if any(x in r.lower() for x in ["sql inject","sqli","f-string","f\"select","format sql","string interpolat"]) else 0,
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
        "id": "R4", "label": "Logic grid", "max_tokens": 2000, "max_score": 3,
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
        # Fixed 2026-07-22: original first criterion checked for an off-by-one bug that does not
        # exist in this code — verified by direct simulation, the counter correctly blocks at
        # exactly the 11th request every time (`counts[userId] <= limit` after pre-increment is
        # exact, no fencepost error). The code's real first-class bug is the fixed-window boundary
        # burst: a client can send `limit` requests just before a window resets and another `limit`
        # requests just after, getting up to 2x the intended rate in a short span. Rewrote the first
        # criterion to check for that instead — code sample unchanged (preserves comparability with
        # every model's historical R5 score), only the scoring criterion changed to match reality.
        "id": "R5", "label": "Rate limiter bugs", "max_tokens": 1500, "max_score": 2,
        # Keyword sets deliberately disjoint — "window reset"/"window expir" pulled from criterion 2
        # since a genuine boundary-burst answer legitimately uses that phrase too, which was letting
        # a criterion-1-only response accidentally also trip criterion 2 (verified via synthetic test).
        "scorer": lambda r: sum([
            1 if any(x in r.lower() for x in ["boundary","burst","double","2x","twice","fixed window","fixed-window","two windows","across windows","back-to-back","bypass the limit","bypass the rate"]) else 0,
            1 if any(x in r.lower() for x in ["memory leak","unbounded","never clean","never delet","grow indefin","accumulate","no cleanup","stale entry","not removed"]) else 0,
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
        "id": "R6", "label": "Redis vs DynamoDB", "max_tokens": 1500, "max_score": 2,
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

def call_gemini(model: str, api_key: str, prompt: str, max_tokens: int, enable_thinking: bool) -> tuple[str, float, str]:
    url = f"{BASE}/{model}:generateContent?key={api_key}"
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
    t0 = time.time()
    backoff = 5  # seconds; doubles each retry
    for attempt in range(5):  # 1 try + 4 retries
        try:
            req = urllib.request.Request(
                url, json.dumps(payload).encode(),
                {"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=180) as resp:
                result = json.load(resp)
                elapsed = time.time() - t0
                err = result.get("error")
                if err:
                    return "", elapsed, f"API:{err.get('message','')[:80]}"
                candidates = result.get("candidates", [])
                if not candidates:
                    return "", elapsed, "NO_CANDIDATES"
                parts = candidates[0].get("content", {}).get("parts", [])
                text = " ".join(p.get("text","") for p in parts
                               if p.get("text","").strip() and not p.get("thought", False))
                return text.strip(), elapsed, ""
        except urllib.error.HTTPError as e:
            body = e.read().decode()[:120]
            if e.code == 503 and attempt < 4:
                print(f"    [503 retry {attempt+1}/4 — backoff {backoff}s]", flush=True)
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
                continue
            return "", time.time() - t0, f"HTTP{e.code}:{body}"
        except Exception as e:
            return "", time.time() - t0, f"EXC:{type(e).__name__}:{str(e)[:80]}"
    return "", time.time() - t0, "MAX_RETRIES"


def run_target(target_key: str):
    cfg = ENDPOINTS[target_key]
    api_key = resolve_key(cfg["passage_key"])

    print(f"\n{'═'*80}")
    print(f"17-POINT REASONING PROBE — {cfg['name']}")
    print(f"  Model:  {cfg['model']}")
    print(f"  Thinking: {'enabled' if cfg['thinking'] else 'disabled (thinkingBudget:0)'}")
    print(f"  Max pts: {MAX_SCORE_TOTAL}")
    print(f"{'═'*80}\n")
    print(f"{'Test':<8}{'Score':>7}{'':>5}{'Latency':>9}  Notes")
    print("─" * 96)

    total = 0
    results = []
    t_wall_start = time.time()

    for t in TESTS:
        resp, elapsed, err = call_gemini(cfg["model"], api_key, t["prompt"], t["max_tokens"], cfg["thinking"])
        if cfg["sleep"] > 0:
            time.sleep(cfg["sleep"])

        if err and not resp:
            score = 0
            note = f"ERR:{err[:50]}"
        else:
            try:
                raw_score = t["scorer"](resp)
                score = int(raw_score) if isinstance(raw_score, bool) else raw_score
            except Exception:
                score = 0
            note = f"raw[:60]={repr(resp[:60])}"

        total += score
        status = "✓" if score == t["max_score"] else ("~" if 0 < score < t["max_score"] else "✗")
        print(f"  {t['id']:<4}  {status} {score}/{t['max_score']}      /{t['max_score']}   {elapsed:>7.2f}s  {note}")
        results.append({"id": t["id"], "score": score, "max": t["max_score"], "elapsed": elapsed, "raw": resp[:200]})

    wall = time.time() - t_wall_start
    print("─" * 96)
    print(f"SCORE: {total}/{MAX_SCORE_TOTAL}  ({100*total/MAX_SCORE_TOTAL:.0f}%)  wall: {wall:.1f}s")

    out_path = f"/home/realuser/.claude/PAI/MEMORY/WORK/2026-06-15-shell-fallback-deeper-tests/reasoning-probe-gemini-{target_key}.json"
    with open(out_path, "w") as f:
        json.dump({"model": cfg["model"], "target": target_key, "total": total,
                   "max": MAX_SCORE_TOTAL, "results": results}, f, indent=2)
    print(f"Results saved: {out_path}")


if __name__ == "__main__":
    target_filter = "all"
    for i, arg in enumerate(sys.argv[1:]):
        if arg == "--target" and i + 1 < len(sys.argv[1:]):
            target_filter = sys.argv[i + 2]

    if target_filter == "all":
        targets = list(ENDPOINTS.keys())
    elif target_filter in ENDPOINTS:
        targets = [target_filter]
    else:
        print(f"Unknown target '{target_filter}'. Use: {', '.join(ENDPOINTS.keys())}, all")
        sys.exit(1)

    for target in targets:
        run_target(target)
        if len(targets) > 1:
            time.sleep(5)
