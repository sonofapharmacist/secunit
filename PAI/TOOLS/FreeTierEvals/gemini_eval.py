#!/usr/bin/env python3
import os, json, time, urllib.request, urllib.error, re

API_KEY = os.environ.get("GEMINI_API_KEY", "")
BASE = "https://generativelanguage.googleapis.com/v1beta/models"

# Basic suite: all Flash models work with thinkingBudget:0.
# Pro-3.1 mandates thinking (thinkingBudget:0 returns an error) — reasoning suite only.
BASIC_MODELS = [
    ("gemini-2.5-flash-lite",   "Flash-Lite-2.5"),
    ("gemini-3.1-flash-lite",   "Flash-Lite-3.1"),
    ("gemini-2.5-flash",        "Flash-2.5"),
    ("gemini-3.5-flash",        "Flash-3.5"),
]

REASONING_MODELS = [
    ("gemini-2.5-flash-lite",   "Flash-Lite-2.5"),
    ("gemini-3.1-flash-lite",   "Flash-Lite-3.1"),
    ("gemini-2.5-flash",        "Flash-2.5"),        # still errors on R2-R5 at 3× budget — thinking heavy
    ("gemini-3.5-flash",        "Flash-3.5"),
    ("gemini-3.1-pro-preview",  "Pro-3.1"),          # mandates thinking; may timeout on R3/R5
]

# ── Basic suite ────────────────────────────────────────────────────────────────
BASIC = [
    ("Terse",    "Say exactly: Acknowledged. Nothing else.",                                                   10,  lambda r: "acknowledged" in r.lower()),
    ("JSON",     'Reply with ONLY valid JSON, no markdown fences: {"status": "ok", "count": 42}',              40,  lambda r: (lambda j: j.get("status")=="ok" and j.get("count")==42)(json.JSONDecoder().raw_decode(r.strip())[0])),
    ("Math",     "A train: 60mph for 2hrs, then 90mph for 1hr. Total distance? One line.",                     50,  lambda r: "210" in r),
    ("Cls-S",    "Reply ONE word ONLY — MINIMAL, NATIVE, or ALGORITHM: 'What is the capital of France?'",     8,   lambda r: "NATIVE" in r.upper()),
    ("Cls-C",    "Reply ONE word ONLY — MINIMAL, NATIVE, or ALGORITHM: 'Refactor auth to JWTs, update all tests, write migration guide.'", 8, lambda r: "ALGORITHM" in r.upper()),
    ("Security", "Top 3 risks of storing session tokens in localStorage. 3 bullets, under 15 words each.",    150, lambda r: sum(1 for w in ["xss","cross-site","script","theft","hijack","steal","inject"] if w in r.lower()) >= 2),
    ("Tool-JSON",'Return ONLY this JSON object, no prose: {"status": "ok", "count": 42}',                     40,  lambda r: (lambda j: j.get("status")=="ok" and j.get("count")==42)(json.JSONDecoder().raw_decode(re.sub(r'```[a-z]*\n?','',r).strip())[0])),
]

# ── Reasoning suite ────────────────────────────────────────────────────────────
# Token budgets are 3× the basic eval to accommodate thinking tokens on Flash/Pro models.
REASONING = [
    ("R1-Logic", """Solve: A, B, C are knights (truth) or knaves (lies).
A: "B is a knave." B: "A and C are the same type." C: "B is a knight."
Show reasoning, then: A=knight/knave, B=knight/knave, C=knight/knave.""",
     2700, lambda r: all(x in r.lower() for x in ["a=knight","b=knave","c=knave"]) or
           all(x in r.lower() for x in ["a is a knight","b is a knave","c is a knave"]) or
           all(x in r.lower() for x in ["a: knight","b: knave","c: knave"])),

    ("R2-STRIDE", """Security engineer task. System: REST API (Node.js), JWT HS256 (secret in env var), user file uploads to S3 with user-controlled filenames, admin panel at /admin protected only by JWT role field, no input sanitization on search endpoint.
Output a JSON array of 5 STRIDE threats. Each: {"stride_category":"...","component":"...","attack_vector":"...","impact":"..."}. Raw JSON only.""",
     4800, lambda r: _score_stride(r)),

    ("R3-Vulns", """Find every security vulnerability in this Python Flask code:
```python
@app.route('/user')
def get_user():
    user_id = request.args.get('id')
    cur.execute(f"SELECT * FROM users WHERE id = {user_id}")
    return jsonify(cur.fetchone())

@app.route('/file')
def get_file():
    path = f"/var/data/{request.args.get('name')}")
    return open(path).read()

@app.route('/admin/delete', methods=['POST'])
def delete_user():
    cur.execute(f"DELETE FROM users WHERE id = {request.json.get('uid')}")
```""",
     2100, lambda r: _score_vulns(r)),

    ("R4-Grid", """Logic grid: Alice, Bob, Carol each have job (engineer/designer/manager) and pet (cat/dog/fish).
1. Engineer has no cat. 2. Bob is not manager. 3. Carol has dog. 4. Designer has cat. 5. Alice is not engineer.
State each person's job and pet.""",
     3000, lambda r: _score_grid(r)),

    ("R5-Code", """Review this TypeScript rate limiter for bugs:
```typescript
const counts: Record<string,number> = {};
const windows: Record<string,number> = {};
export function rateLimit(userId: string, limit = 10): boolean {
  const now = Date.now();
  if (!windows[userId] || now - windows[userId] > 60_000) {
    windows[userId] = now; counts[userId] = 1; return true;
  }
  counts[userId]++;
  return counts[userId] <= limit;
}
```""",
     2400, lambda r: _score_ratelimiter(r)),
]

def _score_stride(raw):
    raw = re.sub(r'```[a-z]*\n?','',raw).strip()
    m = re.search(r'\[.*\]', raw, re.DOTALL)
    if not m: return 0
    try: data = json.loads(m.group())
    except: return 0
    cats = {"spoofing","tampering","repudiation","information disclosure","denial","elevation","dos"}
    return min(sum(1 for x in data[:5] if isinstance(x,dict) and
        any(s in str(x.get("stride_category","")).lower() for s in cats) and
        len(str(x.get("attack_vector",""))) > 10), 5)

def _score_vulns(raw):
    r = raw.lower()
    return (
        (1 if any(x in r for x in ["sql inject","sqli","f-string","f\"select","string interpolat","f'select"]) else 0) +
        (1 if any(x in r for x in ["path travers","directory travers","../","arbitrary file","lfi"]) else 0) +
        (1 if any(x in r for x in ["no auth","missing auth","unauthenticat","no access control","unprotect","anyone can"]) else 0)
    )

def _score_grid(raw):
    r = raw.lower()
    return (
        (1 if "alice" in r and ("designer" in r or "cat" in r) else 0) +
        (1 if "bob" in r and ("engineer" in r or "fish" in r) else 0) +
        (1 if "carol" in r and "manager" in r else 0)
    )

def _score_ratelimiter(raw):
    r = raw.lower()
    return (
        (1 if any(x in r for x in ["off-by-one","off by one","allows 11","11 request","one extra","limit + 1","11 call"]) else 0) +
        (1 if any(x in r for x in ["memory leak","unbounded","never clean","stale","accumulate","grow indefin","not removed","no cleanup"]) else 0)
    )

def call(model, prompt, max_tokens, disable_thinking=False):
    url = f"{BASE}/{model}:generateContent?key={API_KEY}"
    gen_config = {"maxOutputTokens": max_tokens, "temperature": 0.1}
    if disable_thinking:
        gen_config["thinkingConfig"] = {"thinkingBudget": 0}
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": gen_config,
    }
    t0 = time.time()
    try:
        req = urllib.request.Request(url, json.dumps(payload).encode(),
            {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.load(resp)
            elapsed = time.time() - t0
            err = result.get("error")
            if err: return "", elapsed, f"API:{err.get('message','')[:80]}"
            candidates = result.get("candidates", [])
            if not candidates: return "", elapsed, "NO_CANDIDATES"
            parts = candidates[0].get("content", {}).get("parts", [])
            # Filter out pure thought parts (thought=True with no visible text)
            text = " ".join(p.get("text","") for p in parts if p.get("text","").strip())
            return text.strip(), elapsed, None
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:120]
        return "", time.time()-t0, f"HTTP{e.code}:{body}"
    except Exception as e:
        return "", time.time()-t0, f"EXC:{str(e)[:80]}"

# ── Run basic ──────────────────────────────────────────────────────────────────
print("\n═══ BASIC SUITE (thinkingBudget=0) ═══")
print(f"{'Model':<18}" + "".join(f" {t[0]:>8}" for t in BASIC) + "  SCORE   TTFT")
print("─" * 90)

basic_results = {}
for model, label in BASIC_MODELS:
    scores, ttft = [], None
    for i, (name, prompt, max_tok, evalf) in enumerate(BASIC):
        resp, elapsed, err = call(model, prompt, max_tok, disable_thinking=True)
        if i == 0: ttft = elapsed
        if err and not resp:
            scores.append(None)
        else:
            try: scores.append(1 if evalf(resp) else 0)
            except: scores.append(0)
        time.sleep(1)

    def fmt(s): return "       ?" if s is None else ("       ✓" if s else "       ✗")
    valid = [s for s in scores if s is not None]
    score_str = f"{sum(valid)}/{len(valid)}"
    ttft_str = f"{ttft:.2f}s" if ttft else "err"
    print(f"{label:<18}" + "".join(fmt(s) for s in scores) + f"  {score_str:>5}  {ttft_str}")
    basic_results[label] = scores
    time.sleep(2)

# ── Run reasoning ──────────────────────────────────────────────────────────────
# Thinking enabled; 3× token budgets to accommodate thinking overhead.
print("\n\n═══ REASONING SUITE (thinking enabled, 3× token budgets) ═══")
print(f"{'Model':<18}" + "".join(f" {t[0]:>10}" for t in REASONING) + "  SCORE    TIME")
print("─" * 90)

max_scores = [2, 5, 3, 3, 2]

for model, label in REASONING_MODELS:
    scores, times = [], []
    for name, prompt, max_tok, evalf in REASONING:
        resp, elapsed, err = call(model, prompt, max_tok, disable_thinking=False)
        times.append(elapsed)
        if err and not resp:
            scores.append(None)
        else:
            try:
                sc = evalf(resp)
                scores.append(int(sc) if isinstance(sc, bool) else sc)
            except: scores.append(0)
        time.sleep(2)

    def fmt_r(s, mx): return "         ?" if s is None else f" {s}/{mx}"
    valid_pairs = [(s,mx) for s,mx in zip(scores,max_scores) if s is not None]
    got = sum(s for s,_ in valid_pairs)
    possible = sum(mx for _,mx in valid_pairs)
    total_t = sum(t for t in times if t > 0)
    row = f"{label:<18}" + "".join(fmt_r(s,mx) for s,mx in zip(scores,max_scores))
    row += f"  {got}/{possible}  {total_t:.1f}s"
    print(row)
    time.sleep(3)
