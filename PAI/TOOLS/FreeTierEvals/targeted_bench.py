#!/usr/bin/env python3
"""
Targeted single-model bench — runs the nim_eval task suite (R1-R6, G1, G7, G8)
PLUS the canonical T9 single-letter STRIDE probe against ONE model on ONE provider.
Designed to be quota-safe: never triggers nim_eval.py's top-level sweep loop.

Usage:
  python3 targeted_bench.py --provider nim   --model qwen/qwen3.5-397b-a17b --reasoning --label "Qwen3.5-397B"
  python3 targeted_bench.py --provider groq  --model openai/gpt-oss-120b    --reasoning --label "GPT-OSS-120B"

We exec nim_eval.py lines 1..369 (everything before `all_results = {}` at line 371)
into a namespace. That loads: NIM_KEY, NIM_URL, MODELS (unused), TESTS (9 tasks),
all scorers, and call() — byte-faithful to the leaderboard run. We do NOT import
the module (import would fire the sweep loop and burn the whole NIM catalog).
"""
import os, sys, json, time, urllib.request, urllib.error, subprocess, argparse

HERE = os.path.dirname(os.path.abspath(__file__))

# ── Load nim_eval definitions WITHOUT running its sweep ─────────────────────────
with open(os.path.join(HERE, "nim_eval.py")) as f:
    src = f.read()
SWEEP_MARKER = "all_results = {}"
cut = src.index(SWEEP_MARKER)
# Also drop the two print() lines just above the sweep (header printing)
ns_src = src[:cut]
# Remove the leading print() of the runner header so our output stays clean
ns_src = ns_src.rsplit('print(f"\\nNVIDIA NIM eval', 1)[0]
ns_src = ns_src.rsplit('print(f"Prior benchmarks', 1)[0]

ns = {"__name__": "__not_main__"}
exec(compile(ns_src, "nim_eval.py", "exec"), ns)
TESTS = ns["TESTS"]                       # 9 tasks: R1,R2,R3,R4,R5,R6,G1,G7,G8
nim_call = ns["call"]                     # (model_id, prompt, max_tokens, is_reasoning, strip_fences)
_score_stride = ns["_score_stride"]
_score_long_json = ns["_score_long_json"]
_extract_answer = ns["_extract_answer"]
_strip_fences = ns["_strip_fences"]
NIM_KEY = ns["NIM_KEY"]
NIM_URL = ns["NIM_URL"]

# ── Canonical T9 single-letter STRIDE probe (from llamacpp_eval.py:202) ─────────
T9 = {
    "id": "T9",
    "label": "STRIDE single-letter (SQLi → T)",
    "prompt": (
        "Classify this finding as STRIDE category. Reply with ONLY the letter.\n"
        "Finding: An API endpoint accepts a user_id parameter from the URL and passes "
        "it directly to a SQL query without parameterization.\n"
        "Reply with: S, T, R, I, D, or E (Spoofing, Tampering, Repudiation, "
        "Information Disclosure, Denial of Service, Elevation of Privilege)"
    ),
    "max_score": 1,
    "max_tokens": 64,
}


def get_key(name):
    canon = {"nim": "nvidia", "groq": "groq"}[name]  # provider → canonical vault/env name
    env = {"nvidia": "NVIDIA_API_KEY", "groq": "GROQ_API_KEY"}[canon]
    if os.environ.get(env):
        return os.environ[env]
    vault = {"nvidia": "api/nvidia", "groq": "api/groq"}[canon]
    r = subprocess.run(["passage", "show", vault], capture_output=True, text=True, timeout=5)
    return r.stdout.strip().splitlines()[0].strip()


def groq_call(model_id, prompt, max_tokens, is_reasoning, do_strip_fences, key):
    """Groq endpoint. Reasoning models get reasoning_format=parsed so <think> is separated."""
    temperature = 1 if is_reasoning else 0.2
    effective_max = max(max_tokens, 2048) if is_reasoning else max_tokens
    payload = {
        "model": model_id,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": effective_max,
        "temperature": temperature,
    }
    # GPT-OSS / Qwen3.6 dump <think> into content; parsed keeps reasoning separate
    if is_reasoning:
        payload["reasoning_format"] = "parsed"
    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # Groq sits behind Cloudflare; bare urllib UA gets 1010'd
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        },
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.load(resp)
            elapsed = time.time() - t0
        err = result.get("error")
        if err:
            return None, elapsed, f"ERR:{str(err)[:100]}"
        choices = result.get("choices", [])
        if not choices:
            return None, elapsed, "NO_CHOICES"
        msg = choices[0].get("message", {})
        content = msg.get("content") or ""
        if isinstance(content, list):
            content = " ".join(p.get("text", "") for p in content
                               if isinstance(p, dict) and p.get("type") == "text")
        content = ns["_strip_json_prefix"](content)
        if do_strip_fences:
            content = _strip_fences(content)
        return content, elapsed, None
    except urllib.error.HTTPError as e:
        return None, time.time() - t0, f"HTTP{e.code}:{e.read().decode()[:120]}"
    except Exception as e:
        return None, time.time() - t0, f"EXC:{str(e)[:80]}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", required=True, choices=["nim", "groq"])
    ap.add_argument("--model", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--reasoning", action="store_true")
    ap.add_argument("--strip-fences", action="store_true")
    args = ap.parse_args()

    key = get_key(args.provider)
    if not key:
        print(f"ERROR: no key for {args.provider}", file=sys.stderr)
        sys.exit(1)

    if args.provider == "nim":
        caller = lambda p, mt: nim_call(args.model, p, mt, args.reasoning, args.strip_fences)
    else:
        caller = lambda p, mt: groq_call(args.model, p, mt, args.reasoning, args.strip_fences, key)

    tasks = TESTS + [T9]
    max_total = sum(t["max_score"] for t in tasks)  # 34 + 1 = 35

    print(f"\n{args.provider.upper()} targeted bench — {args.label} ({args.model})")
    print(f"reasoning={args.reasoning} | {len(tasks)} tasks | max {max_total} pts\n")

    scores, times, details = [], [], []
    for t in tasks:
        resp, elapsed, err = caller(t["prompt"], t["max_tokens"])
        times.append(elapsed if elapsed is not None else 0)
        if err or resp is None:
            scores.append(None)
            details.append((t["id"], None, t["max_score"], err or "null"))
            print(f"  {t['id']:<4} ERROR  {err or 'null'}", flush=True)
        else:
            if t["id"] == "T9":
                sc = 1 if resp.strip().upper().startswith("T") else 0
            else:
                sc = t["scorer"](resp)
            scores.append(sc)
            preview = resp.replace("\n", " ")[:70]
            details.append((t["id"], sc, t["max_score"], preview))
            print(f"  {t['id']:<4} {sc}/{t['max_score']:<3} {elapsed:5.1f}s  {preview}", flush=True)
        time.sleep(2)

    valid = [(s, mx) for s, (_, _, mx, _) in zip(scores, details) if s is not None]
    got = sum(s for s, _ in valid)
    possible = sum(mx for _, mx in valid)
    print(f"\n  TOTAL: {got}/{possible}  ({len(valid)}/{len(tasks)} tasks returned)")
    print(f"  Wall:  {sum(times):.1f}s   Avg/task: {sum(times)/max(len(times),1):.1f}s")

    # Emit a leaderboard-comparable JSONL record
    rec = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "provider": args.provider,
        "model": args.model,
        "label": args.label,
        "reasoning": args.reasoning,
        "score": got,
        "max": possible,
        "per_task": {tid: sc for tid, sc, _, _ in details},
        "wall_s": round(sum(times), 1),
    }
    out = os.path.join(HERE, "targeted_bench_results.jsonl")
    with open(out, "a") as f:
        f.write(json.dumps(rec) + "\n")
    print(f"  → appended to {out}")


if __name__ == "__main__":
    main()
