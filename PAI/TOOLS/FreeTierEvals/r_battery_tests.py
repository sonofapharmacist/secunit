#!/usr/bin/env python3
"""
R1-R6 (17-pt reasoning battery) prompts + scorers, copied VERBATIM from
deepseek_retest.py's TESTS array (lines 73-216 as of 2026-06-16).

This is a pure-data module (no execution at import, no __main__ block) — deliberately
separated from deepseek_retest.py because that file has no `if __name__ == "__main__"`
guard and fires a live API sweep as an import side effect. Import THIS module instead
whenever another script (e.g. kimi_k3_or_bench.py) needs the R-battery prompts/scorers
without inheriting that risk.

Do not add a __main__ block here. Do not add module-level network calls here.
"""
import json, re


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


TESTS = [
    {
        "id": "R1",
        "label": "Logic (knights/knaves)",
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
            else 1 if any(x in r.lower() for x in ["a=knight", "a is a knight", "a is knight"])
            else 0
        ),
        "max_score": 2,
    },
    {
        "id": "R2",
        "label": "STRIDE → JSON",
        "prompt": """You are a security engineer. Analyze this system and produce a STRIDE threat model.

System: REST API (Node.js), JWT auth (HS256, secret in env var), user file uploads stored in S3 with user-controlled filenames, admin panel at /admin protected only by a role field in the JWT payload, no input sanitization on search endpoint.

Return a JSON array of exactly 5 threats. Each object must have: "stride_category", "component", "attack_vector", "impact". No markdown fences, just the raw JSON array.""",
        "max_tokens": 1600,
        "scorer": _score_stride,
        "max_score": 5,
    },
    {
        "id": "R3",
        "label": "Flask vulns",
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
            1 if any(x in r.lower() for x in ["sql inject", "sqli", "f-string", "f\"select", "format sql"]) else 0,
            1 if any(x in r.lower() for x in ["path travers", "directory travers", "../", "arbitrary file", "lfi"]) else 0,
            1 if any(x in r.lower() for x in ["no auth", "missing auth", "unauthenticat", "no check", "anyone can", "unprotect"]) else 0,
        ]),
        "max_score": 3,
    },
    {
        "id": "R4",
        "label": "Logic grid",
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
        "id": "R5",
        "label": "Rate limiter bugs",
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
            1 if any(x in r.lower() for x in ["off-by-one", "off by one", "11 request", "allows 11", "limit + 1", "exceeds limit", "one extra", "11 calls"]) else 0,
            1 if any(x in r.lower() for x in ["memory leak", "unbounded", "never clean", "never delet", "grow indefin", "accumulate", "no cleanup", "stale entry", "not removed", "no reset", "window reset", "not reset", "window expir"]) else 0,
        ]),
        "max_score": 2,
    },
    {
        "id": "R6",
        "label": "Redis vs DynamoDB",
        "prompt": """We need to store 10 million active user sessions (each ~2KB). Compare Redis Cluster vs DynamoDB on these axes: (1) cost at 10M sessions, (2) latency p99, (3) operational burden, (4) TTL/expiry handling. Then give a clear recommendation with your primary reason.

Be concise — max 300 words.""",
        "max_tokens": 1000,
        "scorer": lambda r: sum([
            1 if sum(1 for kw in ["cost", "latency", "p99", "operation", "burden", "ttl", "expir"] if kw in r.lower()) >= 3 else 0,
            1 if (any(x in r.lower() for x in ["recommend", "prefer", "choose", "go with", "suggest", "dynamo", "redis"]) and
                  any(x in r.lower() for x in ["because", "reason", "due to", "given", "since", "lower cost", "simpler"])) else 0,
        ]),
        "max_score": 2,
    },
]
