#!/usr/bin/env python3
import os, json, time, urllib.request, urllib.error, re

MISTRAL_KEY = os.environ.get("MISTRAL_API_KEY", "")
OR_KEY = os.environ.get("OPENROUTER_API_KEY", "")

MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions"
OR_URL = "https://openrouter.ai/api/v1/chat/completions"

MODELS = [
    # (id, label, backend, supports_thinking)
    ("nvidia/nemotron-3-super-120b-a12b:free",       "Nemotron-120B",     "or",      True),
    ("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "Nemotron-30B-R",  "or",  True),
    ("magistral-small-latest",                        "Magistral-S",       "mistral", True),
    ("magistral-medium-latest",                       "Magistral-M",       "mistral", True),
    ("openai/gpt-oss-120b:free",                      "GPT-OSS-120B",      "or",      False),
]

# ── Test suite ─────────────────────────────────────────────────────────────────

TESTS = [

{
"id": "R1",
"label": "Multi-step logic (knights/knaves)",
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
"notes": "Correct: A=knight, B=knave, C=knave",
},

{
"id": "R2",
"label": "STRIDE threat model → JSON",
"prompt": """You are a security engineer. Analyze this system and produce a STRIDE threat model.

System: REST API (Node.js), JWT auth (HS256, secret in env var), user file uploads stored in S3 with user-controlled filenames, admin panel at /admin protected only by a role field in the JWT payload, no input sanitization on search endpoint.

Return a JSON array of exactly 5 threats. Each object must have: "stride_category", "component", "attack_vector", "impact". No markdown fences, just the raw JSON array.""",
"max_tokens": 1600,
"scorer": lambda r: _score_stride(r),
"max_score": 5,
"notes": "5pts: ≥4 valid STRIDE threats + parseable JSON",
},

{
"id": "R3",
"label": "Vuln spot in code",
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
"scorer": lambda r: _score_vulns(r),
"max_score": 3,
"notes": "3pts: SQLi(1) + path traversal(1) + missing auth on admin(1)",
},

{
"id": "R4",
"label": "Multi-hop logic grid",
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
"scorer": lambda r: _score_grid(r),
"max_score": 3,
"notes": "Correct: Alice=designer+cat, Bob=engineer+fish, Carol=manager+dog",
},

{
"id": "R5",
"label": "Code edge-case reasoning",
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
"scorer": lambda r: _score_ratelimiter(r),
"max_score": 2,
"notes": "2pts: off-by-one at limit(1) + no reset after window expiry / memory leak(1)",
},

{
"id": "R6",
"label": "Architecture decision",
"prompt": """We need to store 10 million active user sessions (each ~2KB). Compare Redis Cluster vs DynamoDB on these axes: (1) cost at 10M sessions, (2) latency p99, (3) operational burden, (4) TTL/expiry handling. Then give a clear recommendation with your primary reason.

Be concise — max 300 words.""",
"max_tokens": 1000,
"scorer": lambda r: _score_arch(r),
"max_score": 2,
"notes": "2pts: covers ≥3 axes(1) + clear recommendation with reasoning(1)",
},

]

# ── Scorers ────────────────────────────────────────────────────────────────────

def _extract_answer(text):
    """Pull content after </think> or <answer> if present, else use full text."""
    for tag in ["</think>", "</thinking>", "<answer>", "## Answer", "**Answer"]:
        idx = text.lower().rfind(tag.lower())
        if idx != -1:
            return text[idx + len(tag):]
    return text

def _score_stride(raw):
    answer = _extract_answer(raw)
    # Strip markdown fences if present
    answer = re.sub(r'```[a-z]*\n?', '', answer).strip()
    try:
        data = json.loads(answer)
        if not isinstance(data, list):
            data = json.loads(re.search(r'\[.*\]', answer, re.DOTALL).group())
    except:
        # Try to find JSON array anywhere in response
        m = re.search(r'\[.*?\]', raw, re.DOTALL)
        if not m:
            return 0
        try:
            data = json.loads(m.group())
        except:
            return 0
    
    stride_cats = {"spoofing","tampering","repudiation","information disclosure","denial","elevation","dos","s","t","r","i","d","e"}
    valid = 0
    for item in data[:5]:
        if not isinstance(item, dict): continue
        cat = str(item.get("stride_category","")).lower()
        vec = str(item.get("attack_vector",""))
        if any(s in cat for s in stride_cats) and len(vec) > 10:
            valid += 1
    return min(valid, 5)

def _score_vulns(raw):
    r = raw.lower()
    score = 0
    if any(x in r for x in ["sql inject","sqli","f-string","string format","f\"select","format sql"]):
        score += 1
    if any(x in r for x in ["path travers","directory travers","../","escape","arbitrary file","lfi"]):
        score += 1
    if any(x in r for x in ["no auth","missing auth","unauthenticat","no check","anyone can","no verif","unprotect"]):
        score += 1
    return score

def _score_grid(raw):
    r = _extract_answer(raw).lower()
    score = 0
    if ("alice" in r and "designer" in r) or ("alice" in r and "cat" in r): score += 1
    if ("bob" in r and "engineer" in r) or ("bob" in r and "fish" in r): score += 1
    if ("carol" in r and "manager" in r): score += 1
    return score

def _score_ratelimiter(raw):
    r = raw.lower()
    score = 0
    if any(x in r for x in ["off-by-one","off by one","11 request","allows 11","limit + 1","exceeds limit","one extra","11 calls"]):
        score += 1
    if any(x in r for x in ["memory leak","unbounded","never clean","never delet","grow indefin","accumulate","no cleanup","stale entry","old user","not removed"]):
        score += 1
    elif any(x in r for x in ["no reset","window reset","reset count","previous window","not reset","window expir"]):
        score += 1  # catching the window-doesn't-reset-count issue
    return score

def _score_arch(raw):
    r = raw.lower()
    score = 0
    axes_hit = sum(1 for kw in ["cost","latency","p99","operation","burden","ttl","expir"] if kw in r)
    if axes_hit >= 3: score += 1
    has_rec = any(x in r for x in ["recommend","prefer","choose","go with","suggest","dynamo","redis"])
    has_reason = any(x in r for x in ["because","reason","due to","given","since","as it","lower cost","simpler","easier"])
    if has_rec and has_reason: score += 1
    return score

# ── API caller ─────────────────────────────────────────────────────────────────

def call(model_id, backend, prompt, max_tokens, supports_thinking):
    if backend == "mistral":
        url, key = MISTRAL_URL, MISTRAL_KEY
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        payload = {"model": model_id, "messages": [{"role":"user","content": prompt}],
                   "max_tokens": max_tokens, "temperature": 0.2}
    else:
        url, key = OR_URL, OR_KEY
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                   "HTTP-Referer": "https://pai.local"}
        payload = {"model": model_id, "messages": [{"role":"user","content": prompt}],
                   "max_tokens": max_tokens, "temperature": 0.2}
        if supports_thinking:
            payload["include_reasoning"] = True

    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers=headers)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.load(resp)
            elapsed = time.time() - t0
            err = result.get("error")
            if err: return None, elapsed, f"ERR:{str(err)[:100]}"
            choices = result.get("choices", [])
            if not choices: return None, elapsed, "NO_CHOICES"
            msg = choices[0].get("message", {})
            raw_content = msg.get("content") or ""
            # Mistral thinking models return content as a list of blocks
            if isinstance(raw_content, list):
                content = " ".join(
                    p.get("text", "") for p in raw_content
                    if isinstance(p, dict) and p.get("type") == "text"
                )
            else:
                content = raw_content
            reasoning = msg.get("reasoning") or ""
            full = (reasoning + "\n" + content).strip() if reasoning else content
            return full, elapsed, None
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:120]
        return None, time.time()-t0, f"HTTP{e.code}:{body}"
    except Exception as e:
        return None, time.time()-t0, f"EXC:{str(e)[:80]}"

# ── Runner ─────────────────────────────────────────────────────────────────────

print(f"\n{'':22}" + "".join(f" {t['id']:>5}" for t in TESTS) + f"  {'TOT':>5}  {'TIME':>6}")
print("─" * 72)

all_results = {}

for model_id, label, backend, supports_thinking in MODELS:
    scores = []
    times = []
    errors = []
    raw_responses = {}

    for t in TESTS:
        response, elapsed, err = call(model_id, backend, t["prompt"], t["max_tokens"], supports_thinking)
        times.append(elapsed)

        if err or response is None:
            scores.append(None)
            errors.append(f"{t['id']}:{(err or 'null')[:40]}")
        else:
            sc = t["scorer"](response)
            scores.append(sc)
            raw_responses[t["id"]] = response

        time.sleep(3)

    valid = [(s, t["max_score"]) for s, t in zip(scores, TESTS) if s is not None]
    got = sum(s for s, _ in valid)
    possible = sum(m for _, m in valid)
    total_time = sum(t for t in times if t > 0)

    def fmt(s, mx):
        if s is None: return "    ?"
        return f" {s}/{mx}"

    row = f"{label:<22}" + "".join(fmt(s, t["max_score"]) for s, t in zip(scores, TESTS))
    row += f"  {got}/{possible:>2}  {total_time:>5.1f}s"
    if errors: row += f"  [{errors[0][:35]}]"
    print(row)

    all_results[label] = {"scores": scores, "raw": raw_responses, "errors": errors}
    time.sleep(5)

# ── Spot-check raw answers ─────────────────────────────────────────────────────
print("\n\n═══ Spot-check: R1 (logic) and R3 (vulns) raw answers ═══")
for label, data in all_results.items():
    for tid in ["R1", "R3"]:
        raw = data["raw"].get(tid, "[no response]")
        answer_section = _extract_answer(raw)[-400:]
        print(f"\n{label} — {tid}:\n{answer_section.strip()}\n{'─'*60}")

