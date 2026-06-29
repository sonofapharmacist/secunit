#!/usr/bin/env python3
"""
Nous Research free tier eval — R1-R6 suite.
Models: Hermes-4.3-36B, Hermes-4-70B, Hermes-4-405B, Nemotron-Ultra:free (promo expires 2026-06-18)
Endpoint: inference-api.nousresearch.com/v1 (OpenAI-compat)
Key: passage show api/nous
"""
import os, json, time, urllib.request, urllib.error, re, subprocess, sys

def get_key(env_var, passage_path):
    key = os.environ.get(env_var, "")
    if key:
        return key
    try:
        result = subprocess.run(["passage", "show", passage_path],
                                capture_output=True, text=True, timeout=5)
        return result.stdout.strip().splitlines()[0].strip()
    except Exception:
        return ""

NOUS_KEY = get_key("NOUS_API_KEY", "api/nous")
NOUS_URL = "https://inference-api.nousresearch.com/v1/chat/completions"

if not NOUS_KEY:
    print("ERROR: no NOUS_API_KEY and passage lookup failed")
    sys.exit(1)

# (model_id, label, use_reasoning_sysprompt, notes)
MODELS = [
    ("Hermes-4.3-36B",             "Hermes-4.3-36B",    False, "free tier, 128k ctx"),
    ("Hermes-4-70B",               "Hermes-4-70B",      False, "free tier, 128k ctx"),
    ("Hermes-4-405B",              "Hermes-4-405B",      False, "free tier, 128k ctx"),
    ("nvidia/nemotron-3-ultra:free","Nemotron-Ultra:free",False, "promo expires 2026-06-18"),
]

REASONING_SYSPROMPT = (
    "You are a deep thinking AI, you may use extremely long chains of thought "
    "to deeply consider the problem and deliberate with yourself via systematic "
    "reasoning before providing a final answer. Always put your thinking between "
    "<think> and </think> tags, then give your final answer."
)

# ── Scorers ────────────────────────────────────────────────────────────────────

def _extract_answer(text):
    for tag in ["</think>", "</thinking>", "<answer>", "## Answer", "**Answer"]:
        idx = text.lower().rfind(tag.lower())
        if idx != -1:
            return text[idx + len(tag):]
    return text

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

TESTS = [
    {
        "id": "R1", "label": "Logic (knights/knaves)",
        "prompt": """Solve this logic puzzle. A, B, and C are each either a knight (always tells truth) or a knave (always lies).
A says: "B is a knave."
B says: "A and C are the same type."
C says: "B is a knight."

Who is a knight and who is a knave? Show your reasoning, then give a final answer as: A=knight/knave, B=knight/knave, C=knight/knave.""",
        "max_tokens": 900,
        "scorer": lambda r: (
            2 if ("a=knight" in r.lower() or "a is a knight" in r.lower()) and
                 ("b=knave" in r.lower() or "b is a knave" in r.lower()) and
                 ("c=knave" in r.lower() or "c is a knave" in r.lower())
            else 1 if any(x in r.lower() for x in ["a=knight","a is a knight","a is knight"])
            else 0
        ),
        "max_score": 2,
    },
    {
        "id": "R2", "label": "STRIDE → JSON",
        "prompt": """You are a security engineer. Analyze this system and produce a STRIDE threat model.

System: REST API (Node.js), JWT auth (HS256, secret in env var), user file uploads stored in S3 with user-controlled filenames, admin panel at /admin protected only by a role field in the JWT payload, no input sanitization on search endpoint.

Return a JSON array of exactly 5 threats. Each object must have: "stride_category", "component", "attack_vector", "impact". No markdown fences, just the raw JSON array.""",
        "max_tokens": 1600,
        "scorer": _score_stride,
        "max_score": 5,
    },
    {
        "id": "R3", "label": "Flask vulns",
        "prompt": """Find every security vulnerability in this Python Flask code. Be specific about what's wrong and why.

```python
from flask import Flask, request, jsonify
import sqlite3

app = Flask(__name__)

@app.route('/user')
def get_user():
    user_id = request.args.get('id')
    conn = sqlite3.connect('users.db')
    cur = conn.cursor()
    cur.execute(f"SELECT * FROM users WHERE id = {user_id}")
    row = cur.fetchone()
    return jsonify(row)

@app.route('/file')
def get_file():
    filename = request.args.get('name')
    path = f"/var/data/{filename}"
    with open(path) as f:
        return f.read()

@app.route('/admin/delete', methods=['POST'])
def delete_user():
    uid = request.json.get('uid')
    conn = sqlite3.connect('users.db')
    cur = conn.cursor()
    cur.execute(f"DELETE FROM users WHERE id = {uid}")
    conn.commit()
    return 'deleted'
```""",
        "max_tokens": 700,
        "scorer": lambda r: sum([
            1 if any(x in r.lower() for x in ["sql inject","sqli","f-string","f\"select","format sql"]) else 0,
            1 if any(x in r.lower() for x in ["path travers","directory travers","../","arbitrary file","lfi"]) else 0,
            1 if any(x in r.lower() for x in ["no auth","missing auth","unauthenticat","no check","anyone can","unprotect"]) else 0,
        ]),
        "max_score": 3,
    },
    {
        "id": "R4", "label": "Logic grid",
        "prompt": """Solve this logic puzzle completely.

Three people — Alice, Bob, Carol — each have a different job (engineer, designer, manager) and a different pet (cat, dog, fish).

Clues:
1. The engineer does not have a cat.
2. Bob is not the manager.
3. Carol has a dog.
4. The designer has a cat.
5. Alice is not the engineer.

State each person's job and pet. Show your reasoning.""",
        "max_tokens": 1200,
        "scorer": lambda r: sum([
            1 if ("alice" in r.lower() and ("designer" in r.lower() or "cat" in r.lower())) else 0,
            1 if ("bob" in r.lower() and ("engineer" in r.lower() or "fish" in r.lower())) else 0,
            1 if ("carol" in r.lower() and "manager" in r.lower()) else 0,
        ]),
        "max_score": 3,
    },
    {
        "id": "R5", "label": "Rate limiter bugs",
        "prompt": """Review this TypeScript rate limiter. What bugs or edge cases does it have? Be specific.

```typescript
const counts: Record<string, number> = {};
const windows: Record<string, number> = {};

export function rateLimit(userId: string, limit: number = 10): boolean {
  const now = Date.now();
  const windowMs = 60_000;

  if (!windows[userId] || now - windows[userId] > windowMs) {
    windows[userId] = now;
    counts[userId] = 1;
    return true;
  }

  counts[userId]++;
  return counts[userId] <= limit;
}
```""",
        "max_tokens": 900,
        "scorer": lambda r: sum([
            1 if any(x in r.lower() for x in ["off-by-one","off by one","11 request","allows 11","limit + 1","exceeds limit","one extra","11 calls"]) else 0,
            1 if any(x in r.lower() for x in ["memory leak","unbounded","never clean","never delet","grow indefin","accumulate","no cleanup","stale entry","not removed","no reset","window reset","not reset","window expir"]) else 0,
        ]),
        "max_score": 2,
    },
    {
        "id": "R6", "label": "Redis vs DynamoDB",
        "prompt": """We need to store 10 million active user sessions (each ~2KB). Compare Redis Cluster vs DynamoDB on these axes: (1) cost at 10M sessions, (2) latency p99, (3) operational burden, (4) TTL/expiry handling. Then give a clear recommendation with your primary reason.

Be concise — max 300 words.""",
        "max_tokens": 1000,
        "scorer": lambda r: sum([
            1 if sum(1 for kw in ["cost","latency","p99","operation","burden","ttl","expir"] if kw in r.lower()) >= 3 else 0,
            1 if (any(x in r.lower() for x in ["recommend","prefer","choose","go with","suggest","dynamo","redis"]) and
                  any(x in r.lower() for x in ["because","reason","due to","given","since","lower cost","simpler"])) else 0,
        ]),
        "max_score": 2,
    },
]

MAX_SCORE = sum(t["max_score"] for t in TESTS)

# ── API caller ─────────────────────────────────────────────────────────────────

def call(model_id, prompt, max_tokens, use_reasoning):
    messages = [{"role": "user", "content": prompt}]
    payload = {
        "model": model_id,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.2,
    }
    if use_reasoning:
        payload["system"] = REASONING_SYSPROMPT

    data = json.dumps(payload).encode()
    req = urllib.request.Request(NOUS_URL, data=data, headers={
        "Authorization": f"Bearer {NOUS_KEY}",
        "Content-Type": "application/json",
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.load(resp)
            elapsed = time.time() - t0
            err = result.get("error")
            if err:
                return None, elapsed, f"ERR:{str(err)[:100]}"
            choices = result.get("choices", [])
            if not choices:
                return None, elapsed, "NO_CHOICES"
            content = choices[0].get("message", {}).get("content") or ""
            if isinstance(content, list):
                content = " ".join(p.get("text","") for p in content
                                   if isinstance(p,dict) and p.get("type")=="text")
            return content, elapsed, None
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:200]
        return None, time.time()-t0, f"HTTP{e.code}:{body}"
    except Exception as e:
        return None, time.time()-t0, f"EXC:{str(e)[:80]}"

# ── Runner ─────────────────────────────────────────────────────────────────────

print(f"\nNous Research free tier eval — {len(MODELS)} models × {len(TESTS)} tasks (max {MAX_SCORE} pts)")
print(f"Endpoint: {NOUS_URL}")
print(f"Free tier limits: 45 RPM / 450K TPM\n")

header = f"{'Model':<22}" + "".join(f" {t['id']:>5}" for t in TESTS) + f"  {'TOT':>8}  {'TIME':>7}  Notes"
print(header)
print("─" * 85)

for model_id, label, use_reasoning, notes in MODELS:
    scores = []
    times  = []
    errors = []

    for t in TESTS:
        response, elapsed, err = call(model_id, t["prompt"], t["max_tokens"], use_reasoning)
        times.append(elapsed)

        if err or response is None:
            scores.append(None)
            errors.append(f"{t['id']}:{(err or 'null')[:50]}")
            print(f"  [{label}/{t['id']}] {err or 'null response'}", flush=True)
        else:
            sc = t["scorer"](response)
            scores.append(sc)
            if sc < t["max_score"]:
                preview = _extract_answer(response)[:180].replace('\n', ' ')
                print(f"  [{label}/{t['id']}] ✗ {sc}/{t['max_score']} — {preview}", flush=True)

        time.sleep(2)

    valid    = [(s, t["max_score"]) for s, t in zip(scores, TESTS) if s is not None]
    got      = sum(s for s, _ in valid)
    possible = sum(m for _, m in valid)
    pct      = f"{100*got//possible}%" if possible else "—"
    wall     = sum(times)
    avg      = wall / len(times)

    def fmt(s, mx):
        if s is None: return "    ?"
        if mx == 1:   return "   ✓" if s else "   ✗"
        return f" {s}/{mx}"

    row = f"{label:<22}" + "".join(fmt(s, t["max_score"]) for s, t in zip(scores, TESTS))
    row += f"  {got}/{possible}({pct})  {wall:>6.1f}s  {notes}"
    if errors:
        row += f"  [{errors[0][:40]}]"
    print(row, flush=True)
    time.sleep(4)

print("─" * 85)
print(f"\nReference scores (same tasks):")
print(f"  GPT-OSS-120B    17/17 (100%) — NIM direct, 102s")
print(f"  DeepSeek-V4-Flash 15/17 (88%) — OR, 119s")
print(f"  Mistral-Small4  15/17 (88%) — NIM, 35s")
