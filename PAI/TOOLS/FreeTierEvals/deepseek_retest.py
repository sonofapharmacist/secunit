#!/usr/bin/env python3
"""
DeepSeek-V4-Flash retest — R1-R6 only (skip G8).
Goal: isolate true per-task latency without long-JSON generation inflating wall time.
Cross-ref: nim_eval.py run 2026-06-11 showed 33/34 in 574s (G8 suspected culprit).
Runs both NIM direct (short timeout, fail-fast) and OpenRouter for comparison.
"""
import os, json, time, urllib.request, urllib.error, re, subprocess, sys

def _get_key(env_var, passage_path):
    key = os.environ.get(env_var, "")
    if key:
        return key
    try:
        result = subprocess.run(["passage", "show", passage_path],
                                capture_output=True, text=True, timeout=5)
        return result.stdout.strip().splitlines()[0].strip()
    except Exception:
        return ""

NIM_KEY = _get_key("NVIDIA_API_KEY", "api/nvidia")
OR_KEY  = _get_key("OPENROUTER_API_KEY", "api/openrouter")

NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
OR_URL  = "https://openrouter.ai/api/v1/chat/completions"

NIM_MODEL = "deepseek-ai/deepseek-v4-flash"
OR_MODEL  = "deepseek/deepseek-v4-flash"

ENDPOINTS = []
if NIM_KEY:
    ENDPOINTS.append(("NIM", NIM_URL, NIM_MODEL, NIM_KEY, 30))   # 30s timeout — fail fast
if OR_KEY:
    ENDPOINTS.append(("OR",  OR_URL,  OR_MODEL,  OR_KEY, 120))   # 120s timeout

if not ENDPOINTS:
    print("ERROR: no NIM or OpenRouter key found")
    sys.exit(1)

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
            else 1 if any(x in r.lower() for x in ["a=knight","a is a knight","a is knight"])
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
            1 if any(x in r.lower() for x in ["sql inject","sqli","f-string","f\"select","format sql"]) else 0,
            1 if any(x in r.lower() for x in ["path travers","directory travers","../","arbitrary file","lfi"]) else 0,
            1 if any(x in r.lower() for x in ["no auth","missing auth","unauthenticat","no check","anyone can","unprotect"]) else 0,
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
            1 if any(x in r.lower() for x in ["off-by-one","off by one","11 request","allows 11","limit + 1","exceeds limit","one extra","11 calls"]) else 0,
            1 if any(x in r.lower() for x in ["memory leak","unbounded","never clean","never delet","grow indefin","accumulate","no cleanup","stale entry","not removed","no reset","window reset","not reset","window expir"]) else 0,
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
            1 if sum(1 for kw in ["cost","latency","p99","operation","burden","ttl","expir"] if kw in r.lower()) >= 3 else 0,
            1 if (any(x in r.lower() for x in ["recommend","prefer","choose","go with","suggest","dynamo","redis"]) and
                  any(x in r.lower() for x in ["because","reason","due to","given","since","lower cost","simpler"])) else 0,
        ]),
        "max_score": 2,
    },
]

MAX_SCORE = sum(t["max_score"] for t in TESTS)

def call(prompt, max_tokens, url, model_id, api_key, timeout_s):
    payload = {
        "model": model_id,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0.2,
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
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
        body = e.read().decode()[:120]
        return None, time.time()-t0, f"HTTP{e.code}:{body}"
    except Exception as e:
        return None, time.time()-t0, f"EXC:{str(e)[:80]}"

if __name__ == "__main__":
    print(f"\nDeepSeek-V4-Flash retest — R1-R6 only (max {MAX_SCORE} pts)")
    print(f"Prior full run (NIM): 33/34 (97%) in 574s — G8 (long JSON) suspected latency driver")
    print(f"NIM retest 2026-06-12: all 6 tasks timed out at 180s — endpoint unavailable")
    print(f"This run: NIM (30s fail-fast) + OpenRouter (120s) for comparison\n")

    all_endpoint_results = {}

    for ep_name, ep_url, ep_model, ep_key, ep_timeout in ENDPOINTS:
        print(f"── {ep_name} ({ep_model}, timeout={ep_timeout}s) ──")
        print(f"{'Task':<22}  {'Score':>7}  {'Latency':>8}")
        print("─" * 50)

        total_score = 0
        total_time = 0.0
        task_latencies = []

        for t in TESTS:
            response, elapsed, err = call(t["prompt"], t["max_tokens"],
                                          ep_url, ep_model, ep_key, ep_timeout)
            total_time += elapsed
            task_latencies.append(elapsed)

            if err or response is None:
                print(f"{t['id']} {t['label']:<18}  {'ERR':>7}  {elapsed:>7.1f}s  {(err or 'null')[:50]}")
            else:
                sc = t["scorer"](response)
                total_score += sc
                flag = " ✗" if sc < t["max_score"] else ""
                print(f"{t['id']} {t['label']:<18}  {sc}/{t['max_score']:>5}  {elapsed:>7.1f}s{flag}")
                if sc < t["max_score"]:
                    preview = response[:200].replace('\n', ' ')
                    print(f"    RESPONSE: {preview}")

            time.sleep(2)

        print("─" * 50)
        avg_lat = total_time / len(TESTS)
        pct = f"{100*total_score//MAX_SCORE}%" if total_score > 0 else "0%"
        print(f"Result: {total_score}/{MAX_SCORE} ({pct})  |  Wall: {total_time:.1f}s  |  Avg/task: {avg_lat:.1f}s")
        print(f"Per-task latencies: {[f'{x:.1f}s' for x in task_latencies]}\n")
        all_endpoint_results[ep_name] = {"score": total_score, "wall": total_time, "avg": avg_lat}
        time.sleep(4)

    if len(all_endpoint_results) > 1:
        print("── Summary ──")
        for ep, r in all_endpoint_results.items():
            print(f"  {ep:<5}  {r['score']}/{MAX_SCORE}  wall={r['wall']:.1f}s  avg={r['avg']:.1f}s/task")
