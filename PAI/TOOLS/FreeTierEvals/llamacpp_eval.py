#!/usr/bin/env python3
"""
PAI local llama-server eval — adapter for ubullm (V100, llama-server :11434).

Runs the unified 53-pt battery (T1-T9 + R1-R6 + C1-C6+C8) against local models
served by llama.cpp's OpenAI-compat endpoint. NO new scoring logic — all helpers,
prompts, and scorers are copied verbatim from existing PAI eval scripts with
attribution comments. See `## Decisions` in the ISA for the verbatim-copy
rationale (nim_eval.py has import-time sys.exit that blocks import).

Usage:
  python3 llamacpp_eval.py --target gptOss20b --battery t
  python3 llamacpp_eval.py --target qwen36_27b --battery r
  python3 llamacpp_eval.py --target gemma4_26b_a4b --battery c --skip-c8
  python3 llamacpp_eval.py --target gptOss20b --battery all

Environment:
  LLAMACPP_BASE_URL  default http://100.126.185.104:11434/v1/chat/completions
  LLAMACPP_TIMEOUT   default 180s per call (raise for slow thinking models)
"""

import os, json, time, urllib.request, urllib.error, re, sys, argparse, shutil, tempfile, subprocess
from pathlib import Path


# ════════════════════════════════════════════════════════════════════════════════
# Helpers — copied verbatim from existing PAI eval scripts.
# Verbatim copy with attribution (no import) because:
#   - nim_eval.py:24-26 sys.exit(1) at import if no NVIDIA_API_KEY + passage fails
#   - nim_eval.py:364-428 top-level runner loop fires at import
# ISC-3 probe: `grep -cE "^# Source: ..." llamacpp_eval.py` >= 4.
# ISC-33 probe: scorer NAMES match (comm -23 is empty) — bodies are byte-identical.
# ════════════════════════════════════════════════════════════════════════════════


# Source: nim_eval.py:L58-63
def _extract_answer(text):
    for tag in ["think", "thinking", "answer", "## Answer", "**Answer"]:
        idx = text.lower().rfind(tag.lower())
        if idx != -1:
            return text[idx + len(tag):]
    return text


# Source: nim_eval.py:L65-66
def _strip_fences(text):
    return re.sub(r'```[a-z]*\n?', '', text).strip().rstrip('`').strip()


# Source: nim_eval.py:L68-69
def _strip_json_prefix(text):
    return re.sub(r'^JSON\s*', '', text, flags=re.IGNORECASE).strip()


# Source: nim_eval.py:L71-95 (uses _extract_answer first — preferred for thinking models)
def _score_stride(raw):
    answer = _extract_answer(raw)
    answer = re.sub(r'```[a-z]*\n?', '', answer).strip()
    try:
        data = json.loads(answer)
        if not isinstance(data, list):
            data = json.loads(re.search(r'\[.*\]', answer, re.DOTALL).group())
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
        if not isinstance(item, dict): continue
        cat = str(item.get("stride_category","")).lower()
        vec = str(item.get("attack_vector",""))
        if any(s in cat for s in stride_cats) and len(vec) > 10:
            valid += 1
    return min(valid, 5)


# Source: nim_eval.py:L97-120
def _score_long_json(raw):
    """G8: parse 15-object CVE-style JSON; score = min(valid_objects, 15)."""
    answer = _extract_answer(raw)
    answer = re.sub(r'```[a-z]*\n?', '', answer).strip()
    try:
        data = json.loads(answer)
        if not isinstance(data, list):
            m = re.search(r'\[.*\]', answer, re.DOTALL)
            data = json.loads(m.group()) if m else []
    except Exception:
        m = re.search(r'\[.*\]', raw, re.DOTALL)
        if not m:
            return 0
        try:
            data = json.loads(m.group())
        except Exception:
            return 0
    required_fields = {"id", "severity", "component", "description", "cvss_score", "remediation"}
    valid = 0
    for item in data:
        if not isinstance(item, dict): continue
        if len(required_fields & set(k.lower() for k in item.keys())) >= 4:
            valid += 1
    return min(valid, 15)


# ════════════════════════════════════════════════════════════════════════════════
# T1-T9 TESTS — copied verbatim from mistral_eval.py:L36-123 (single source of truth)
# Source: mistral_eval.py:L36-123
# ════════════════════════════════════════════════════════════════════════════════

T_TESTS = [
    {
        "id": "T1_minimal",
        "label": "MINIMAL — terse ack",
        "prompt": "Say exactly: 'Acknowledged.' — nothing else.",
        "eval": lambda r: r.strip() == "Acknowledged." or r.strip().startswith("Acknowledged"),
        "max_score": 1,
        "max_tokens": 256,
    },
    {
        "id": "T2_classify",
        "label": "Classify — simple lookup",
        "prompt": """You are a task classifier. Classify as MINIMAL, NATIVE, or ALGORITHM.
MINIMAL = ack/greeting/rating. NATIVE = single-step. ALGORITHM = multi-step.
Message: "What's the capital of France?"
Reply with ONLY the word: MINIMAL, NATIVE, or ALGORITHM.""",
        "eval": lambda r: r.strip().upper() == "NATIVE",
        "max_score": 1,
        "max_tokens": 256,
    },
    {
        "id": "T3_classify2",
        "label": "Classify — multi-step task",
        "prompt": """You are a task classifier. Classify as MINIMAL, NATIVE, or ALGORITHM.
Message: "Refactor this entire authentication module to use JWTs, update all tests, and write a migration guide."
Reply with ONLY the word: MINIMAL, NATIVE, or ALGORITHM.""",
        "eval": lambda r: r.strip().upper() == "ALGORITHM",
        "max_score": 1,
        "max_tokens": 256,
    },
    {
        "id": "T4_json",
        "label": "JSON — structured",
        "prompt": 'Return ONLY valid JSON: {"status": "ok", "count": 42}. No other text.',
        "eval": lambda r: (lambda j: j.get("status") == "ok" and j.get("count") == 42)(json.loads(_strip_fences(r))),
        "max_score": 1,
        "max_tokens": 256,
    },
    {
        "id": "T5_reasoning",
        "label": "Reasoning — logic puzzle",
        "prompt": "Alice is taller than Bob. Bob is taller than Carol. Who is shortest? Reply with just the name.",
        "eval": lambda r: "carol" in r.strip().lower(),
        "max_score": 1,
        "max_tokens": 256,
    },
    {
        "id": "T6_code",
        "label": "Code gen — TypeScript function",
        "prompt": "Write a TypeScript function that returns true if a string is a palindrome. Just the function, no explanation.",
        "eval": lambda r: "function" in r and ("return" in r or "=>" in r) and "palindrome" in r.lower(),
        "max_score": 1,
        "max_tokens": 512,
    },
    {
        "id": "T7_instruction_follow",
        "label": "Instruction — length constraint",
        "prompt": "List 3 security vulnerability types. Reply in exactly 3 bullet points, each under 10 words.",
        "eval": lambda r: r.count("•") + r.count("-") + r.count("*") >= 3 or r.count("\n") >= 2,
        "max_score": 1,
        "max_tokens": 256,
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
        "max_score": 1,
        "max_tokens": 512,
    },
    {
        "id": "T9_strategic_reasoning",
        "label": "STRIDE — security classification",
        "prompt": """Classify this finding as STRIDE category. Reply with ONLY the letter.
Finding: An API endpoint accepts a user_id parameter from the URL and passes it directly to a SQL query without parameterization.
Reply with: S, T, R, I, D, or E (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege)""",
        "eval": lambda r: r.strip().upper().startswith("T"),
        "max_score": 1,
        "max_tokens": 64,
    },
]


# ════════════════════════════════════════════════════════════════════════════════
# R1-R6 TESTS — copied verbatim from anthropic_compat_reasoning_probe.py:L123-271
# max_tokens is bigger here than nim_eval's R-script (1500/2500/1200/2000/1500/1500)
# — reasoning models need the budget.
# Source: anthropic_compat_reasoning_probe.py:L123-271
# ════════════════════════════════════════════════════════════════════════════════

R_TESTS = [
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
            "    cur.execute(f\"DELETE * FROM users WHERE id = {uid}\")\n"
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


# ════════════════════════════════════════════════════════════════════════════════
# C1-C6 prompts + scorers + C8 — copied verbatim from coding_battery.py:L357-1101
# Source: coding_battery.py:L357-890 (C1-C6) + L997-1101 (C8 + run_c8)
# ════════════════════════════════════════════════════════════════════════════════

# Source: coding_battery.py:L357-377
C1_PROMPT = '''Write a TypeScript function:

  parseAuthHeader(header: string, nowMs: number): ParseResult

  type ParseResult =
    | { valid: true; token: string }
    | { valid: false; reason: 'missing' | 'malformed' | 'expired' };

Behavior:
- `header === ''` (after trim) -> { valid: false, reason: 'missing' }
- `header` does not match `/^Bearer\\s+(\\S+)$/i` (case-insensitive scheme) -> { valid: false, reason: 'malformed' }
- Token is base64url-encoded JSON. Decode it; if the decoded JSON has a numeric `exp` field, and `exp * 1000 <= nowMs`, -> { valid: false, reason: 'expired' }
- If the token decodes but has no `exp` field, it is NOT expired (treat as opaque).
- Otherwise -> { valid: true, token: <raw token string> }

Constraints:
- No `any`. No `as` casts.
- Use a `switch` on `reason` (in a helper that consumes `ParseResult`) to demonstrate the exhaustive `never` check. Or write the helper inline.
- Signature must be exactly as shown. Don't add optional params.

Just the code (with imports). No explanation.'''


# Source: coding_battery.py:L380-444
def score_c1(response: str) -> tuple[int, list[str]]:
    notes = []
    score = 0
    r = response
    code = re.sub(r'```[a-z]*\n?', '', r).strip()
    code_no_comments = re.sub(r'//.*$', '', code, flags=re.MULTILINE)
    if re.search(r'\bany\b', code) and ': any' in code:
        notes.append("uses any")
        return 0, notes
    as_casts = re.findall(r'\bas\s+[A-Za-z<>[\]]+', code_no_comments)
    legitimate_casts = 0
    for cast in as_casts:
        if re.search(r'atob|base64|decode', code, re.I):
            legitimate_casts += 1
        elif re.search(r'unknown|as\s+Record<|as\s+number|as\s+string', code, re.I):
            legitimate_casts += 1
    if len(as_casts) > legitimate_casts:
        notes.append(f"uses 'as' cast beyond allowed contexts: {as_casts}")
        return 0, notes
    if as_casts:
        notes.append(f"as casts (legitimate): {len(as_casts)}")
    if 'parseAuthHeader' not in code or 'nowMs' not in code:
        notes.append("signature mismatch")
        return 0, notes
    has_missing = "missing" in code.lower()
    has_malformed = "malformed" in code.lower()
    has_expired = "expired" in code.lower()
    paths_found = sum([has_missing, has_malformed, has_expired])
    notes.append(f"reject paths: missing={has_missing} malformed={has_malformed} expired={has_expired}")
    if paths_found < 2:
        return 0, notes
    elif paths_found < 3:
        score = 1
        notes.append("2 of 3 reject paths")
    else:
        score = 2
    has_never = re.search(r'\bnever\b', code) is not None
    has_switch = re.search(r'\bswitch\s*\(', code) is not None
    if has_never and has_switch:
        score = 3
        notes.append("never exhaustive check present")
    elif has_never:
        score = max(score, 2)
        notes.append("has 'never' but no switch on reason")
    else:
        notes.append("no never exhaustive check")
    return score, notes


# Source: coding_battery.py:L449-478
C2_PROMPT = '''This Bun script crashes intermittently in production. Find the bug, explain why it happens, give me a minimal fix, and a 3-line repro that fails on the unfixed code.

Symptom: ~1 in 50 worker runs exits silently with this stack trace:

  TypeError: undefined is not an object (evaluating 'response.headers.get')
    at fetchWithRetry (/home/me/proj/lib/http.ts:42:24)
    at processJob (/home/me/proj/worker.ts:118:10)
    at async run (/home/me/proj/worker.ts:50:5)

Code:
```typescript
// lib/http.ts
export async function fetchWithRetry(url: string, opts: RequestInit = {}, attempts = 3): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, opts);
      if (response.status >= 500 && i < attempts - 1) {
        await new Promise(r => setTimeout(r, 100 * 2 ** i));
        continue;
      }
      return response;
    } catch (err) {
      if (i === attempts - 1) throw err;
    }
  }
  return fetch(url, opts);  // line 42
}
```

The endpoint returns 500 ~2% of the time. Workers don't crash visibly; they just disappear.'''


# Source: coding_battery.py:L481-526
def score_c2(response: str) -> tuple[int, list[str]]:
    notes = []
    r = response.lower()
    score = 0
    bug_pattern = bool(re.search(
        r'line\s*42|fall\s*through|fallthrough|after\s*(?:the\s*)?(?:retry\s*)?loop|'
        r'bare\s*fetch|unconditional\s*fetch|extra\s*fetch|fetch\s*at\s*the\s*end|'
        r'final\s*fetch\s*\(.*\)\s*$|return\s+fetch\s*\(\s*url', r, re.M | re.I))
    mentions_undefined = 'undefined' in r or 'response is undefined' in r or 'no response' in r or 'unhandled' in r
    if not bug_pattern:
        notes.append("does not identify line-42 fallthrough / final-fetch bug")
        return 0, notes
    elif 'try/catch' in r and 'worker' in r and not mentions_undefined:
        notes.append("blames worker / generic try-catch")
        return 0, notes
    elif not mentions_undefined:
        notes.append("identifies bug but wrong cause")
        return 1, notes
    has_repro = bool(re.search(r'repro|reproduce|test case|to reproduce', r))
    has_fix = bool(re.search(r'fix|solution|patch|change|restructure|move.*inside|throw', r))
    fix_is_idiomatic = bool(re.search(r'inside.*loop|throw new|loop.*restructure|instead of return|don.t return|move\s+the\s+throw', r))
    if bug_pattern and mentions_undefined and not has_repro and not has_fix:
        notes.append("correct cause, no fix or repro")
        return 1, notes
    if bug_pattern and mentions_undefined and has_fix and not fix_is_idiomatic:
        notes.append("correct cause, fix is a guard not restructure")
        return 2, notes
    if bug_pattern and mentions_undefined and has_fix and has_repro:
        score = 3
        notes.append("full diagnosis + idiomatic fix + repro")
    elif bug_pattern and mentions_undefined and has_fix:
        score = 2
        notes.append("correct cause + fix, no repro")
    return score, notes


# Source: coding_battery.py:L531-560
C3_PROMPT = '''Refactor these 3 files to extract the Basic auth construction into a single `auth.ts` module. Don't change observable behavior. Show me the new contents of all 3 files.

Before:

```typescript
// a.ts
import { b } from "./b";
export function getProfile(user: string, pw: string): Promise<unknown> {
  if (!user || !pw) throw new Error("missing creds");
  const tok = Buffer.from(`${user}:${pw}`).toString("base64");
  return b(`Basic ${tok}`);
}

// b.ts
import { c } from "./c";
export function b(auth: string): Promise<unknown> {
  return c({ headers: { Authorization: auth } });
}

// c.ts
export function c(opts: { headers: Record<string, string> }): Promise<unknown> {
  return fetch("https://api.example.com/me", opts).then(r => r.json());
}
```

Constraints:
- `getProfile`, `b`, `c` must keep their exact signatures.
- All `Buffer.from(...).toString("base64")` Basic-auth construction must happen in `auth.ts` (no leakage of `Buffer` to `a.ts` or `b.ts`).
- `b.ts` should not need to know that Basic auth is in use - it just passes an `Authorization` header value.
- Add minimal type annotations to make the new module boundary self-documenting.'''


# Source: coding_battery.py:L563-655
def score_c3(response: str) -> tuple[int, list[str]]:
    notes = []
    r = response
    score = 0
    has_auth_ts = bool(re.search(r'auth\.ts', r))
    has_three_files = bool(re.search(r'a\.ts', r)) and bool(re.search(r'b\.ts', r)) and bool(re.search(r'c\.ts', r))
    if not has_auth_ts or not has_three_files:
        notes.append("missing auth.ts or one of the 3 files")
        return 0, notes
    has_getprofile = 'getProfile' in r
    has_func_b = re.search(r'(?:export\s+)?function\s+b\s*\(', r) is not None
    has_func_c = re.search(r'(?:export\s+)?function\s+c\s*\(', r) is not None
    sigs_ok = has_getprofile and has_func_b and has_func_c
    if not sigs_ok:
        notes.append(f"signatures: getProfile={has_getprofile} b={has_func_b} c={has_func_c}")
        return 1, notes
    no_buffer_outside_auth = True
    a_section = re.search(r'//\s*a\.ts[\s\S]+?(?=//\s*b\.ts|//\s*auth\.ts|$)', r)
    b_section = re.search(r'//\s*b\.ts[\s\S]+?(?=//\s*c\.ts|//\s*auth\.ts|$)', r)
    for sec_name, sec_match in [("a.ts", a_section), ("b.ts", b_section)]:
        if sec_match and 'Buffer' in sec_match.group():
            notes.append(f"{sec_name} still references Buffer")
            no_buffer_outside_auth = False
    if not no_buffer_outside_auth:
        return 1, notes
    relative_imports = bool(re.search(r'from\s+["\']\./auth["\']', r))
    score = 2
    notes.append(f"signatures preserved; Buffer contained to auth.ts; relative-import auth={relative_imports}")
    has_inline_type = bool(re.search(r':\s*(string|Promise<|Record<|void|number|boolean)', r))
    if has_inline_type:
        score = 3
        notes.append("type annotations present")
    else:
        notes.append("no type annotations")
    return score, notes


# Source: coding_battery.py:L660-689
C4_PROMPT = '''Write 4+ vitest tests for this function. Each test should fail on the buggy code and target one specific failure mode. Use descriptive test names that match the bug.

```typescript
// buggy.ts
export function normalizeRecords(records: Array<Record<string, unknown>>): Array<Record<string, string>> {
  return records
    .filter(r => r.deleted !== true)
    .map(r => {
      const out: Record<string, string> = {};
      for (const k of Object.keys(r)) {
        out[k] = String(r[k]);
      }
      return out;
    });
}
```

The function is supposed to:
1. Skip records where `deleted === true`
2. Convert every value to a string
3. Drop keys whose values are `null` or `undefined`
4. Return `[]` when given `[]`

It is called like this in production:
```typescript
const cleaned = normalizeRecords(await db.query("SELECT * FROM users"));
await api.post("/sync", { users: cleaned });
```

Write 4+ failing tests. Name each test after the bug it catches.'''


# Source: coding_battery.py:L692-732
def score_c4(response: str) -> tuple[int, list[str]]:
    notes = []
    r = response
    it_blocks = re.findall(r'\bit\(\s*["\']([^"\']+)["\']', r)
    test_blocks = re.findall(r'\btest\(\s*["\']([^"\']+)["\']', r)
    all_blocks = it_blocks + test_blocks
    n_tests = len(all_blocks)
    notes.append(f"found {n_tests} tests (it={len(it_blocks)} test={len(test_blocks)})")
    if n_tests < 4:
        return min(n_tests, 1), notes
    name_text = " ".join(all_blocks).lower()
    has_deleted = 'deleted' in name_text or 'string' in name_text or 'skip' in name_text
    has_null = 'null' in name_text or 'undefined' in name_text or 'drop' in name_text
    has_proto = 'proto' in name_text or 'inherit' in name_text
    bug_targets = sum([has_deleted, has_null, has_proto])
    notes.append(f"bug patterns: deleted={has_deleted} null/drop={has_null} proto={has_proto}")
    if n_tests == 4 and bug_targets < 2:
        return 1, notes
    if n_tests == 4 and bug_targets == 2:
        return 2, notes
    if n_tests >= 4 and bug_targets >= 3:
        return 3, notes
    if n_tests >= 5 and bug_targets >= 3:
        return 4, notes
    if n_tests >= 5 and bug_targets >= 4:
        if 'passes through' in name_text or 'normal' in name_text or 'happy' in name_text:
            return 5, notes
        return 4, notes
    return min(n_tests - 1, 4), notes


# Source: coding_battery.py:L737-758
C5_PROMPT = '''Design a REST API for managing API keys. The resource is an API key with: id, name, prefix (first 8 chars of the key, used for display), hash (sha256 of the key, never returned), scopes (array of strings), createdAt, lastUsedAt, revokedAt.

Endpoints needed:
- Create a key (returns the FULL key value ONCE, never again)
- List keys (returns prefix + metadata, never the hash or full value)
- Revoke a key
- Rotate a key (atomic: revoke + create new with same name)

Non-negotiables (these are the rubric dimensions):
1. **Secret handling** - full key only on create/rotate, NEVER on list. Hash NEVER leaves the server. Prefix is fine to return.
2. **Auth** - every endpoint requires a valid JWT with `keys:write` scope. List may use `keys:read`. Show the scope check.
3. **Methods/paths** - RESTful: POST /keys, GET /keys, DELETE /keys/:id (or PATCH with `{revoked: true}`), POST /keys/:id/rotate. POST /keys/:id/revoke is WRONG.
4. **Error contract** - uniform envelope across all endpoints. Example: `{ "error": { "code": "string_constant", "message": "human readable", "details": {...} } }`. Status codes: 400 (validation), 401 (no auth), 403 (wrong scope), 404 (not found), 409 (conflict - e.g. name in use on rotate), 500 (server).
5. **Atomic rotation** - POST /keys/:id/rotate must be a single transaction: mark old key revoked AND create new key with the same name AND return the new full key. Two separate calls (revoke + create) is a race condition and scores 0 on this dimension.

Specify:
- HTTP methods + paths
- Request/response shape (JSON, with TypeScript types)
- Error contract: full envelope spec
- Auth: where the scope check happens

Be precise. Show me the TypeScript types and one example error response.'''


# Source: coding_battery.py:L761-821
def score_c5(response: str) -> tuple[int, list[str]]:
    notes = []
    r = response
    list_section = re.search(
        r'(?:^|\n)\s*[`*]?\s*GET\s+[^\n]*/keys[^\n]*\n[\s\S]+?'
        r'(?=(?:^|\n)\s*[`*]?\s*(?:POST|DELETE|PATCH|PUT)\s+[^\n]*/|$)',
        r, re.I | re.M)
    list_safe = True
    if list_section:
        list_text = list_section.group().lower()
        if 'full' in list_text and 'key' in list_text and 'never' not in list_text:
            list_safe = False
        if 'hash' in list_text and 'never' not in list_text and 'no hash' not in list_text:
            list_safe = False
    secret_ok = list_safe
    notes.append(f"secret handling (no full key/hash in list): {secret_ok}")
    has_scope = re.search(r'\bkeys:write\b|\bkeys:read\b|\bscopes?\b', r, re.I) is not None
    has_jwt = re.search(r'\bjwt\b', r, re.I) is not None
    auth_ok = has_scope and has_jwt
    notes.append(f"auth (JWT + scope): {auth_ok}")
    def has_method_path(method, path_pat):
        return re.search(
            rf'\b{method}\b\s*[|`\s]*`?{path_pat}', r, re.I
        ) is not None
    has_post_keys = has_method_path('POST', r'/keys(?![^`]*`\s*[/])')
    has_get_keys = has_method_path('GET', r'/keys(?![^`]*`\s*[/])')
    has_delete = has_method_path('DELETE', r'/keys/\S+') or has_method_path('PATCH', r'/keys/\S+')
    has_rotate = re.search(r'\brotate\b', r, re.I) is not None
    has_wrong_revoke = re.search(r'POST\s+[|`\s]*`?/keys/\S+/revoke', r, re.I) is not None
    paths_ok = has_post_keys and has_get_keys and has_delete and has_rotate and not has_wrong_revoke
    notes.append(f"paths: POST={has_post_keys} GET={has_get_keys} DEL/PATCH={has_delete} rotate={has_rotate} wrong={has_wrong_revoke}")
    has_envelope = re.search(r'\{?\s*["\']?error["\']?\s*:\s*\{', r) is not None
    has_status_codes = all(code in r for code in ['400', '401', '403', '404'])
    error_ok = has_envelope and has_status_codes
    notes.append(f"error contract (envelope + status codes): {error_ok}")
    has_atomic = re.search(r'\b(?:atomic|single\s+transaction|same\s+transaction|one\s+transaction)\b', r, re.I) is not None
    has_409 = '409' in r
    has_two_calls = re.search(r'two\s+(?:separate\s+)?calls|revoke.*then.*create|first.*revoke.*then', r, re.I) is not None
    rotation_ok = has_atomic and has_409 and not has_two_calls
    notes.append(f"atomic rotation: atomic={has_atomic} 409={has_409} two_calls={has_two_calls}")
    score = sum([secret_ok, auth_ok, paths_ok, error_ok, rotation_ok])
    return score, notes


# Source: coding_battery.py:L826-841
C6_PROMPT = '''Write a bash function `backup-and-rotate` that:
1. Takes a directory path as $1
2. Creates a tar.gz of the directory at /backup/$(basename $1)-$(date +%Y%m%d-%H%M%S).tar.gz
3. Keeps only the 5 most recent backups in /backup/ (deletes older ones)
4. Exits 0 on success, non-zero on any failure
5. Logs what it did to stderr

Constraints:
- Use `set -euo pipefail` at the top
- Use `mktemp` for any temp files
- Don't `eval`
- Quote all variables
- If the source directory doesn't exist, exit 1 with a message to stderr
- Filenames in /backup/ may contain spaces, newlines, or leading dashes - the rotation step MUST handle these correctly (use null-delimited iteration)

Show me the function with a one-line example of how to call it.'''


# Source: coding_battery.py:L844-890
def score_c6(response: str) -> tuple[int, list[str]]:
    notes = []
    r = response
    code = re.sub(r'```[a-z]*\n?', '', r).strip()
    has_strict = bool(re.search(r'set\s+-[a-z]*e.*-?[a-z]*u.*-?[a-z]*o.*pipefail|set\s+-[a-z]*euo\s*pipefail', code))
    has_mktemp = 'mktemp' in code
    code_no_backticks = code.replace('`', '')
    has_eval = bool(re.search(r'\beval\s+["\']|\beval\s+\$', code_no_backticks))
    has_existence_check = bool(re.search(r'-d\s+["\']?\$', code)) or bool(re.search(r'if\s+\[\s*!\s*-d', code))
    if not has_strict:
        notes.append("missing set -euo pipefail")
        return 0, notes
    if has_eval:
        notes.append("uses eval (disqualifier)")
        return 0, notes
    if not has_existence_check:
        notes.append("no existence check on $1")
        return 0, notes
    has_null_delimited = bool(re.search(r'-print0|-z\s*["\']?\s*\\?\s*0?-?d\s*["\']?\s*["\']?\s*0', code)) or bool(re.search(r'read\s+-r\s+-d\s+["\']?\\?0', code)) or 'IFS=' in code
    has_unsafe_xargs = bool(re.search(r'xargs\s+(?!-0|-r)', code)) and not has_null_delimited
    has_unsafe_ls_xargs = bool(re.search(r'\bls\b.*\|\s*xargs', code)) and not has_null_delimited
    has_trap = bool(re.search(r'\btrap\s+', code))
    has_atomic_write = bool(re.search(r'mv\s+.*\s+["\']?/backup/', code)) and bool(re.search(r'tmp|mktemp', code))
    if has_unsafe_xargs or has_unsafe_ls_xargs:
        notes.append("rotation breaks on spaces (ls|xargs without -print0)")
        return 1, notes
    if not has_null_delimited:
        notes.append("no null-delimited iteration (would break on spaces/newlines)")
        return 1, notes
    if not has_trap and not has_atomic_write:
        notes.append("null-delimited rotation, no trap or atomic write")
        return 2, notes
    notes.append("null-delimited rotation + trap or atomic write")
    return 3, notes


# Source: coding_battery.py:L895-902 (TESTS list)
C_TESTS = [
    ("C1", "TS-strict type narrowing", 3, C1_PROMPT, score_c1, 2500),
    ("C2", "Debug from stack trace + repro", 3, C2_PROMPT, score_c2, 2500),
    ("C3", "Multi-file refactor", 3, C3_PROMPT, score_c3, 3000),
    ("C4", "Test generation", 5, C4_PROMPT, score_c4, 3000),
    ("C5", "REST API design", 5, C5_PROMPT, score_c5, 3000),
    ("C6", "Bash / shell scripting", 3, C6_PROMPT, score_c6, 2000),
]


# Source: coding_battery.py:L907-995 (C8 stubs + tests)
CACHE_STUB = '''export type CacheOptions<V> = {
  maxEntries: number;
  now?: () => number;
  defaultTtlMs?: number;
};

export class TTLCache<K, V> {
  constructor(opts: CacheOptions<V>) { throw new Error("not implemented"); }
  get(key: K): V | undefined { throw new Error("not implemented"); }
  set(key: K, value: V, ttlMs?: number): void { throw new Error("not implemented"); }
  delete(key: K): boolean { throw new Error("not implemented"); }
  clear(): void { throw new Error("not implemented"); }
  get size(): number { throw new Error("not implemented"); }
}
'''

CACHE_TESTS = '''import { describe, it, expect, beforeEach } from "vitest";
import { TTLCache } from "./cache";

describe("TTLCache", () => {
  let now = 0;
  const clock = () => now;

  beforeEach(() => { now = 1_000_000; });

  it("returns undefined for missing key", () => {
    const c = new TTLCache<string, number>({ maxEntries: 10, now: clock });
    expect(c.get("nope")).toBeUndefined();
  });

  it("returns the value after set", () => {
    const c = new TTLCache<string, number>({ maxEntries: 10, now: clock });
    c.set("a", 1, 5000);
    expect(c.get("a")).toBe(1);
  });

  it("expires entries after TTL", () => {
    const c = new TTLCache<string, number>({ maxEntries: 10, now: clock });
    c.set("a", 1, 1000);
    now += 1001;
    expect(c.get("a")).toBeUndefined();
  });

  it("refreshes TTL on set with same key", () => {
    const c = new TTLCache<string, number>({ maxEntries: 10, now: clock });
    c.set("a", 1, 1000);
    now += 500;
    c.set("a", 2, 1000);
    now += 700;
    expect(c.get("a")).toBe(2);
  });

  it("delete returns true if key existed", () => {
    const c = new TTLCache<string, number>({ maxEntries: 10, now: clock });
    c.set("a", 1, 5000);
    expect(c.delete("a")).toBe(true);
    expect(c.delete("a")).toBe(false);
  });

  it("evicts least-recently-used when over capacity", () => {
    const c = new TTLCache<string, number>({ maxEntries: 2, now: clock });
    c.set("a", 1, 60_000); now += 10;
    c.set("b", 2, 60_000); now += 10;
    c.get("a"); now += 10;
    c.set("c", 3, 60_000);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(c.get("c")).toBe(3);
  });

  it("get updates recency", () => {
    const c = new TTLCache<string, number>({ maxEntries: 2, now: clock });
    c.set("a", 1, 60_000); now += 10;
    c.set("b", 2, 60_000); now += 10;
    c.get("a"); now += 10;
    c.set("c", 3, 60_000);
    expect(c.get("b")).toBeUndefined();
  });

  it("clear empties the cache", () => {
    const c = new TTLCache<string, number>({ maxEntries: 10, now: clock });
    c.set("a", 1, 5000);
    c.set("b", 2, 5000);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get("a")).toBeUndefined();
  });
});
'''


# Source: coding_battery.py:L997-1011
# Built lazily so Python 3.12+ f-string parser doesn't choke on the { and } in
# the embedded TypeScript code (JS destructuring, object literals). The original
# uses an f-string at module load — we substitute at call time in run_c8 instead.
C8_PROMPT_TEMPLATE = '''Implement the methods of TTLCache so all the tests in cache.test.ts pass. You may NOT modify the tests. tsconfig has strict mode on.

Show me the full new contents of cache.ts.

The current stub is:

```typescript
__CACHE_STUB__
```

The tests are:

```typescript
__CACHE_TESTS__
```
'''


def build_c8_prompt() -> str:
    return C8_PROMPT_TEMPLATE.replace("__CACHE_STUB__", CACHE_STUB).replace("__CACHE_TESTS__", CACHE_TESTS)


# Source: coding_battery.py:L1014-1024
def extract_code_block(response: str) -> str:
    m = re.search(r'```(?:typescript|ts)\n(.*?)```', response, re.DOTALL)
    if m:
        return m.group(1).strip()
    m = re.search(r'```\n(.*?)```', response, re.DOTALL)
    if m:
        return m.group(1).strip()
    return response.strip()


# Source: coding_battery.py:L1027-1101
def run_c8(response: str) -> tuple[int, list[str]]:
    notes = []
    code = extract_code_block(response)
    if 'class TTLCache' not in code:
        notes.append("no TTLCache class in response")
        return 0, notes
    work = Path(tempfile.mkdtemp(prefix="c8-"))
    try:
        (work / "src").mkdir()
        (work / "src" / "cache.ts").write_text(code)
        (work / "src" / "cache.test.ts").write_text(CACHE_TESTS)
        (work / "tsconfig.json").write_text('{"compilerOptions": {"strict": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "esModuleInterop": true, "skipLibCheck": true, "noEmit": true, "types": []}, "include": ["src/**/*"]}')
        (work / "package.json").write_text('{"name": "c8", "type": "module", "scripts": {"test": "vitest run"}}')
        env = os.environ.copy()
        env["BUN_INSTALL_CACHE_DIR"] = str(work / ".bun-cache")
        install = subprocess.run(
            ["bun", "add", "-d", "vitest", "typescript@5", "@types/node"],
            cwd=work, capture_output=True, text=True, timeout=120, env=env,
        )
        if install.returncode != 0:
            notes.append(f"vitest install failed: {install.stderr[:120]}")
            return 0, notes
        result = subprocess.run(
            ["bunx", "vitest", "run"],
            cwd=work, capture_output=True, text=True, timeout=60, env=env,
        )
        out = result.stdout + result.stderr
        m = re.search(r'Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?\s*\(\d+\)', out)
        if m:
            passed = int(m.group(1))
            failed = int(m.group(2)) if m.group(2) else 0
        else:
            passed = out.count('✓') + len(re.findall(r'\bpassed\b', out))
            failed = out.count('✗') + len(re.findall(r'\bfailed\b', out))
        notes.append(f"vitest: {passed} passed, {failed} failed")
        if failed == 0 and passed >= 7:
            any_count = len(re.findall(r':\s*any\b|<any>|as\s+any', code))
            if any_count > 0:
                notes.append(f"uses 'any' ({any_count}x) — penalizing to 3")
                return 3, notes
            notes.append("all tests pass, no 'any'")
            return 5, notes
        elif passed >= 5:
            return 4, notes
        elif passed >= 3:
            return 3, notes
        elif passed >= 1:
            return 2, notes
        else:
            return 0, notes
    except subprocess.TimeoutExpired:
        notes.append("vitest timeout")
        return 0, notes
    except Exception as e:
        notes.append(f"EXC: {type(e).__name__}: {str(e)[:80]}")
        return 0, notes
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ════════════════════════════════════════════════════════════════════════════════
# MODELS — the ubullm llama-server roster.
# Keys here MUST match `key` in unified_bench.ts MODELS list (camelCase).
# `model` is what gets sent in the JSON body's `model` field — must be the
# exact alias the llama-server has loaded (see llama-server --alias flag).
# ════════════════════════════════════════════════════════════════════════════════

MODELS = {
    "gptOss20b": {
        "name": "OpenAI GPT-OSS-20B (ubullm MXFP4)",
        "model": "gpt-oss-20b",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,   # MoE, may emit reasoning_content
        "fence_strip": True,
        "type_filter": True,
    },
    "qwen36_27b": {
        "name": "Qwen3.6-27B (ubullm, MTP)",
        "model": "qwen36:27b",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,
        "fence_strip": True,
        "type_filter": True,
    },
    "qwen36_35b_a3b": {
        "name": "Qwen3.6-35B-A3B (ubullm production, gated on -c 16384 fix)",
        "model": "qwen36:35b-a3b",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,
        "fence_strip": True,
        "type_filter": True,
    },
    "gemma4_26b_a4b": {
        "name": "gemma-4-26B-A4B (ubullm, experts-llama.cpp)",
        "model": "gemma4-26b-a4b",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "gemma4_31b": {
        "name": "gemma-4-31B (ubullm mainline)",
        "model": "gemma4-31b",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "qwen35_9b_deepseek_v4_flash": {
        "name": "qwen3.5-9b-DeepSeek-V4-Flash (ubullm)",
        "model": "qwen35-9b-v4-flash",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "qwen3_30b_a3b": {
        "name": "Qwen3-30B-A3B-Instruct-2507 (ubullm, IQ4_XS)",
        "model": "qwen3:30b-a3b",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "mellum2_12b": {
        "name": "Mellum2-12B-A2.5B-Instruct (ubullm)",
        "model": "mellum2:12b",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "mellum2_12b_thinking": {
        "name": "Mellum2-12B-A2.5B-Thinking (ubullm)",
        "model": "mellum2-thinking:12b",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "nemotron3_nano_4b": {
        "name": "Nemotron3-Nano-4B (ubullm)",
        "model": "nemotron3-nano:4b",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "qwen3_30b_a3b_udq4kxl": {
        "name": "Qwen3-30B-A3B-Instruct-2507 (ubullm, UD-Q4_K_XL)",
        "model": "qwen3-udq4kxl:30b-a3b",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "lfm2_24b": {
        "name": "LFM2-24B (ubullm, Ollama blob via llama-server)",
        "model": "lfm2:24b",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    # Added 2026-06-26 — QAT (Quantization-Aware Training) run.
    # Does QAT beat post-hoc quantization on the T9/R5/C4 ceilings?
    # Gemma 4 is thinking-capable; benched WITHOUT forced think mode (is_reasoning False)
    # to match how the Qwen3-30B-A3B production slot is used. Watch for empty
    # <|channel>thought\n<channel|> framing leaking into content on first T1 result.
    "gemma4_12b_qat": {
        "name": "gemma-4-12B-it-qat (ubullm, UD-Q4_K_XL, MTP)",
        "model": "gemma4-12b-qat",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    # Added 2026-06-28 — local gap-fill run.
    "nousCoder14b": {
        "name": "NousCoder-14B (ubullm, Q4_K_M)",
        "model": "nouscoder:14b",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "nemotronNano9bV2": {
        "name": "nemotron-nano-9b-v2 (ubullm, Q4_K_M)",
        "model": "nemotron-nano:9b-v2",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "qwen3Coder30bA3b": {
        "name": "Qwen3-Coder-30B-A3B-Instruct (ubullm, IQ4_XS)",
        "model": "qwen3-coder:30b-a3b",
        "max_tokens": 4096,
        "temperature": 0,
        # Qwen family; if reasoning_content leaks at T1 probe, flip to True.
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
}

BASE_URL = os.environ.get("LLAMACPP_BASE_URL", "http://100.126.185.104:11434/v1/chat/completions")
TIMEOUT = int(os.environ.get("LLAMACPP_TIMEOUT", "180"))


# ════════════════════════════════════════════════════════════════════════════════
# Caller — OpenAI-compat POST, no auth, type-filter + fence-strip pre-process.
# Pattern adapted from coding_battery.py:262-308 (call_openai), retargeted URL,
# Authorization header dropped (llama-server has no auth).
# ════════════════════════════════════════════════════════════════════════════════

def call_local(cfg, prompt, max_tokens_override=None, tools=None, messages_override=None):
    """Returns (content_or_TOOL_CALLED, elapsed, err)."""
    is_reasoning = cfg.get("is_reasoning", False)
    # Reasoning-mode floor: Qwen3.6's reasoning_content trace alone measured 12.4K tokens
    # on R2 (STRIDE->JSON) before the answer even starts (enable_thinking:false is a no-op
    # for this model's chat template). 2048 silently truncates before any answer content.
    base = max_tokens_override or cfg["max_tokens"]
    effective_max = max(base, 16000) if is_reasoning else base

    payload = {
        "model": cfg["model"],
        "max_tokens": effective_max,
        "temperature": cfg["temperature"],
        "messages": messages_override or [{"role": "user", "content": prompt}],
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE_URL, data=data, headers={
        "Content-Type": "application/json",
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            result = json.load(resp)
            elapsed = time.time() - t0
            choices = result.get("choices", [])
            if not choices:
                return "", elapsed, "ERR:no_choices"
            msg = choices[0].get("message", {})

            # Tool call detection — match mistral_eval.py:177-179
            if msg.get("tool_calls"):
                return "TOOL_CALLED", elapsed, None

            content = msg.get("content")
            if content is None:
                return "", elapsed, f"ERR:content_null:{json.dumps(result)[:150]}"

            # Type-filter for thinking models (gpt-oss-20b, Qwen3.6 reasoning)
            if isinstance(content, list):
                if cfg.get("type_filter", False):
                    content = "".join(
                        b.get("text", "") for b in content
                        if isinstance(b, dict) and b.get("type") in ("text", None)
                    )
                else:
                    content = "".join(str(b) for b in content if isinstance(b, (str, dict)))

            # Strip JSON-prefix (some local models add "JSON\n\n")
            content = _strip_json_prefix(content)

            # Fence-strip (Qwen3.6, gemma-4 emit ```json fences on structured output)
            if cfg.get("fence_strip", False):
                content = _strip_fences(content)

            return content or "", elapsed, None
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode()[:120]
        except Exception:
            pass
        return "", time.time() - t0, f"HTTP{e.code}:{body}"
    except Exception as e:
        return "", time.time() - t0, f"EXC:{type(e).__name__}:{str(e)[:80]}"


# ════════════════════════════════════════════════════════════════════════════════
# Runner
# ════════════════════════════════════════════════════════════════════════════════

def run_t_battery(cfg, target_key, task_filter=None):
    """T1-T9 — single-step classifier battery. 9 pts max."""
    print(f"\n{'═' * 80}")
    print(f"T1-T9 BATTERY — {cfg['name']}")
    print(f"  URL:    {BASE_URL}")
    print(f"  Model:  {cfg['model']}")
    print(f"{'═' * 80}")

    results = []
    grand_total = 0
    grand_possible = 0
    wall_total = 0.0
    print(f"\n{'Test':<24} {'Score':>8} {'/max':>6} {'Latency':>10}")
    print("─" * 60)
    for t in T_TESTS:
        if task_filter and t["id"] != task_filter:
            continue
        messages = t.get("messages", [{"role": "user", "content": t.get("prompt", "")}])
        tools = t.get("tools")
        response, elapsed, err = call_local(cfg, t.get("prompt", ""), tools=tools, messages_override=messages)
        wall_total += elapsed
        if err:
            print(f"  {t['id']:<22}  {'ERR':>8} {'—':>6} {elapsed:>8.2f}s  {err[:60]}")
            results.append({"id": t["id"], "label": t["label"], "score": 0, "max": t["max_score"], "err": err, "raw": ""})
            grand_possible += t["max_score"]
            time.sleep(0.5)
            continue
        try:
            passed = t["eval"](response)
        except Exception as e:
            passed = False
            err = f"scorer_exc:{type(e).__name__}"
        sc = 1 if passed else 0
        results.append({"id": t["id"], "label": t["label"], "score": sc, "max": t["max_score"], "elapsed": elapsed, "raw": response[:400], "err": err or ""})
        grand_total += sc
        grand_possible += t["max_score"]
        marker = "✓" if sc == t["max_score"] else "✗"
        print(f"  {t['id']:<22}  {marker} {sc}/{t['max_score']:<3} {'/':>3}{t['max_score']:<3} {elapsed:>8.2f}s  raw[:60]={response[:60]!r}")
        time.sleep(0.5)

    print("─" * 60)
    pct = 100 * grand_total / grand_possible if grand_possible else 0
    print(f"SCORE: {grand_total}/{grand_possible}  ({pct:.0f}%)  wall: {wall_total:.1f}s")
    return {
        "battery": "T",
        "target": target_key,
        "model": cfg["model"],
        "score": f"{grand_total}/{grand_possible}",
        "pct": pct,
        "wall_s": wall_total,
        "results": results,
    }


def run_r_battery(cfg, target_key, task_filter=None):
    """R1-R6 — 17-pt reasoning probe."""
    print(f"\n{'═' * 80}")
    print(f"R1-R6 REASONING PROBE — {cfg['name']}")
    print(f"  URL:    {BASE_URL}")
    print(f"  Model:  {cfg['model']}")
    print(f"  Max pts: {sum(t['max_score'] for t in R_TESTS)}")
    print(f"{'═' * 80}")

    results = []
    grand_total = 0
    grand_possible = 0
    wall_total = 0.0
    print(f"\n{'Test':<6} {'Score':>8} {'/max':>6} {'Latency':>10}  Notes")
    print("─" * 100)
    for t in R_TESTS:
        if task_filter and t["id"] != task_filter:
            continue
        response, elapsed, err = call_local(cfg, t["prompt"], max_tokens_override=t["max_tokens"])
        wall_total += elapsed
        if err:
            print(f"  {t['id']:<4}  {'ERR':>8} {'—':>6} {elapsed:>8.2f}s  {err[:60]}")
            results.append({"id": t["id"], "score": 0, "max": t["max_score"], "err": err, "raw": ""})
            grand_possible += t["max_score"]
            time.sleep(1.0)
            continue
        sc = t["scorer"](response)
        results.append({"id": t["id"], "score": sc, "max": t["max_score"], "elapsed": elapsed, "raw": response[:400], "err": ""})
        grand_total += sc
        grand_possible += t["max_score"]
        marker = "✓" if sc == t["max_score"] else ("~" if sc > 0 else "✗")
        print(f"  {t['id']:<4}  {marker} {sc}/{t['max_score']:<4} {'/':>3}{t['max_score']:<3} {elapsed:>8.2f}s  raw[:60]={response[:60]!r}")
        time.sleep(1.0)

    print("─" * 100)
    pct = 100 * grand_total / grand_possible if grand_possible else 0
    print(f"SCORE: {grand_total}/{grand_possible}  ({pct:.0f}%)  wall: {wall_total:.1f}s")
    return {
        "battery": "R",
        "target": target_key,
        "model": cfg["model"],
        "score": f"{grand_total}/{grand_possible}",
        "pct": pct,
        "wall_s": wall_total,
        "results": results,
    }


def run_c_battery(cfg, target_key, skip_c8=False):
    """C1-C6 + C8 — 27-pt coding battery."""
    print(f"\n{'═' * 80}")
    print(f"C1-C6+C8 CODING BATTERY — {cfg['name']}")
    print(f"  URL:    {BASE_URL}")
    print(f"  Model:  {cfg['model']}")
    print(f"{'═' * 80}")

    results = []
    grand_total = 0
    grand_possible = 0
    wall_total = 0.0

    print(f"\n{'Test':<6} {'Score':>10} {'/max':>6} {'Latency':>10}  Notes")
    print("─" * 100)
    for tid, label, max_score, prompt, scorer, max_tok in C_TESTS:
        response, elapsed, err = call_local(cfg, prompt, max_tokens_override=max_tok)
        wall_total += elapsed
        if err:
            print(f"  {tid:<4}  {'ERR':>10} {'—':>6} {elapsed:>8.2f}s  {err[:60]}")
            results.append({"id": tid, "label": label, "score": 0, "max": max_score, "err": err, "raw": ""})
            grand_possible += max_score
            time.sleep(1.0)
            continue
        score, notes = scorer(response)
        results.append({
            "id": tid, "label": label, "score": score, "max": max_score,
            "elapsed": elapsed, "raw": response[:2400], "err": "", "notes": notes,
        })
        grand_total += score
        grand_possible += max_score
        marker = "✓" if score == max_score else ("~" if score > 0 else "✗")
        note_str = "; ".join(notes[:2])[:80]
        print(f"  {tid:<4}  {marker} {score}/{max_score:<3} {'/':>3}{max_score:<3} {elapsed:>8.2f}s  {note_str}")
        time.sleep(1.0)

    if not skip_c8:
        print(f"\n  C8   (TTLCache implementation vs vitest)")
        response, elapsed, err = call_local(cfg, build_c8_prompt(), max_tokens_override=4000)
        wall_total += elapsed
        if err:
            print(f"  C8    {'ERR':>10} {'—':>6} {elapsed:>8.2f}s  {err[:60]}")
            results.append({"id": "C8", "label": "TTLCache vs vitest", "score": 0, "max": 5, "err": err, "raw": ""})
            grand_possible += 5
        else:
            score, notes = run_c8(response)
            results.append({
                "id": "C8", "label": "TTLCache vs vitest", "score": score, "max": 5,
                "elapsed": elapsed, "raw": response[:2400], "err": "", "notes": notes,
            })
            grand_total += score
            grand_possible += 5
            marker = "✓" if score == 5 else ("~" if score > 0 else "✗")
            print(f"  C8    {marker} {score}/5    /5    {elapsed:>8.2f}s  {'; '.join(notes[:3])[:80]}")

    print("─" * 100)
    pct = 100 * grand_total / grand_possible if grand_possible else 0
    print(f"SCORE: {grand_total}/{grand_possible}  ({pct:.0f}%)  wall: {wall_total:.1f}s")
    return {
        "battery": "C",
        "target": target_key,
        "model": cfg["model"],
        "score": f"{grand_total}/{grand_possible}",
        "pct": pct,
        "wall_s": wall_total,
        "results": results,
    }


# ════════════════════════════════════════════════════════════════════════════════
# Main — argparse CLI
# ════════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="Local llama-server eval — unified 53-pt battery",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--target", required=True, choices=list(MODELS.keys()),
                        help="Local model alias (must match unified_bench.ts MODELS key)")
    parser.add_argument("--battery", choices=["t", "r", "c", "all"], default="all",
                        help="Which battery to run: t=T1-T9, r=R1-R6, c=C1-C6+C8, all=all three")
    parser.add_argument("--task", default=None,
                        help="Run a single task by ID (e.g. T9_strategic_reasoning, R5, C4). Filters within the chosen battery.")
    parser.add_argument("--skip-c8", action="store_true",
                        help="Skip C8 (vitest install/run) — for environments without bun.")
    parser.add_argument("--out-dir", default=None,
                        help="Override output JSON directory (default: MEMORY/WORK/<this-session>/)")
    args = parser.parse_args()

    if args.target not in MODELS:
        print(f"Unknown target: {args.target}. Use: {', '.join(MODELS.keys())}", file=sys.stderr)
        sys.exit(1)

    cfg = MODELS[args.target]

    # Sanity-check the server is up
    try:
        health_url = BASE_URL.replace("/chat/completions", "/models")
        with urllib.request.urlopen(health_url, timeout=5) as resp:
            models_on_server = json.load(resp).get("data", [])
            available = [m["id"] for m in models_on_server]
            if cfg["model"] not in available:
                print(f"WARN: configured model {cfg['model']!r} not in llama-server model list.", file=sys.stderr)
                print(f"  Available: {available}", file=sys.stderr)
                print(f"  Continuing anyway — the /chat/completions call will fail if model is missing.", file=sys.stderr)
    except Exception as e:
        print(f"WARN: could not reach llama-server /v1/models: {e}", file=sys.stderr)

    all_results = []
    if args.battery in ("t", "all"):
        all_results.append(run_t_battery(cfg, args.target, task_filter=args.task))
    if args.battery in ("r", "all"):
        all_results.append(run_r_battery(cfg, args.target, task_filter=args.task))
    if args.battery in ("c", "all"):
        all_results.append(run_c_battery(cfg, args.target, skip_c8=args.skip_c8))

    # Output JSON
    if args.out_dir:
        out_dir = Path(args.out_dir)
    else:
        out_dir = Path(__file__).resolve().parent.parent.parent / "MEMORY" / "WORK" / "20260623-142943_local-unified-bench-ubullm"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"llamacpp-bench-{args.target}.json"
    with open(out_path, "w") as f:
        json.dump({
            "target": args.target,
            "model": cfg["model"],
            "endpoint": BASE_URL,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "batteries": all_results,
        }, f, indent=2)
    print(f"\nResults saved: {out_path}")


if __name__ == "__main__":
    main()
