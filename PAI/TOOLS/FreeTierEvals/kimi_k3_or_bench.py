#!/usr/bin/env python3
"""
Kimi K3 (moonshotai/kimi-k3) — full 53-pt unified bench via OpenRouter only.

K3 is not yet available on NVIDIA NIM or Moonshot-direct (verified live on OpenRouter
catalog 2026-07-28) — this is an ad hoc OR-only script, same pattern as the existing
DeepSeek-V4-OR numbers in unified-bench-2026-06-16.md (produced by or_eval.py /
deepseek_retest.py directly, NOT through unified_bench.ts, since unified_bench.ts's
Provider type has no "openrouter" value and adding one is out of scope here).

Reuses prompts + scorers VERBATIM from:
  - mistral_eval.py   -> T1-T9 (TESTS array, _strip_fence)
  - deepseek_retest.py -> R1-R6 (TESTS array) — dropped the NIM leg, OR only
  - coding_battery.py -> C1-C6 + C8 (TESTS array, C8_PROMPT, run_c8, extract_code_block)

Kimi K2.6 required temperature=1 (MoE reasoning model) on NIM — same requirement
applied here for K3 per GP's explicit call. max_tokens=8192 (K2.6 used 4096; K3 is a
much larger model, 1M ctx per its tech report, so following the GLM-5.2/Nemotron-30B-R
pattern of 8192 + temp 1 for big reasoning/MoE models on this harness).

Usage:
  bun kimi_k3_or_bench.py            # full 53-pt run (T + R + C + C8)
  bun kimi_k3_or_bench.py --skip-c8  # skip vitest-dependent C8
"""
import os, sys, json, time, subprocess, urllib.request, urllib.error, re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# mistral_eval.py and coding_battery.py are both properly `if __name__ == "__main__"`
# guarded -> safe to import (no live API calls fire on import; mistral_eval.py only
# resolves a credential via passage at module scope, no network cost).
#
# deepseek_retest.py is NOT guarded -- it executes a full live NIM+OR bench run at
# module scope on import (confirmed by accident during this session: importing it
# for a dry-run sanity check silently fired a real DeepSeek-V4-Flash API sweep).
# R1-R6 TESTS are therefore copied verbatim below instead of imported, to avoid
# re-triggering that module's live run as an import side effect.
import mistral_eval as T_MOD          # T1-T9 TESTS + _strip_fence
import coding_battery as C_MOD        # C1-C6 TESTS + C8 machinery
import r_battery_tests as R_MOD       # R1-R6 TESTS, copied verbatim from deepseek_retest.py


def _get_key():
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if key:
        return key
    try:
        result = subprocess.run(["passage", "show", "api/openrouter"],
                                capture_output=True, text=True, timeout=5)
        return result.stdout.strip().splitlines()[0].strip()
    except Exception:
        return ""


OR_KEY = _get_key()
if not OR_KEY:
    print("FATAL: no OPENROUTER_API_KEY (env or passage api/openrouter)", file=sys.stderr)
    sys.exit(1)

OR_URL = "https://openrouter.ai/api/v1/chat/completions"
OR_MODEL = "moonshotai/kimi-k3"
MAX_TOKENS = 8192
TEMPERATURE = 1  # MoE reasoning model — same requirement as Kimi K2.6 on NIM


def call_or(prompt, max_tokens=MAX_TOKENS, timeout_s=180):
    payload = {
        "model": OR_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": TEMPERATURE,
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(OR_URL, data=data, headers={
        "Authorization": f"Bearer {OR_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://pai.local",
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            result = json.load(resp)
            elapsed = time.time() - t0
            err = result.get("error")
            if err:
                return "", elapsed, f"ERR:{str(err)[:150]}"
            choices = result.get("choices", [])
            if not choices:
                return "", elapsed, f"NO_CHOICES:{json.dumps(result)[:150]}"
            msg = choices[0].get("message", {})
            content = msg.get("content")
            # K3 (like K2.6) returns visible chain-of-thought in a separate "reasoning"
            # field, distinct from "content" -- NOT mixed into content like some
            # reasoning models. If content is empty/null but reasoning exists, the
            # completion token budget was exhausted by reasoning before any answer
            # text was produced. Distinguish this from a hard API error.
            reasoning = msg.get("reasoning") or ""
            if content is None or content == "":
                if reasoning:
                    return "", elapsed, f"ERR:reasoning_starved_no_content:reasoning_len={len(reasoning)}"
                return "", elapsed, f"ERR:content_null:{json.dumps(result)[:150]}"
            if isinstance(content, list):
                text = "".join(
                    b.get("text", "") for b in content
                    if isinstance(b, dict) and b.get("type") in ("text", None)
                )
                if not text:
                    return "", elapsed, f"ERR:no_text_blocks:{json.dumps(result)[:150]}"
                return text, elapsed, ""
            return content, elapsed, ""
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode()[:200]
        except Exception:
            pass
        return "", time.time() - t0, f"HTTP{e.code}:{body}"
    except Exception as e:
        return "", time.time() - t0, f"EXC:{type(e).__name__}:{str(e)[:100]}"


def looks_fenced(raw: str) -> bool:
    s = raw.strip()
    return s.startswith("```") or s.lower().startswith("json")


# ── T1-T9 ────────────────────────────────────────────────────────────────────

def run_t_battery():
    print("\n" + "═" * 80)
    print(f"T1-T9 — {OR_MODEL} via OpenRouter (max_tokens={MAX_TOKENS}, temp={TEMPERATURE})")
    print("═" * 80)
    results = []
    total = 0
    wall = 0.0
    fence_observed = False

    for t in T_MOD.TESTS:
        tid = t["id"]
        label = t["label"]
        if "tools" in t:
            # T8 tool-call test — OR-format tool call, reuse mistral_eval's tool schema
            payload = {
                "model": OR_MODEL,
                "messages": t["messages"],
                "tools": t["tools"],
                "tool_choice": "auto",
                "max_tokens": MAX_TOKENS,
                "temperature": TEMPERATURE,
            }
            data = json.dumps(payload).encode()
            req = urllib.request.Request(OR_URL, data=data, headers={
                "Authorization": f"Bearer {OR_KEY}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://pai.local",
            })
            t0 = time.time()
            try:
                with urllib.request.urlopen(req, timeout=180) as resp:
                    result = json.load(resp)
                    elapsed = time.time() - t0
                    choice = result["choices"][0]
                    msg = choice["message"]
                    response = "TOOL_CALLED" if msg.get("tool_calls") else (msg.get("content") or "")
                    err = ""
            except Exception as e:
                response, elapsed, err = "", time.time() - t0, f"EXC:{type(e).__name__}:{str(e)[:100]}"
        else:
            prompt = t["prompt"]
            # Full 8192 floor, not a smaller per-task cap -- K3 puts visible
            # chain-of-thought in a separate "reasoning" field (confirmed via smoke
            # test) that still consumes the completion token budget before any
            # "content" text is produced. A smaller cap starves content to empty.
            response, elapsed, err = call_or(prompt, max_tokens=MAX_TOKENS)

        wall += elapsed
        if err or response == "":
            print(f"  {tid:<20}  ERR    {elapsed:>7.1f}s  {err[:80]}")
            results.append({"id": tid, "label": label, "score": 0, "err": err})
            time.sleep(1.0)
            continue

        if looks_fenced(response):
            fence_observed = True

        try:
            passed = t["eval"](response)
        except Exception as e:
            passed = False
            err = f"scorer_exc:{e}"
        sc = 1 if passed else 0
        total += sc
        marker = "PASS" if sc else "FAIL"
        preview = response[:80].replace("\n", " ")
        print(f"  {tid:<20}  {marker}  {elapsed:>7.1f}s  {preview}")
        results.append({"id": tid, "label": label, "score": sc, "raw": response[:300], "err": err})
        time.sleep(1.0)

    pct = 100 * total / len(T_MOD.TESTS)
    print("─" * 80)
    print(f"T-BATTERY: {total}/9 ({pct:.0f}%)  wall={wall:.1f}s  fence_observed={fence_observed}")
    return {"battery": "T", "score": total, "max": 9, "wall": wall, "results": results,
            "fence_observed": fence_observed}


# ── R1-R6 ────────────────────────────────────────────────────────────────────

def run_r_battery():
    print("\n" + "═" * 80)
    print(f"R1-R6 — {OR_MODEL} via OpenRouter (max_tokens per-task, temp={TEMPERATURE})")
    print("═" * 80)
    results = []
    total = 0
    wall = 0.0
    fence_observed = False

    for t in R_MOD.TESTS:
        tid = t["id"]
        label = t["label"]
        prompt = t["prompt"]
        max_tok = max(t["max_tokens"], MAX_TOKENS) if t["max_tokens"] < 2000 else t["max_tokens"]
        # Give reasoning tasks the full 8192 floor per GLM-5.2/Nemotron pattern —
        # R-battery prompts historically starve at their original small budgets on
        # reasoning-heavy MoE models when temp=1 induces visible chain-of-thought.
        max_tok = MAX_TOKENS
        response, elapsed, err = call_or(prompt, max_tokens=max_tok, timeout_s=180)
        wall += elapsed

        if err or response == "":
            print(f"  {tid} {label:<22}  ERR    {elapsed:>7.1f}s  {err[:80]}")
            results.append({"id": tid, "label": label, "score": 0, "max": t["max_score"], "err": err})
            time.sleep(2.0)
            continue

        if looks_fenced(response):
            fence_observed = True

        try:
            sc = t["scorer"](response)
        except Exception as e:
            sc = 0
            err = f"scorer_exc:{e}"
        total += sc
        flag = "" if sc == t["max_score"] else " *"
        print(f"  {tid} {label:<22}  {sc}/{t['max_score']}  {elapsed:>7.1f}s{flag}")
        if sc < t["max_score"]:
            preview = response[:200].replace("\n", " ")
            print(f"      RESPONSE: {preview}")
        results.append({"id": tid, "label": label, "score": sc, "max": t["max_score"],
                        "raw": response[:600], "err": err})
        time.sleep(2.0)

    max_total = sum(t["max_score"] for t in R_MOD.TESTS)
    pct = 100 * total / max_total
    print("─" * 80)
    print(f"R-BATTERY: {total}/{max_total} ({pct:.0f}%)  wall={wall:.1f}s  fence_observed={fence_observed}")
    return {"battery": "R", "score": total, "max": max_total, "wall": wall, "results": results,
            "fence_observed": fence_observed}


# ── C1-C6 + C8 ───────────────────────────────────────────────────────────────

OR_CFG = {
    "name": "Kimi K3 (OpenRouter)",
    "fmt": "openrouter",
    "url": OR_URL,
    "model": OR_MODEL,
    "max_tokens": MAX_TOKENS,
    "is_reasoning": True,
}


def call_or_cfg(cfg, prompt, max_tokens=None):
    return call_or(prompt, max_tokens=(max_tokens or cfg["max_tokens"]), timeout_s=180)


def run_c_battery(skip_c8=False):
    print("\n" + "═" * 80)
    print(f"C1-C6 + C8 — {OR_MODEL} via OpenRouter (max_tokens={MAX_TOKENS}, temp={TEMPERATURE})")
    print("═" * 80)
    results = []
    total = 0
    wall = 0.0
    fence_observed = False

    for tid, label, max_score, prompt, scorer, max_tok in C_MOD.TESTS:
        response, elapsed, err = call_or_cfg(OR_CFG, prompt, max_tokens=max(max_tok, MAX_TOKENS))
        wall += elapsed
        if err or response == "":
            print(f"  {tid:<4}  ERR    {elapsed:>8.2f}s  {err[:80]}")
            results.append({"id": tid, "label": label, "score": 0, "max": max_score, "err": err})
            time.sleep(1.0)
            continue
        if looks_fenced(response):
            fence_observed = True
        score, notes = scorer(response)
        total += score
        marker = "PASS" if score == max_score else ("PART" if score > 0 else "FAIL")
        note_str = "; ".join(notes[:2])[:80]
        print(f"  {tid:<4}  {marker}  {score}/{max_score}  {elapsed:>8.2f}s  {note_str}")
        results.append({"id": tid, "label": label, "score": score, "max": max_score,
                        "elapsed": elapsed, "raw": response[:2400], "err": "", "notes": notes})
        time.sleep(1.0)

    if not skip_c8:
        print("\n  C8   (TTLCache implementation vs vitest)")
        response, elapsed, err = call_or_cfg(OR_CFG, C_MOD.C8_PROMPT, max_tokens=max(4000, MAX_TOKENS))
        wall += elapsed
        if err or response == "":
            print(f"  C8    ERR    {elapsed:>8.2f}s  {err[:80]}")
            results.append({"id": "C8", "label": "TTLCache vs vitest", "score": 0, "max": 5, "err": err})
        else:
            if looks_fenced(response):
                fence_observed = True
            score, notes = C_MOD.run_c8(OR_CFG, response)
            total += score
            marker = "PASS" if score == 5 else ("PART" if score > 0 else "FAIL")
            print(f"  C8    {marker}  {score}/5    {elapsed:>8.2f}s  {'; '.join(notes[:3])[:80]}")
            results.append({"id": "C8", "label": "TTLCache vs vitest", "score": score, "max": 5,
                            "elapsed": elapsed, "raw": response[:2400], "err": "", "notes": notes})

    max_total = sum(m for _, _, m, _, _, _ in C_MOD.TESTS) + (0 if skip_c8 else 5)
    pct = 100 * total / max_total if max_total else 0
    print("─" * 80)
    print(f"C-BATTERY: {total}/{max_total} ({pct:.0f}%)  wall={wall:.1f}s  fence_observed={fence_observed}")
    return {"battery": "C", "score": total, "max": max_total, "wall": wall, "results": results,
            "fence_observed": fence_observed}


def main():
    skip_c8 = "--skip-c8" in sys.argv
    t0 = time.time()

    t_result = run_t_battery()
    r_result = run_r_battery()
    c_result = run_c_battery(skip_c8=skip_c8)

    grand_total = t_result["score"] + r_result["score"] + c_result["score"]
    grand_max = t_result["max"] + r_result["max"] + c_result["max"]
    wall_total = time.time() - t0
    any_fence = t_result["fence_observed"] or r_result["fence_observed"] or c_result["fence_observed"]

    print("\n" + "═" * 80)
    print(f"FINAL — {OR_MODEL} (OpenRouter, temp={TEMPERATURE}, max_tokens={MAX_TOKENS})")
    print("═" * 80)
    print(f"  T-battery: {t_result['score']}/{t_result['max']}")
    print(f"  R-battery: {r_result['score']}/{r_result['max']}")
    print(f"  C-battery: {c_result['score']}/{c_result['max']}")
    print(f"  TOTAL:     {grand_total}/{grand_max}  ({100*grand_total/grand_max:.1f}%)")
    print(f"  Wall time: {wall_total:.1f}s ({wall_total/60:.1f}min)")
    print(f"  Fence-stripping needed: {any_fence}")

    out_path = "/home/realuser/.claude/PAI/TOOLS/FreeTierEvals/kimi_k3_or_bench_results.json"
    with open(out_path, "w") as f:
        json.dump({
            "model": OR_MODEL,
            "provider": "openrouter",
            "temperature": TEMPERATURE,
            "max_tokens": MAX_TOKENS,
            "date": "2026-07-28",
            "t_battery": t_result,
            "r_battery": r_result,
            "c_battery": c_result,
            "total": f"{grand_total}/{grand_max}",
            "wall_s": wall_total,
            "fence_observed": any_fence,
        }, f, indent=2)
    print(f"\nResults saved: {out_path}")


if __name__ == "__main__":
    main()
