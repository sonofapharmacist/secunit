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
        "eval": lambda r: r.strip().upper().startswith("NATIVE"),
        "max_score": 1,
        "max_tokens": 256,
    },
    {
        "id": "T3_classify2",
        "label": "Classify — multi-step task",
        "prompt": """You are a task classifier. Classify as MINIMAL, NATIVE, or ALGORITHM.
Message: "Refactor this entire authentication module to use JWTs, update all tests, and write a migration guide."
Reply with ONLY the word: MINIMAL, NATIVE, or ALGORITHM.""",
        "eval": lambda r: r.strip().upper().startswith("ALGORITHM"),
        "max_score": 1,
        "max_tokens": 256,
    },
    {
        "id": "T4_json",
        "label": "JSON — structured",
        "prompt": 'Return ONLY valid JSON: {"status": "ok", "count": 42}. No other text.',
        "eval": lambda r: (lambda j: j.get("status") == "ok" and j.get("count") == 42)(json.JSONDecoder().raw_decode(_strip_fences(r).strip())[0]),
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


def _trim_trailing_prose(code: str) -> str:
    """Cut unfenced code at the LAST point brace depth returns to 0 — some
    models (e.g. Devstral-2-123B) append a plain-prose explanation after a
    syntactically complete class body with no fence separating the two,
    which otherwise gets fed to the compiler as one blob and fails with a
    spurious parse error deep in the prose. Must use the last zero-crossing,
    not the first — TS code legitimately has multiple top-level `{...}`
    blocks (type aliases, interfaces) before the final class/function body,
    and cutting at the first one discards everything after it.

    Lexer-aware, not a raw character scan: a naive brace count desyncs on any
    `{`/`}` inside a string, template literal, or comment (e.g. `throw new
    Error("expected }")`, a `// } like this` comment, or a `` `${x}` ``
    template interpolation, which nets to balanced but a lone literal brace
    inside a template segment would not). Caught during a dual-model review
    (Cato/Devstral/MiniMax M3 independently, 2026-08-07) of the first,
    character-only version of this function — MiniMax M3 additionally found
    that a stray unbalanced `}` inside a string near the tail could send depth
    negative, after which the real closing brace only returns depth to 0 for
    the FIRST time, silently reproducing the exact bug this function exists to
    fix. This version tracks lexer state so only structural braces count."""
    depth = 0
    seen_open = False
    last_zero_at = None
    state = "code"  # code | sq | dq | template | line_comment | block_comment
    i = 0
    n = len(code)
    while i < n:
        ch = code[i]
        nxt = code[i + 1] if i + 1 < n else ""
        if state == "code":
            if ch == "/" and nxt == "/":
                state = "line_comment"
                i += 2
                continue
            if ch == "/" and nxt == "*":
                state = "block_comment"
                i += 2
                continue
            if ch == "'":
                state = "sq"
            elif ch == '"':
                state = "dq"
            elif ch == "`":
                state = "template"
            elif ch == "{":
                depth += 1
                seen_open = True
            elif ch == "}":
                depth -= 1
                if seen_open and depth == 0:
                    last_zero_at = i
            i += 1
        elif state == "line_comment":
            if ch == "\n":
                state = "code"
            i += 1
        elif state == "block_comment":
            if ch == "*" and nxt == "/":
                state = "code"
                i += 2
                continue
            i += 1
        elif state in ("sq", "dq"):
            if ch == "\\":
                i += 2  # skip escaped char, e.g. \' or \" — can't close the string
                continue
            if (state == "sq" and ch == "'") or (state == "dq" and ch == '"'):
                state = "code"
            i += 1
        elif state == "template":
            if ch == "\\":
                i += 2
                continue
            if ch == "`":
                state = "code"
                i += 1
                continue
            if ch == "$" and nxt == "{":
                # `${...}` interpolation is real code — braces inside it are
                # structural and must count, so drop back to "code" state for
                # the interpolation body and track its own nesting depth to
                # know when to return to "template" state.
                interp_depth = 1
                i += 2
                while i < n and interp_depth > 0:
                    c2 = code[i]
                    if c2 == "{":
                        interp_depth += 1
                        depth += 1
                        seen_open = True
                    elif c2 == "}":
                        interp_depth -= 1
                        if interp_depth == 0:
                            depth -= 1
                            if seen_open and depth == 0:
                                last_zero_at = i
                            i += 1
                            break
                        depth -= 1
                        if seen_open and depth == 0:
                            last_zero_at = i
                    i += 1
                continue
            i += 1
    return code[: last_zero_at + 1] if last_zero_at is not None else code


# Source: coding_battery.py:L1014-1024
def extract_code_block(response: str) -> str:
    m = re.search(r'```(?:typescript|ts)\n(.*?)```', response, re.DOTALL)
    if m:
        return m.group(1).strip()
    m = re.search(r'```\n(.*?)```', response, re.DOTALL)
    if m:
        return m.group(1).strip()
    # No fence at all — some models (e.g. Coder-Next) answer with a plain-prose
    # preamble followed by unfenced code. Cut at the first line that looks like
    # the start of a TS statement rather than feeding the whole response
    # (prose included) to the compiler. Keyword set extended 2026-08-07 (MiniMax
    # M3 dual-review finding) — the original set (export/import/class/function/
    # type/interface/const/let) missed enum/declare/namespace/abstract/async/
    # var/await, so a model leading with any of those fell through to the
    # original whole-response bug this function exists to fix.
    code_start = re.search(r'^\s*(export|import|class|function|type|interface|const|let|enum|declare|namespace|abstract|async|var|await)\b', response, re.MULTILINE)
    if code_start:
        return _trim_trailing_prose(response[code_start.start():].strip())
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
        # Persist full diagnostics — vitest's real stdout/stderr and the exact
        # code that was tested were previously discarded, leaving only the
        # pass/fail count with no way to tell a compile error from a real
        # assertion failure after the fact.
        notes.append(f"VITEST_RAW_OUTPUT:{out}")
        notes.append(f"TESTED_CODE:{code}")
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
    "gptOss120b": {
        "name": "OpenAI GPT-OSS-120B (ubullm, unsloth Q4_K_M, eviction-mode 60GB)",
        "model": "gpt-oss-120b",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,   # MoE, may emit reasoning_content
        "fence_strip": True,
        "type_filter": True,
        # gpt-oss models use harmony chat template with reasoning; reasoning_min_tokens
        # matches gptOss20b pattern above. R2 STRIDE was the long-reasoning canary
        # for gpt-oss-20b; expect same behavior on -120b.
    },
    "kimiLinear48bA3b": {
        "name": "Kimi-Linear-48B-A3B (ubullm, bartowski IQ4_XS, eviction-mode 26GB)",
        "model": "kimi-linear-48b-a3b",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": False,  # hybrid linear-attention; no reasoning trace observed yet
        "fence_strip": True,
        "type_filter": True,
    },
    "qwen36_27b": {
        "name": "Qwen3.6-27B (ubullm, MTP)",
        "model": "qwen36:27b",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,
        # Measured: reasoning_content trace alone hit 12.4K tokens on R2 (STRIDE->JSON)
        # before answer content starts (enable_thinking:false is a no-op for this
        # model's chat template) — see call_local's comment. Same Qwen3.6 family as
        # qwen36_35b_a3b below, so the measurement applies to both.
        "reasoning_min_tokens": 16000,
        "fence_strip": True,
        "type_filter": True,
    },
    "qwen36_35b_a3b": {
        "name": "Qwen3.6-35B-A3B (ubullm production, gated on -c 16384 fix)",
        "model": "qwen36:35b-a3b",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,
        "reasoning_min_tokens": 16000,  # same family/measurement as qwen36_27b above
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
    # ═══ 2026-08-08 alongside-prod + eviction-mode batch (this run) ═══
    "gemma4_12b_it_qat": {
        "name": "gemma-4-12B-it-qat-UD-Q4_K_XL (ubullm, alongside-prod, MTP-capable)",
        "model": "gemma4_12b_qat",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "gemma4_12b_coder_fable5": {
        "name": "gemma-4-12B-coder-fable5-composer2.5-v1 Q4_K_M (ubullm, alongside-prod)",
        "model": "gemma4_12b_coder_fable5",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "xgemable_12b_coder": {
        "name": "xGemable-12B-coder-v1.5 Q4_K_M (ubullm, alongside-prod)",
        "model": "xgemable_12b_coder",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "jackrong_v4_pro_qwen35_9b_mtp": {
        "name": "Jackrong DeepSeek-V4-Pro-Qwen3.5-9B-MTP IQ4_XS (ubullm, V4 distill, MTP)",
        "model": "jackrong_v4_mtp",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": True,  # MTP speculative-decoding model, may emit reasoning trace
        "reasoning_min_tokens": 4096,
        "fence_strip": True,
        "type_filter": False,
    },
    "deepseek_r1_distill_qwen32b": {
        "name": "DeepSeek-R1-Distill-Qwen-32B Q5_K_M (bartowski, ubullm, R1 reasoning distilled into Qwen2.5-32B)",
        "model": "deepseek_r1_distill_qwen32b",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,  # R1-distill emits chain-of-thought in reasoning_content (verified ISC-5)
        "reasoning_min_tokens": 12000,  # R1-distill-Qwen-32B traces routinely exceed 8K tokens
        "reasoning_timeout_s": 600,
        "fence_strip": True,
        "type_filter": False,
    },
    "unsloth_qwen35_9b_mtp": {
        "name": "unsloth Qwen3.5-9B-MTP IQ4_XS (ubullm, V4 distill lineage, MTP)",
        "model": "unsloth_v4_mtp",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": True,
        "reasoning_min_tokens": 4096,
        "fence_strip": True,
        "type_filter": False,
    },
    "kat_coder_v25_apex": {
        "name": "KAT-Coder-V2.5-Dev-APEX-Compact (ubullm, eviction-mode, 132K dl)",
        "model": "kat_coder_v25_apex",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "ornith_35b_q4km": {
        "name": "Ornith-1.0-35B-Instruct Q4_K_M (ubullm, eviction-mode)",
        "model": "ornith_35b_q4km",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "qwopus_35b_mtp": {
        "name": "Qwopus3.6-35B-A3B-Coder-MTP Q4_K_M (ubullm, eviction-mode, MTP)",
        "model": "qwopus_35b_mtp",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": True,
        "reasoning_min_tokens": 8192,  # 35B-A3B needs more reasoning headroom
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
    "museGlimmer30b": {
        "name": "Meta Muse Glimmer 30B (ubullm, K-Quant-17GB, dense+vision, one-shot test)",
        "model": "muse-glimmer-30b",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "museGlimmer30bKquantDynamic": {
        "name": "Meta Muse Glimmer 30B (ubullm, K-Quant-Dynamic 19.7GB, Meta-recommended sampler temp=1/top_p=0.95/top_k=64 set server-side)",
        "model": "museGlimmer30bKquantDynamic",
        "max_tokens": 4096,
        "temperature": 1,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "museGlimmer30bKquantDynamicServerDefault": {
        "name": "Meta Muse Glimmer 30B (ubullm, K-Quant-Dynamic 19.7GB, llama-server documented defaults temp=0.8/top_p=0.95/top_k=40 set explicitly since harness always sends a temperature field)",
        "model": "museGlimmer30bKquantDynamicServerDefault",
        "max_tokens": 4096,
        "temperature": 0.8,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "coder_next": {
        "name": "Qwen3-Coder-Next (ubullm, Q4_K_M, dual-GPU, 80B-A3B)",
        "model": "coder-next",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "qwen38_27b": {
        "name": "Qwen3.8-27B (ubullm, unsloth UD-Q4_K_XL, dense, alongside-prod)",
        "model": "qwen38_27b",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,
        # Measured 2026-08-14: always emits reasoning_content, even on a trivial
        # one-line prompt (230 tokens for "please paste the code"). First bench pass
        # with is_reasoning=False scored R3/R5/R6 as 0/0/0 with raw="" and real
        # tok/s logged — the trace was silently eating the whole max_tokens budget
        # (1200-1500 on those three) before any content could be emitted. Same Qwen
        # dense-27B lineage as qwen36_27b above; borrowing its 16000 floor as the
        # starting point pending its own measurement of a worst-case trace length.
        "reasoning_min_tokens": 16000,
        "reasoning_timeout_s": 600,
        "fence_strip": True,
        "type_filter": True,
    },
    "qwen38_27b_q8": {
        "name": "Qwen3.8-27B (ubullm, unsloth Q8_0, dense, quant-comparison)",
        "model": "qwen38_27b_q8",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,
        # Same config as qwen38_27b (UD-Q4_K_XL) — added 2026-08-15 as part of the
        # scope-creep regression campaign testing whether the R3/R5/C1/C2/C6
        # empty-content/finish_reason:length signature is quant-specific. Borrowing
        # the identical reasoning_min_tokens floor for an apples-to-apples
        # comparison against the Q4 baseline.
        # reasoning_timeout_s bumped 900 2026-08-15 — measured C1/C2/C6 at Q8_0
        # taking 703-705s (vs Q4's ~524s for the identical 16000-token ceiling;
        # same bug, slower per-token at higher precision). 600s would truncate
        # a genuine-but-slow completion and misreport it as a harness timeout
        # error rather than the real empty-content/finish_reason:length result.
        "reasoning_min_tokens": 16000,
        "reasoning_timeout_s": 900,
        "fence_strip": True,
        "type_filter": True,
    },
    "qwen38_27b_bf16": {
        "name": "Qwen3.8-27B (ubullm, unsloth BF16 full precision, dense, quant-comparison)",
        "model": "qwen38_27b_bf16",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,
        # Same config as qwen38_27b (UD-Q4_K_XL) — see qwen38_27b_q8 above for
        # rationale. Full-precision BF16 comparison point for the same campaign.
        # reasoning_timeout_s bumped 1300 2026-08-15 — measured C1/C2/C6 at BF16
        # taking 1095-1096s for the identical 16000-token ceiling (same bug,
        # slowest per-token throughput of the three quants). See qwen38_27b_q8
        # comment above for why an under-provisioned timeout corrupts the result.
        "reasoning_min_tokens": 16000,
        "reasoning_timeout_s": 1300,
        "fence_strip": True,
        "type_filter": True,
    },
    "coder_next_q4km_unrecorded": {
        "name": "Qwen3-Coder-Next (ubullm, Q4_K_M, dual-GPU, 80B-A3B, unrecorded variant — file Qwen3-Coder-Next-Q4_K_M.gguf 48.5GB on disk, NOT the live IQ4_NL prod)",
        "model": "coder-next",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,
        "reasoning_min_tokens": 16000,
        "reasoning_timeout_s": 600,
        "fence_strip": True,
        "type_filter": True,
    },
    "glm45air": {
        "name": "GLM-4.5-Air (ubullm, UD-IQ2_XXS, dual-GPU, 110B-A12B)",
        "model": "glm45air",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,  # confirmed via sanity check: emits reasoning_content, burns full budget on thinking at low max_tokens
        # Measured: R5 exhausted 8000 AND 16000 tokens on reasoning alone, never reached
        # content (finish_reason: "length", content stays ""). Bumped 16000 -> 32000
        # 2026-08-07 per GP's direct observation that this model (and glm47flash) were
        # not finishing reasoning-heavy tasks at EITHER 8K or 16K — confirms this is a
        # genuine slow/verbose-reasoner pattern on this hardware, not a one-off IQ2
        # quant fluke. Paired with reasoning_timeout_s below since 32K reasoning tokens
        # can exceed the default 180s LLAMACPP_TIMEOUT on V100 well before hitting the
        # token ceiling — conflating the two knobs is what caused this to look like a
        # capability collapse in the first bench round instead of a starved budget.
        "reasoning_min_tokens": 32000,
        "reasoning_timeout_s": 600,
        "fence_strip": True,
        "type_filter": True,
    },
    "glm45air_q3kxl": {
        "name": "GLM-4.5-Air (ubullm, Q3_K_XL, dual-GPU, 110B-A12B, larger quant than glm45air's UD-IQ2_XXS)",
        "model": "glm45air_q3kxl",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,
        # Added 2026-08-15 as part of the Qwen3.8-27B scope-creep campaign's follow-up:
        # the greedy-sampling "empty content" pattern found on glm45air/glm47flash was
        # root-caused as a greedy-decoding pathology (same mechanism found in Qwen3.8),
        # not a genuine GLM-family capability gap. glm47flash confirmed 39/53 -> 47/53
        # under Unsloth's recommended sampler. Testing whether the same fix applies to
        # this larger 110B-A12B sibling at its largest quant that fits ubullm's 64GB
        # pool with full -c 32768 headroom (Q3_K_XL, 56.45GB — Q4-class quants were
        # ruled out at ~0-3GB headroom, too tight for the full context this campaign
        # needs). Same reasoning_min_tokens/timeout as glm45air (same architecture).
        "reasoning_min_tokens": 32000,
        "reasoning_timeout_s": 900,
        "fence_strip": True,
        "type_filter": True,
    },
    "glm47flash": {
        "name": "GLM-4.7-Flash (ubullm, UD-Q4_K_XL, dual-GPU, 30B-A3B)",
        "model": "glm47flash",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,  # confirmed via sanity check: emits reasoning_content
        # reasoning_min_tokens REMOVED then RESTORED 2026-08-07. First removed on a
        # dual-model review finding (Cato/Devstral/MiniMax M3) that 16000 was copied
        # from glm45air without its own measurement. Restored at 32000 (higher than
        # the original 16000) per GP's direct observation that this model was ALSO not
        # finishing reasoning-heavy tasks at 8K or 16K, same pattern as glm45air — so
        # the original floor wasn't wrong, it was under-measured, and the real ceiling
        # is higher than either prior guess. Paired with a longer reasoning_timeout_s
        # so the harness doesn't cut the model off before it can spend the budget.
        "reasoning_min_tokens": 32000,
        "reasoning_timeout_s": 600,
        "fence_strip": True,
        "type_filter": True,
    },
    "glm45air_iq2m": {
        "name": "GLM-4.5-Air (ubullm, UD-IQ2_M, dual-GPU, 110B-A12B, less aggressive quant)",
        "model": "glm45air-iq2m",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,
        # reasoning_min_tokens bumped to 32000 2026-08-07, matching glm45air/glm47flash
        # — same underlying 110B-A12B architecture as glm45air (just a less aggressive
        # IQ2_M quant), and the same non-completion pattern was directly observed
        # across both other GLM entries at 8K/16K. Not independently re-measured on
        # THIS quant specifically, but the shared-architecture inference is now backed
        # by two confirmed data points instead of zero. See reasoning_timeout_s below.
        "reasoning_min_tokens": 32000,
        "reasoning_timeout_s": 600,
        "fence_strip": True,
        "type_filter": True,
    },
    "devstral_small2": {
        "name": "Devstral Small 2 (ubullm, UD-Q4_K_XL, dual-GPU, 24B dense)",
        "model": "devstral-small2",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "devstral2_123b": {
        "name": "Devstral-2-123B (ubullm, UD-IQ3_XXS, dual-GPU, 125B dense-ish, ~8.6 tok/s)",
        "model": "devstral2-123b",
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
    "nemotron35Lightning30b": {
        "name": "NVIDIA Nemotron-3.5-Lightning-30B-A3B (ubullm, Q4_K_M via Ollama blob extraction, Mamba-2+MoE+Attention hybrid, nemotron_h arch)",
        "model": "nemotron35Lightning30b",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": True,  # emits full CoT in reasoning_content, verified via direct probe: C1 prompt at max_tokens=2500 hit finish_reason=length with content="" and reasoning_content=9244 chars, never reached the answer
        "reasoning_min_tokens": 12000,  # matches deepseek_r1_distill_qwen32b's floor as a starting point — traces observed running long on non-trivial prompts
        "reasoning_timeout_s": 600,
        "fence_strip": True,
        "type_filter": False,
    },
    "thinkingCapQwen36_27b": {
        "name": "BottleCap AI ThinkingCap-Qwen3.6-27B (ubullm, Q4_K_M, RL post-trained for reasoning brevity, tool calling verified working)",
        "model": "thinkingCapQwen36_27b",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": True,  # emits reasoning_content like base Qwen3.6; direct probe showed a SHORT trace (74 total completion tokens on a tool-call task) consistent with the model's claimed brevity — is_reasoning still True so the harness correctly parses the reasoning/content split, but reasoning_min_tokens left at a moderate default given the observed brevity
        "reasoning_min_tokens": 6000,  # half of the deepseek_r1_distill/nemotron floor — probe evidence suggests much shorter traces for this model
        "reasoning_timeout_s": 400,
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
        "is_reasoning": True,
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
    # Added 2026-06-30 — local reproduction of the NIM 43/53 cloud result.
    # Nemotron-3-Nano-Omni-30B-A3B-Reasoning, IQ4_NL, nemotron_h_moe (Mamba2-hybrid)
    # arch — VERIFIED to load + generate on V100 sm_70 this date. Reasoning model,
    # so temp=1 + is_reasoning True (16K token floor) + fence_strip, matching the
    # cloud run that scored 43/53. GGUF is text-head only (Omni multimodal encoders
    # don't load), so R5 reproduction is NOT guaranteed — see reference memory.
    "nemotron3_30b_a3b_r": {
        "name": "Nemotron-3-Nano-Omni-30B-A3B-R (ubullm, IQ4_NL, reasoning)",
        "model": "nemotron30b-a3b-r",
        "max_tokens": 8192,
        "temperature": 1,
        "is_reasoning": True,
        "reasoning_min_tokens": 16000,  # matches the cloud run this entry reproduces
        "fence_strip": True,
        "type_filter": False,
    },
    # Added 2026-06-30 — gap-fill batch. mistral-small-3.1-24b is the last on-disk
    # model never to get a full 53-pt run (only throughput-benched historically).
    # Dense 24B; non-reasoning. temp=0, fence_strip on. type_filter False (dense).
    "mistral_small31_24b": {
        "name": "Mistral-Small-3.1-24B (ubullm, Q4_K_M)",
        "model": "mistral-sm31:24b",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    # ─── 2026-08-07 batch: 64GB-fits candidates ────────────────────────────────
    "apriel_15b_thinker": {
        "name": "Apriel-1.5-15b-Thinker (ubullm, UD-Q4_K_XL, 15B dense, thinking mode)",
        "model": "apriel_15b_thinker",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,
        "reasoning_min_tokens": 16000,
        "reasoning_timeout_s": 600,
        "fence_strip": True,
        "type_filter": True,
    },
    "gemma_3_27b": {
        "name": "gemma-3-27b-it (ubullm, Q4_K_M, 27B dense)",
        "model": "gemma_3_27b",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "glm4_32b": {
        "name": "GLM-4-32B-0414 (ubullm, Q4_K_M, 32B dense)",
        "model": "glm4_32b",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "seed_oss_36b": {
        "name": "Seed-OSS-36B-Instruct (ubullm, Q4_K_M, 36B dense)",
        "model": "seed_oss_36b",
        "max_tokens": 4096,
        "temperature": 0,
        "is_reasoning": False,
        "fence_strip": True,
        "type_filter": False,
    },
    "qwen3_next_80b_a3b": {
        "name": "Qwen3-Next-80B-A3B-Instruct (ubullm, IQ4_NL, 80B-A3B MoE)",
        "model": "qwen3_next_80b_a3b",
        "max_tokens": 8192,
        "temperature": 0,
        "is_reasoning": True,
        "reasoning_min_tokens": 16000,
        "reasoning_timeout_s": 600,
        "fence_strip": True,
        "type_filter": True,
    },
    # Alias for the bench wrapper — points at the existing devstral_small2 MODELS entry.
    "devstral_small_2_24b": {
        "name": "Devstral Small 2 (ubullm, UD-Q4_K_XL, dual-GPU, 24B dense)",
        "model": "devstral-small2",
        "max_tokens": 4096,
        "temperature": 0,
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

def call_local(cfg, prompt, max_tokens_override=None, tools=None, messages_override=None, sampler_override=None):
    """Returns (content_or_TOOL_CALLED, elapsed, err, tps).

    tps is {"predicted_per_second": float|None, "prompt_per_second": float|None}
    pulled from llama-server's response.timings block — None on any error path
    or if the server omits timings (e.g. non-llama.cpp backend).

    sampler_override (dict|None) — optional per-request sampler field overrides applied
    to the OpenAI-compat payload. Keys: temperature, top_p, top_k, min_p,
    repeat_penalty, presence_penalty, frequency_penalty. Only present keys are
    added (None values skipped). Defaults to None; caller may pass an empty dict to
    suppress MODELS-level defaults. Added 2026-08-10 per
    `PAI/MEMORY/KNOWLEDGE/Research/local-llm-sampler-tuning-2026-08-10.md` so a model
    can be re-benched under its manufacturer's official sampler config without
    editing MODELS.
    """
    # `is not None` (not `or`) — max_tokens_override=0 is a legitimate explicit value,
    # not "unset". The old `or` treated it as falsy and silently substituted cfg["max_tokens"],
    # removing the caller's ability to set a lower budget than the config default.
    base = max_tokens_override if max_tokens_override is not None else cfg["max_tokens"]
    # Reasoning floor is per-model opt-in via reasoning_min_tokens, not a blanket value
    # for every is_reasoning=True model. As of 2026-08-07, models with an empirical basis
    # for their floor (see their config comments) are: Qwen3.6 (qwen36_27b/35b_a3b) and
    # nemotron3_30b_a3b_r at 16K, and glm45air/glm47flash/glm45air_iq2m at 32K — the GLM
    # trio was first set to 16K (glm45air measured, the other two copied without
    # measurement), found in a dual-model review to be under-documented for two of the
    # three, then bumped to 32K across all three on GP's direct observation that none of
    # them were finishing reasoning-heavy tasks at EITHER 8K or 16K. This list is the
    # source of truth for "is this floor justified" — keep it in sync whenever a
    # reasoning_min_tokens entry is added, removed, or changed in MODELS above, so a
    # future session doesn't misread stale text. Applying a floor without measurement
    # silently inflates max_tokens for models never shown to need it, shrinking their
    # margin against LLAMACPP_TIMEOUT — which is why a model with a floor this large
    # should also carry reasoning_timeout_s (see below): a token budget alone doesn't
    # help if the harness gives up waiting before the model can spend it, and that
    # exact conflation is what made the GLM trio look like a capability collapse in the
    # first bench round instead of a starved wall-clock budget. Unlisted reasoning
    # models keep their own configured max_tokens — no forced floor.
    reasoning_min = cfg.get("reasoning_min_tokens")
    effective_max = max(base, reasoning_min) if reasoning_min else base
    if reasoning_min and base < reasoning_min:
        print(f"  [reasoning floor] {cfg['name']}: requested {base} tokens, raised to {effective_max} (reasoning_min_tokens)", file=sys.stderr)

    # Per-model timeout override, paired with reasoning_min_tokens for models whose
    # measured token budget is large enough that the default LLAMACPP_TIMEOUT (180s)
    # would cut the request off before the model can generate up to that budget. Only
    # set on entries where a larger floor was specifically added for this reason —
    # unlisted models keep the global TIMEOUT.
    effective_timeout = cfg.get("reasoning_timeout_s", TIMEOUT)

    payload = {
        "model": cfg["model"],
        "max_tokens": effective_max,
        "temperature": cfg["temperature"],
        "messages": messages_override or [{"role": "user", "content": prompt}],
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    # Sampler override — apply last so a request can replace MODELS-level defaults.
    # `is not None` (not truthiness) so 0.0 / 0 are respected as legitimate explicit
    # values. Unknown keys are silently ignored to keep this safe across llama-server
    # version drift (newer builds may add fields we don't track here).
    if sampler_override:
        for k, v in sampler_override.items():
            if v is not None and k in {
                "temperature", "top_p", "top_k", "min_p",
                "repeat_penalty", "presence_penalty", "frequency_penalty",
            }:
                payload[k] = v

    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE_URL, data=data, headers={
        "Content-Type": "application/json",
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=effective_timeout) as resp:
            result = json.load(resp)
            elapsed = time.time() - t0
            timings = result.get("timings") or {}
            tps = {
                "predicted_per_second": timings.get("predicted_per_second"),
                "prompt_per_second": timings.get("prompt_per_second"),
            }
            choices = result.get("choices", [])
            if not choices:
                return "", elapsed, "ERR:no_choices", tps
            msg = choices[0].get("message", {})

            # Tool call detection — match mistral_eval.py:177-179
            if msg.get("tool_calls"):
                return "TOOL_CALLED", elapsed, None, tps

            content = msg.get("content")
            if content is None:
                return "", elapsed, f"ERR:content_null:{json.dumps(result)[:150]}", tps

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

            # Reasoning-leak detector: some Qwen-family models (see targeted_bench.py:78,
            # nous_eval.py:40) dump raw <think>...</think> traces straight into `content`
            # instead of a separate reasoning_content field, which neither type_filter (only
            # fires on list-shaped content) nor fence_strip (only strips ```json fences)
            # catches. Previously this was a manual "watch for it at T1" comment with no
            # actual check — flag it here so a leak surfaces immediately instead of silently
            # corrupting scorer input. Only warns when is_reasoning=False: a model already
            # configured as reasoning is expected to emit <think> tags, so that's not a
            # surprise worth flagging — the risk is specifically an unconfigured leak.
            if not cfg.get("is_reasoning", False) and isinstance(content, str) and \
               ("<think>" in content or "<thinking>" in content):
                print(f"  [reasoning leak] {cfg['name']}: <think> tag found in content on a "
                      f"model configured is_reasoning=False — flip is_reasoning to True and "
                      f"set type_filter accordingly", file=sys.stderr)

            return content or "", elapsed, None, tps
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode()[:120]
        except Exception:
            pass
        return "", time.time() - t0, f"HTTP{e.code}:{body}", {"predicted_per_second": None, "prompt_per_second": None}
    except Exception as e:
        return "", time.time() - t0, f"EXC:{type(e).__name__}:{str(e)[:80]}", {"predicted_per_second": None, "prompt_per_second": None}


# ════════════════════════════════════════════════════════════════════════════════
# Runner
# ════════════════════════════════════════════════════════════════════════════════

"""Full-response archive (added 2026-08-14).

The `raw` field in every result is a truncated preview (400 chars for T/R,
2400 for C). That truncation is a *serialization* choice, not a storage one --
the complete model output was never written anywhere, so a past score could not
be re-audited without re-running the model. That cost a prod eviction window on
2026-08-14 when two R5 = 2/2 results (a claimed break of the documented
"0/N local models break R5" ceiling) could not be verified from the archive:
the 400-char preview was physically incapable of showing whether the model named
both the off-by-one AND the memory leak.

Fix: keep the preview in the JSON for readability, write the complete response
to a sibling file, and store a pointer to it. `/data` on ubullm is a 9.1TB HDD
at 45% (4.8TB free); a full 53-pt run's untruncated output is a few MB. Storing
evidence alongside scores is effectively free and makes every past score
re-auditable without touching the GPU.

Archive root is overridable via BENCH_ARCHIVE_DIR. Default targets ubullm's
/data when running on the host itself; the pointer is written regardless so the
JSON always records where the full text was meant to land.
"""
ARCHIVE_ROOT = Path(os.environ.get("BENCH_ARCHIVE_DIR", "/data/bench-archive"))
_ARCHIVE_RUN_ID = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
_ARCHIVE_WARNED = False


def archive_response(target_key, battery, test_id, response):
    """Write the full untruncated response; return a relative pointer string.

    Returns the pointer even if the write fails -- the JSON should always record
    where the evidence was supposed to be, so a missing file is diagnosable
    rather than invisible. Never raises: archival is best-effort and must never
    fail a bench run (same contract as flush_progress).
    """
    global _ARCHIVE_WARNED
    rel = f"{target_key}/{_ARCHIVE_RUN_ID}/{battery}_{test_id}.txt"
    try:
        dest = ARCHIVE_ROOT / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(response or "", encoding="utf-8")
    except Exception as e:
        if not _ARCHIVE_WARNED:
            print(f"  [archive warn] {type(e).__name__}: {str(e)[:80]} "
                  f"(root={ARCHIVE_ROOT}; set BENCH_ARCHIVE_DIR to override)", file=sys.stderr)
            _ARCHIVE_WARNED = True
    return rel


def check_archive_writable():
    """Probe ARCHIVE_ROOT for a real write before the battery starts.

    archive_response()'s per-call warning only fires after the first of
    potentially dozens of failed writes, to stderr -- easy to lose if stderr
    isn't captured (exactly what happened to the 2026-08-15 Qwen3.8-27B
    campaign: run from a non-ubullm host, BENCH_ARCHIVE_DIR pointed at a
    scratch path that didn't survive, archival silently degraded to
    preview-only for the whole run, tok/s and full outputs both lost). This
    is a one-time upfront check with a loud banner, printed before any GPU
    time is spent, so a bad archive root is diagnosable at second zero
    instead of discovered after the run.

    Does not raise or block the run -- archival stays best-effort by design
    (same contract as archive_response/flush_progress), but a broken root
    should never be silent.
    """
    probe = ARCHIVE_ROOT / f".write_probe_{_ARCHIVE_RUN_ID}"
    try:
        probe.parent.mkdir(parents=True, exist_ok=True)
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True
    except Exception as e:
        print(f"\n{'!' * 80}", file=sys.stderr)
        print(f"WARN: archive root not writable — full outputs and this run's evidence", file=sys.stderr)
        print(f"      will NOT be saved. Scores/tok-s in the results JSON are unaffected,", file=sys.stderr)
        print(f"      but archive_response() pointers will point at nothing.", file=sys.stderr)
        print(f"  root:  {ARCHIVE_ROOT}", file=sys.stderr)
        print(f"  error: {type(e).__name__}: {str(e)[:120]}", file=sys.stderr)
        print(f"  fix:   set BENCH_ARCHIVE_DIR to a real writable path before running", file=sys.stderr)
        print(f"{'!' * 80}\n", file=sys.stderr)
        return False


def run_t_battery(cfg, target_key, task_filter=None, on_task_done=None, sampler_override=None):
    """T1-T9 — single-step classifier battery. 9 pts max.

    on_task_done: optional callable(results_so_far) invoked after each task,
                  for per-task persistence by callers (e.g. main()).
    sampler_override: optional dict passed through to call_local() (see call_local docstring).
    """
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
        response, elapsed, err, tps = call_local(cfg, t.get("prompt", ""), tools=tools, messages_override=messages, sampler_override=sampler_override)
        wall_total += elapsed
        if err:
            print(f"  {t['id']:<22}  {'ERR':>8} {'—':>6} {elapsed:>8.2f}s  {err[:60]}")
            results.append({"id": t["id"], "label": t["label"], "score": 0, "max": t["max_score"], "err": err, "raw": "", "tps": tps})
            grand_possible += t["max_score"]
            if on_task_done: on_task_done(results)
            time.sleep(0.5)
            continue
        try:
            passed = t["eval"](response)
        except Exception as e:
            passed = False
            err = f"scorer_exc:{type(e).__name__}"
        sc = 1 if passed else 0
        results.append({"id": t["id"], "label": t["label"], "score": sc, "max": t["max_score"], "elapsed": elapsed, "raw": response[:400], "raw_full_ref": archive_response(target_key, "T", t["id"], response), "err": err or "", "tps": tps})
        grand_total += sc
        grand_possible += t["max_score"]
        marker = "✓" if sc == t["max_score"] else "✗"
        print(f"  {t['id']:<22}  {marker} {sc}/{t['max_score']:<3} {'/':>3}{t['max_score']:<3} {elapsed:>8.2f}s  raw[:60]={response[:60]!r}")
        if on_task_done: on_task_done(results)
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


def run_r_battery(cfg, target_key, task_filter=None, on_task_done=None, sampler_override=None):
    """R1-R6 — 17-pt reasoning probe.

    on_task_done: optional callable(results_so_far) invoked after each task,
                  for per-task persistence by callers (e.g. main()).
    """
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
        response, elapsed, err, tps = call_local(cfg, t["prompt"], max_tokens_override=t["max_tokens"], sampler_override=sampler_override)
        wall_total += elapsed
        if err:
            print(f"  {t['id']:<4}  {'ERR':>8} {'—':>6} {elapsed:>8.2f}s  {err[:60]}")
            results.append({"id": t["id"], "score": 0, "max": t["max_score"], "err": err, "raw": "", "tps": tps})
            grand_possible += t["max_score"]
            if on_task_done: on_task_done(results)
            time.sleep(1.0)
            continue
        sc = t["scorer"](response)
        results.append({"id": t["id"], "score": sc, "max": t["max_score"], "elapsed": elapsed, "raw": response[:400], "raw_full_ref": archive_response(target_key, "R", t["id"], response), "err": "", "tps": tps})
        grand_total += sc
        grand_possible += t["max_score"]
        marker = "✓" if sc == t["max_score"] else ("~" if sc > 0 else "✗")
        print(f"  {t['id']:<4}  {marker} {sc}/{t['max_score']:<4} {'/':>3}{t['max_score']:<3} {elapsed:>8.2f}s  raw[:60]={response[:60]!r}")
        if on_task_done: on_task_done(results)
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


def run_c_battery(cfg, target_key, skip_c8=False, on_task_done=None, sampler_override=None):
    """C1-C6 + C8 — 27-pt coding battery.

    on_task_done: optional callable(results_so_far) invoked after each task,
                  for per-task persistence by callers (e.g. main()).
    """
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
        response, elapsed, err, tps = call_local(cfg, prompt, max_tokens_override=max_tok, sampler_override=sampler_override)
        wall_total += elapsed
        if err:
            print(f"  {tid:<4}  {'ERR':>10} {'—':>6} {elapsed:>8.2f}s  {err[:60]}")
            results.append({"id": tid, "label": label, "score": 0, "max": max_score, "err": err, "raw": "", "tps": tps})
            grand_possible += max_score
            if on_task_done: on_task_done(results)
            time.sleep(1.0)
            continue
        score, notes = scorer(response)
        results.append({
            "id": tid, "label": label, "score": score, "max": max_score,
            "elapsed": elapsed, "raw": response[:2400],
            "raw_full_ref": archive_response(target_key, "C", tid, response),
            "err": "", "notes": notes, "tps": tps,
        })
        grand_total += score
        grand_possible += max_score
        marker = "✓" if score == max_score else ("~" if score > 0 else "✗")
        note_str = "; ".join(notes[:2])[:80]
        print(f"  {tid:<4}  {marker} {score}/{max_score:<3} {'/':>3}{max_score:<3} {elapsed:>8.2f}s  {note_str}")
        if on_task_done: on_task_done(results)
        time.sleep(1.0)

    if not skip_c8:
        print(f"\n  C8   (TTLCache implementation vs vitest)")
        response, elapsed, err, tps = call_local(cfg, build_c8_prompt(), max_tokens_override=4000, sampler_override=sampler_override)
        wall_total += elapsed
        if err:
            print(f"  C8    {'ERR':>10} {'—':>6} {elapsed:>8.2f}s  {err[:60]}")
            results.append({"id": "C8", "label": "TTLCache vs vitest", "score": 0, "max": 5, "err": err, "raw": "", "tps": tps})
            grand_possible += 5
            if on_task_done: on_task_done(results)
        else:
            score, notes = run_c8(response)
            results.append({
                "id": "C8", "label": "TTLCache vs vitest", "score": score, "max": 5,
                "elapsed": elapsed, "raw": response[:2400],
                "raw_full_ref": archive_response(target_key, "C", "C8", response),
                "err": "", "notes": notes, "tps": tps,
            })
            grand_total += score
            grand_possible += 5
            marker = "✓" if score == 5 else ("~" if score > 0 else "✗")
            print(f"  C8    {marker} {score}/5    /5    {elapsed:>8.2f}s  {'; '.join(notes[:3])[:80]}")
            if on_task_done: on_task_done(results)

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
    # Sampler override flags (added 2026-08-10 per
    # `PAI/MEMORY/KNOWLEDGE/Research/local-llm-sampler-tuning-2026-08-10.md`).
    # Default = None means "use the value from MODELS[<target>]" (currently always
    # temperature=0 / greedy). Setting any of these forces the OpenAI-compat field of
    # the same name on every request in the run. Use to re-bench a model under its
    # manufacturer's official sampler block (e.g. qwen team: T=0.7, top_p=0.8,
    # top_k=20, repeat_penalty=1.1) without editing MODELS in place. Each flag's
    # presence is recorded in the run JSON's `sampler_override` block so per-run
    # results are never silently conflated with the greedy baseline.
    sampler = parser.add_argument_group(
        "sampler override (per-flag; unset = use MODELS[<target>] value)")
    sampler.add_argument("--temperature", type=float, default=None,
                         help="Override sampling temperature (0.0–2.0). Default unset = greedy.")
    sampler.add_argument("--top-p", dest="top_p", type=float, default=None,
                         help="Override nucleus sampling top_p (0.0–1.0).")
    sampler.add_argument("--top-k", dest="top_k", type=int, default=None,
                         help="Override top-k cutoff (int; 0 disables).")
    sampler.add_argument("--min-p", dest="min_p", type=float, default=None,
                         help="Override min-p floor (0.0–1.0).")
    sampler.add_argument("--repeat-penalty", dest="repeat_penalty", type=float, default=None,
                         help="Override repeat penalty (1.0 = neutral; 1.05–1.15 typical).")
    sampler.add_argument("--presence-penalty", dest="presence_penalty", type=float, default=None,
                         help="Override presence penalty (0.0–2.0; >1.0 breaks CoT on reasoning models).")
    sampler.add_argument("--frequency-penalty", dest="frequency_penalty", type=float, default=None,
                         help="Override frequency penalty (0.0–2.0).")
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

    check_archive_writable()

    all_results = []
    current_battery_name = None
    current_results = []

    # Set up output path BEFORE flush_progress so the closure can resolve it
    # (prior code defined this AFTER flush_progress → NameError on every task).
    if args.out_dir:
        out_dir = Path(args.out_dir)
    else:
        out_dir = Path(__file__).resolve().parent.parent.parent / "MEMORY" / "WORK" / "20260623-142943_local-unified-bench-ubullm"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"llamacpp-bench-{args.target}.json"

    def flush_progress():
        """Atomic-rename persist of in-progress JSON (added 2026-08-07).

        Durability fix for the pre-existing failure mode where any wrapper/SSH/
        bench crash mid-53-pt nuked the entire run; the prior write-once-at-end
        design lost everything on disconnect. Writes to <out_path>.tmp then
        os.replace() so a partial file can never replace a good one. Errors
        swallowed: persistence is best-effort, never blocks the bench.
        """
        try:
            payload = {
                "target": args.target,
                "model": cfg["model"],
                "endpoint": BASE_URL,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "_in_progress": True,
                # Durable pointer to the untruncated responses (see archive_response).
                # `raw` fields are previews; this is where the real evidence lives.
                "archive_root": str(ARCHIVE_ROOT),
                "archive_run": f"{args.target}/{_ARCHIVE_RUN_ID}",
                # Recorded so per-run results are never silently conflated with the
                # greedy baseline (MODELS temperature=0). Empty dict = exact pre-2026-08-10
                # behavior. Added per
                # `PAI/MEMORY/KNOWLEDGE/Research/local-llm-sampler-tuning-2026-08-10.md`.
                "sampler_override": sampler_override,
                "batteries": list(all_results) + (
                    [_build_partial_battery(current_results, args.target, cfg, current_battery_name)]
                    if current_results and current_battery_name else []
                ),
            }
            tmp = out_path.with_suffix(out_path.suffix + ".tmp")
            with open(tmp, "w") as f:
                json.dump(payload, f, indent=2)
            os.replace(tmp, out_path)
        except Exception as e:
            print(f"  [flush_progress warn] {type(e).__name__}: {str(e)[:80]}", file=sys.stderr)

    def on_task_done(results_so_far):
        current_results.clear()
        current_results.extend(results_so_far)
        flush_progress()

    # Collect sampler overrides from CLI — only include keys the user actually set
    # (None values skipped downstream), so unset flags fall through to MODELS
    # defaults (currently always temperature=0). Empty dict when no flag passed =
    # exact behavior of the pre-2026-08-10 harness.
    sampler_override = {
        k: v for k, v in {
            "temperature": args.temperature,
            "top_p": args.top_p,
            "top_k": args.top_k,
            "min_p": args.min_p,
            "repeat_penalty": args.repeat_penalty,
            "presence_penalty": args.presence_penalty,
            "frequency_penalty": args.frequency_penalty,
        }.items() if v is not None
    }

    if args.battery in ("t", "all"):
        current_battery_name = "T"
        current_results = []
        all_results.append(run_t_battery(cfg, args.target, task_filter=args.task, on_task_done=on_task_done, sampler_override=sampler_override))
        current_battery_name = None
        current_results = []
        flush_progress()
    if args.battery in ("r", "all"):
        current_battery_name = "R"
        current_results = []
        all_results.append(run_r_battery(cfg, args.target, task_filter=args.task, on_task_done=on_task_done, sampler_override=sampler_override))
        current_battery_name = None
        current_results = []
        flush_progress()
    if args.battery in ("c", "all"):
        current_battery_name = "C"
        current_results = []
        all_results.append(run_c_battery(cfg, args.target, skip_c8=args.skip_c8, on_task_done=on_task_done, sampler_override=sampler_override))
        current_battery_name = None
        current_results = []
        flush_progress()

    # Final output JSON — overwrite in-progress with clean complete file.
    # (out_dir / out_path already set above before flush_progress.)
    with open(out_path, "w") as f:
        json.dump({
            "target": args.target,
            "model": cfg["model"],
            "endpoint": BASE_URL,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "sampler_override": sampler_override,
            # Durable pointer to untruncated responses (see archive_response).
            # Must stay in sync with flush_progress's payload — the final write
            # overwrites the in-progress file, so omitting it here would null out
            # the pointer in exactly the artifact that outlives the run.
            "archive_root": str(ARCHIVE_ROOT),
            "archive_run": f"{args.target}/{_ARCHIVE_RUN_ID}",
            "batteries": all_results,
        }, f, indent=2)
    print(f"\nResults saved: {out_path}")


def _build_partial_battery(results, target_key, cfg, battery_name):
    """Compute running score/wall_s for an in-progress battery so the flushed
    JSON is useful for live monitoring, not just a results list."""
    score = sum(int(r.get("score", 0) or 0) for r in results)
    possible = sum(int(r.get("max", 1) or 1) for r in results)
    wall = sum(float(r.get("elapsed", 0) or 0) for r in results)
    pct = 100 * score / possible if possible else 0
    return {
        "battery": battery_name,
        "target": target_key,
        "model": cfg["model"],
        "score": f"{score}/{possible}",
        "pct": pct,
        "wall_s": wall,
        "_partial": True,
        "results": results,
    }


if __name__ == "__main__":
    main()
