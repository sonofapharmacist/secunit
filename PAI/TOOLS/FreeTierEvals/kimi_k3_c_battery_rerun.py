#!/usr/bin/env python3
"""
Kimi K3 (moonshotai/kimi-k3) — C-battery-ONLY rerun at a much higher token ceiling.

Context: the original full 53-pt sweep (kimi_k3_or_bench.py, 2026-07-28) used
max_tokens=8192 across all batteries. T (9/9) and R (17/17) were clean. C-battery
(7/27) was confounded: C2 (19,496 reasoning tokens), C5 (32,745), and C6 (30,971)
all hit reasoning_starved_no_content -- the model was still reasoning when the
8192-token ceiling cut it off, so zero content was ever produced. C8 failed on an
OpenRouter HTTP 402 (account credit exhaustion, not a tuning issue).

This rerun raises max_tokens to 65536 -- 2x the worst observed reasoning length
(32,745) -- to give every task real headroom, and tracks actual $ spent per call
via the OpenRouter response's usage.cost field so total spend is known precisely,
not estimated. Pricing confirmed via GET /models/moonshotai/kimi-k3/endpoints:
$3/MTok prompt, $15/MTok completion (BaseTen fp8 endpoint), max_completion_tokens
262144 -- 65536 is comfortably within the provider's own ceiling.

Same prompts, same rubrics as coding_battery.py -- imported directly (safe,
__main__-guarded, no side effects on import). No rescoring logic changes.

Usage:
  bun kimi_k3_c_battery_rerun.py
"""
import os, sys, json, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import coding_battery as C_MOD
import kimi_k3_or_bench as k  # reuses call_or, OR_KEY, OR_URL, OR_MODEL, TEMPERATURE

RERUN_MAX_TOKENS = 65536


def call_or_tracked(prompt, max_tokens, timeout_s=300):
    """Like kimi_k3_or_bench.call_or but also returns the raw usage dict (with cost)."""
    import urllib.request, urllib.error
    payload = {
        "model": k.OR_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": k.TEMPERATURE,
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(k.OR_URL, data=data, headers={
        "Authorization": f"Bearer {k.OR_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://pai.local",
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            result = json.load(resp)
            elapsed = time.time() - t0
            usage = result.get("usage", {})
            err = result.get("error")
            if err:
                return "", elapsed, f"ERR:{str(err)[:150]}", usage
            choices = result.get("choices", [])
            if not choices:
                return "", elapsed, f"NO_CHOICES:{json.dumps(result)[:150]}", usage
            msg = choices[0].get("message", {})
            content = msg.get("content")
            reasoning = msg.get("reasoning") or ""
            reasoning_tok = usage.get("completion_tokens_details", {}).get("reasoning_tokens", 0)
            if content is None or content == "":
                if reasoning or reasoning_tok:
                    return "", elapsed, f"ERR:reasoning_starved_no_content:reasoning_len={len(reasoning)}:reasoning_tokens={reasoning_tok}", usage
                return "", elapsed, f"ERR:content_null:{json.dumps(result)[:150]}", usage
            if isinstance(content, list):
                text = "".join(
                    b.get("text", "") for b in content
                    if isinstance(b, dict) and b.get("type") in ("text", None)
                )
                if not text:
                    return "", elapsed, f"ERR:no_text_blocks:{json.dumps(result)[:150]}", usage
                return text, elapsed, "", usage
            return content, elapsed, "", usage
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode()[:250]
        except Exception:
            pass
        return "", time.time() - t0, f"HTTP{e.code}:{body}", {}
    except Exception as e:
        return "", time.time() - t0, f"EXC:{type(e).__name__}:{str(e)[:100]}", {}


def get_credits():
    import urllib.request
    req = urllib.request.Request("https://openrouter.ai/api/v1/credits", headers={
        "Authorization": f"Bearer {k.OR_KEY}",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)["data"]


def main():
    print(f"Kimi K3 C-battery rerun — max_tokens={RERUN_MAX_TOKENS}, temp={k.TEMPERATURE}")
    before = get_credits()
    print(f"Credits before: total_credits={before['total_credits']}, total_usage={before['total_usage']:.6f}, headroom={before['total_credits']-before['total_usage']:.4f}")

    results = []
    total = 0
    wall = 0.0
    total_cost = 0.0

    for tid, label, max_score, prompt, scorer, max_tok in C_MOD.TESTS:
        response, elapsed, err, usage = call_or_tracked(prompt, max_tokens=RERUN_MAX_TOKENS, timeout_s=300)
        wall += elapsed
        cost = usage.get("cost", 0.0) or 0.0
        total_cost += cost
        rtok = usage.get("completion_tokens_details", {}).get("reasoning_tokens", "?")
        if err or response == "":
            print(f"  {tid:<4}  ERR    {elapsed:>8.2f}s  cost=${cost:.4f}  reasoning_tok={rtok}  {err[:100]}")
            results.append({"id": tid, "label": label, "score": 0, "max": max_score, "err": err,
                            "elapsed": elapsed, "cost": cost, "reasoning_tokens": rtok})
            time.sleep(1.0)
            continue
        score, notes = scorer(response)
        total += score
        marker = "PASS" if score == max_score else ("PART" if score > 0 else "FAIL")
        note_str = "; ".join(notes[:2])[:80]
        print(f"  {tid:<4}  {marker}  {score}/{max_score}  {elapsed:>8.2f}s  cost=${cost:.4f}  reasoning_tok={rtok}  {note_str}")
        results.append({"id": tid, "label": label, "score": score, "max": max_score,
                        "elapsed": elapsed, "raw": response[:2400], "err": "", "notes": notes,
                        "cost": cost, "reasoning_tokens": rtok})
        time.sleep(1.0)

    # C8
    or_cfg = {"model": k.OR_MODEL, "max_tokens": RERUN_MAX_TOKENS}
    print("\n  C8   (TTLCache implementation vs vitest)")
    response, elapsed, err, usage = call_or_tracked(C_MOD.C8_PROMPT, max_tokens=RERUN_MAX_TOKENS, timeout_s=300)
    wall += elapsed
    cost = usage.get("cost", 0.0) or 0.0
    total_cost += cost
    rtok = usage.get("completion_tokens_details", {}).get("reasoning_tokens", "?")
    if err or response == "":
        print(f"  C8    ERR    {elapsed:>8.2f}s  cost=${cost:.4f}  reasoning_tok={rtok}  {err[:100]}")
        results.append({"id": "C8", "label": "TTLCache vs vitest", "score": 0, "max": 5, "err": err,
                        "elapsed": elapsed, "cost": cost, "reasoning_tokens": rtok})
    else:
        score, notes = C_MOD.run_c8(or_cfg, response)
        total += score
        marker = "PASS" if score == 5 else ("PART" if score > 0 else "FAIL")
        print(f"  C8    {marker}  {score}/5    {elapsed:>8.2f}s  cost=${cost:.4f}  reasoning_tok={rtok}  {'; '.join(notes[:3])[:80]}")
        results.append({"id": "C8", "label": "TTLCache vs vitest", "score": score, "max": 5,
                        "elapsed": elapsed, "raw": response[:2400], "err": "", "notes": notes,
                        "cost": cost, "reasoning_tokens": rtok})

    max_total = sum(m for _, _, m, _, _, _ in C_MOD.TESTS) + 5
    pct = 100 * total / max_total if max_total else 0
    print("─" * 100)
    print(f"C-BATTERY (rerun): {total}/{max_total} ({pct:.0f}%)  wall={wall:.1f}s  total_cost=${total_cost:.4f}")

    after = get_credits()
    print(f"Credits after: total_credits={after['total_credits']}, total_usage={after['total_usage']:.6f}, headroom={after['total_credits']-after['total_usage']:.4f}")
    print(f"Actual spend (usage delta): ${after['total_usage']-before['total_usage']:.4f}")

    out_path = "/home/realuser/.claude/PAI/TOOLS/FreeTierEvals/kimi_k3_c_battery_rerun_results.json"
    with open(out_path, "w") as f:
        json.dump({
            "model": k.OR_MODEL,
            "provider": "openrouter",
            "temperature": k.TEMPERATURE,
            "max_tokens": RERUN_MAX_TOKENS,
            "date": "2026-07-28",
            "c_battery": {"battery": "C", "score": total, "max": max_total, "wall": wall, "results": results},
            "cost_tracked_total": total_cost,
            "credits_before": before,
            "credits_after": after,
            "actual_spend_usage_delta": after["total_usage"] - before["total_usage"],
        }, f, indent=2)
    print(f"\nResults saved: {out_path}")


if __name__ == "__main__":
    main()
