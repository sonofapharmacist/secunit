#!/usr/bin/env python3
"""
NIM retest — Step-3.7-Flash (8K token fix) + Llama4-Maverick (G8 latency isolation).
R1-R6 only. Prior: Step returned empty at 2K; Maverick 94% in 209s (G8 suspected).
"""
import os, json, time, urllib.request, urllib.error, re, subprocess, sys

def get_nim_key():
    key = os.environ.get("NVIDIA_API_KEY", "")
    if key: return key
    try:
        r = subprocess.run(["passage", "show", "api/nvidia"], capture_output=True, text=True, timeout=5)
        return r.stdout.strip().splitlines()[0].strip()
    except Exception: return ""

NIM_KEY = get_nim_key()
NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
if not NIM_KEY:
    print("ERROR: no NIM key"); sys.exit(1)

# (model_id, label, is_reasoning, max_tokens_override, prior)
MODELS = [
    ("stepfun-ai/step-3.7-flash",                  "Step-3.7-Flash",     True,  8192, "empty at 2K — 8K fix"),
    ("meta/llama-4-maverick-17b-128e-instruct",    "Llama4-Maverick",    False, None, "94%/209s — G8 artifact?"),
]

def _extract(text):
    for tag in ["</think>","</thinking>","<answer>","## Answer","**Answer"]:
        idx = text.lower().rfind(tag.lower())
        if idx != -1: return text[idx+len(tag):]
    return text

def _score_stride(raw):
    ans = re.sub(r'```[a-z]*\n?','',_extract(raw)).strip()
    try:
        data = json.loads(ans)
        if not isinstance(data, list): data = json.loads(re.search(r'\[.*\]',ans,re.DOTALL).group())
    except Exception:
        m = re.search(r'\[.*?\]',raw,re.DOTALL)
        if not m: return 0
        try: data = json.loads(m.group())
        except Exception: return 0
    cats = {"spoofing","tampering","repudiation","information disclosure","denial","elevation","dos","s","t","r","i","d","e"}
    return min(sum(1 for x in data[:5] if isinstance(x,dict) and any(s in str(x.get("stride_category","")).lower() for s in cats) and len(str(x.get("attack_vector","")))>10), 5)

TESTS = [
    {"id":"R1","label":"Logic (knights/knaves)","max_tokens":900,"max_score":2,
     "prompt":"""Solve this logic puzzle. A, B, and C are each either a knight (always tells truth) or a knave (always lies).
A says: "B is a knave." B says: "A and C are the same type." C says: "B is a knight."
Who is a knight and who is a knave? Show reasoning, then: A=knight/knave, B=knight/knave, C=knight/knave.""",
     "scorer": lambda r: 2 if all(x in r.lower() for x in ["a=knight","b=knave","c=knave"]) or
                               all(x in r.lower() for x in ["a is a knight","b is a knave","c is a knave"])
                          else 1 if any(x in r.lower() for x in ["a=knight","a is a knight"]) else 0},
    {"id":"R2","label":"STRIDE → JSON","max_tokens":1600,"max_score":5,
     "prompt":"""You are a security engineer. STRIDE threat model this system:
REST API (Node.js), JWT auth (HS256, secret in env var), user file uploads in S3 with user-controlled filenames, admin panel at /admin protected only by role field in JWT, no input sanitization on search endpoint.
Return a JSON array of exactly 5 threats: "stride_category", "component", "attack_vector", "impact". No markdown fences.""",
     "scorer": _score_stride},
    {"id":"R3","label":"Flask vulns","max_tokens":700,"max_score":3,
     "prompt":"""Find every security vulnerability in this Flask code:
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
    return jsonify(cur.fetchone())
@app.route('/file')
def get_file():
    filename = request.args.get('name')
    with open(f"/var/data/{filename}") as f: return f.read()
@app.route('/admin/delete', methods=['POST'])
def delete_user():
    uid = request.json.get('uid')
    conn = sqlite3.connect('users.db')
    cur = conn.cursor()
    cur.execute(f"DELETE FROM users WHERE id = {uid}")
    conn.commit()
    return 'deleted'
```""",
     "scorer": lambda r: sum([
         1 if any(x in r.lower() for x in ["sql inject","sqli","f-string","format sql"]) else 0,
         1 if any(x in r.lower() for x in ["path travers","directory travers","../","arbitrary file","lfi"]) else 0,
         1 if any(x in r.lower() for x in ["no auth","missing auth","unauthenticat","no check","anyone can","unprotect"]) else 0])},
    {"id":"R4","label":"Logic grid","max_tokens":1200,"max_score":3,
     "prompt":"""Solve: Alice, Bob, Carol each have a job (engineer/designer/manager) and pet (cat/dog/fish).
Clues: 1) engineer has no cat. 2) Bob not manager. 3) Carol has dog. 4) designer has cat. 5) Alice not engineer.
State each person's job and pet.""",
     "scorer": lambda r: sum([
         1 if "alice" in r.lower() and ("designer" in r.lower() or "cat" in r.lower()) else 0,
         1 if "bob" in r.lower() and ("engineer" in r.lower() or "fish" in r.lower()) else 0,
         1 if "carol" in r.lower() and "manager" in r.lower() else 0])},
    {"id":"R5","label":"Rate limiter bugs","max_tokens":900,"max_score":2,
     "prompt":"""What bugs does this TypeScript rate limiter have?
```typescript
const counts: Record<string, number> = {};
const windows: Record<string, number> = {};
export function rateLimit(userId: string, limit: number = 10): boolean {
  const now = Date.now(); const windowMs = 60_000;
  if (!windows[userId] || now - windows[userId] > windowMs) {
    windows[userId] = now; counts[userId] = 1; return true;
  }
  counts[userId]++;
  return counts[userId] <= limit;
}
```""",
     "scorer": lambda r: sum([
         1 if any(x in r.lower() for x in ["off-by-one","off by one","11 request","allows 11","limit + 1","exceeds limit","one extra"]) else 0,
         1 if any(x in r.lower() for x in ["memory leak","unbounded","never clean","never delet","grow indefin","accumulate","no cleanup","stale entry"]) else 0])},
    {"id":"R6","label":"Redis vs DynamoDB","max_tokens":1000,"max_score":2,
     "prompt":"""10M active sessions ~2KB each. Compare Redis Cluster vs DynamoDB: cost, latency p99, operational burden, TTL handling. Clear recommendation with primary reason. Max 300 words.""",
     "scorer": lambda r: sum([
         1 if sum(1 for kw in ["cost","latency","p99","operation","burden","ttl","expir"] if kw in r.lower()) >= 3 else 0,
         1 if any(x in r.lower() for x in ["recommend","prefer","choose","go with","suggest"]) and
              any(x in r.lower() for x in ["because","reason","due to","given","since","lower cost","simpler"]) else 0])},
]

MAX_SCORE = sum(t["max_score"] for t in TESTS)

def call(model_id, prompt, max_tokens, is_reasoning):
    effective = max(max_tokens, 8192) if is_reasoning else max_tokens
    payload = {"model": model_id, "messages": [{"role":"user","content":prompt}],
               "max_tokens": effective, "temperature": 1 if is_reasoning else 0.2}
    data = json.dumps(payload).encode()
    req = urllib.request.Request(NIM_URL, data=data, headers={
        "Authorization": f"Bearer {NIM_KEY}", "Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.load(resp); elapsed = time.time()-t0
            if result.get("error"): return None, elapsed, f"ERR:{str(result['error'])[:80]}"
            choices = result.get("choices",[])
            if not choices: return None, elapsed, "NO_CHOICES"
            content = choices[0].get("message",{}).get("content") or ""
            return content, elapsed, None
    except urllib.error.HTTPError as e:
        return None, time.time()-t0, f"HTTP{e.code}:{e.read().decode()[:80]}"
    except Exception as e:
        return None, time.time()-t0, f"EXC:{str(e)[:60]}"

print(f"\nNIM retest — Step-3.7-Flash (8K fix) + Llama4-Maverick (skip G8) — max {MAX_SCORE} pts\n")
print(f"{'Model':<20}" + "".join(f" {t['id']:>5}" for t in TESTS) + f"  {'TOT':>8}  {'TIME':>7}  Prior")
print("─" * 75)

for model_id, label, is_reasoning, tok_override, prior in MODELS:
    scores, times = [], []
    for t in TESTS:
        max_tok = tok_override if tok_override else t["max_tokens"]
        response, elapsed, err = call(model_id, t["prompt"], max_tok, is_reasoning)
        times.append(elapsed)
        if err or response is None:
            scores.append(None)
            print(f"  [{label}/{t['id']}] {err or 'null'}", flush=True)
        else:
            sc = t["scorer"](response)
            scores.append(sc)
            if sc < t["max_score"]:
                print(f"  [{label}/{t['id']}] ✗ {sc}/{t['max_score']} — {_extract(response)[:120].replace(chr(10),' ')}", flush=True)
        time.sleep(2)

    valid = [(s,t["max_score"]) for s,t in zip(scores,TESTS) if s is not None]
    got, possible = sum(s for s,_ in valid), sum(m for _,m in valid)
    wall = sum(times)
    def fmt(s,mx):
        if s is None: return "    ?"
        return "   ✓" if mx==1 and s else ("   ✗" if mx==1 else f" {s}/{mx}")
    row = f"{label:<20}" + "".join(fmt(s,t["max_score"]) for s,t in zip(scores,TESTS))
    row += f"  {got}/{possible}({100*got//possible if possible else 0}%)  {wall:>6.1f}s  {prior}"
    print(row, flush=True)
    time.sleep(4)

print("─" * 75)
print("\nReference: GPT-OSS-120B 17/17 102s | DeepSeek-V4-Flash 15/17 119s (OR) | Mistral-Small4 15/17 35s")
