#!/usr/bin/env python3
"""
Incremental per-test runner for Gemini 3.6 Flash on the unified 53-pt suite.

Why this exists: 3.6 Flash's live API throws persistent 503s (launch-week capacity),
so full 53-pt runs (unified_bench.ts --model=flash36 --full) waste a lot of wall
time re-running tests that already passed cleanly alongside the ones still flaking.
This script tracks state per test ID and only re-attempts tests that haven't yet
locked in, so repeated invocations (e.g. from a /loop) converge instead of restart.

Lock-in rule: a test needs 2 CONSECUTIVE clean passes (score == max_score, no error)
to be marked complete. A single lucky pass on a flaky backend isn't trusted; any
non-clean result (503, error, partial score) resets that test's streak to 0.

State file: gemini36_incremental_state.json (same directory) — one row per test ID
across all three batteries (T1-T9, R1-R6, C1-C6+C8), tracking streak count, last
result, and history. Safe to delete to start over.

Usage:
  python3 gemini36_incremental.py                    # run all not-yet-complete tests once
  python3 gemini36_incremental.py --battery=T        # run only T-battery's open tests (also R, C)
  python3 gemini36_incremental.py --status           # print current state, run nothing
  python3 gemini36_incremental.py --reset            # clear state file and start over

Recommended for /loop use: --battery=T|R|C rather than the default (all three) — R2 alone
has been observed to take 260s+ across its 4-attempt backoff, so bounding each invocation to
one battery keeps wall time predictable and lets the loop cycle through T/R/C across firings.
"""
import json
import os
import sys
import time
import importlib.util

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(SCRIPT_DIR, "gemini36_incremental_state.json")
STREAK_TO_COMPLETE = 2
TARGET_MODEL_ID = "gemini-3.6-flash"


def _load_module(name, filename):
    path = os.path.join(SCRIPT_DIR, filename)
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_state():
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH) as f:
            return json.load(f)
    return {}


def save_state(state):
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


def record_result(state, battery, tid, label, max_score, score, clean, note):
    key = f"{battery}:{tid}"
    row = state.get(key, {"battery": battery, "id": tid, "label": label, "max_score": max_score,
                           "streak": 0, "complete": False, "attempts": 0, "history": []})
    row["attempts"] += 1
    row["last_score"] = score
    row["last_clean"] = clean
    row["last_note"] = note[:150]
    row["last_run_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    if clean:
        row["streak"] += 1
    else:
        row["streak"] = 0
    if row["streak"] >= STREAK_TO_COMPLETE:
        row["complete"] = True
    row["history"] = (row.get("history") or [])[-9:] + [{"score": score, "clean": clean, "at": row["last_run_at"]}]
    state[key] = row
    return row


def print_status(state):
    if not state:
        print("No state yet — run without --status to start.")
        return
    total_max = 0
    total_best = 0
    print(f"\n{'Battery:ID':<10} {'Label':<32} {'Streak':>7} {'Status':<10} {'Attempts':>9}  Last")
    print("─" * 100)
    for key in sorted(state, key=lambda k: (state[k]["battery"], state[k]["id"])):
        row = state[key]
        total_max += row["max_score"]
        if row["complete"]:
            total_best += row["max_score"]
        elif row.get("last_clean"):
            total_best += row.get("last_score", 0)
        status = "DONE" if row["complete"] else f"{row['streak']}/{STREAK_TO_COMPLETE}"
        print(f"{key:<10} {row['label'][:32]:<32} {row['streak']:>7} {status:<10} {row['attempts']:>9}  "
              f"{row.get('last_score','-')}/{row['max_score']} {row.get('last_note','')[:40]}")
    print("─" * 100)
    n_done = sum(1 for r in state.values() if r["complete"])
    print(f"Locked in: {n_done}/{len(state)} tests  |  Best-known composite: {total_best}/{total_max}")


def run_t_battery(state, save_cb):
    mod = _load_module("gemini_t_battery", "gemini_t_battery.py")
    cfg = mod.ENDPOINTS["flash_36"]
    for tid, label, prompt, tools, max_tok, scorer in mod.TESTS:
        key = f"T:{tid}"
        if state.get(key, {}).get("complete"):
            continue
        response, elapsed = mod.call_gemini(cfg["model"], prompt, max_tok, tools=tools)
        is_err = isinstance(response, str) and (response.startswith("ERR:") or response.startswith("HTTP")
                                                  or response in ("NO_CANDIDATES", "MAX_RETRIES"))
        try:
            passed = (not is_err) and scorer(response)
        except Exception:
            passed = False
        score = 1 if passed else 0
        clean = passed and not is_err
        note = str(response)[:60].replace("\n", " ")
        row = record_result(state, "T", tid, label, 1, score, clean, note)
        save_cb(state)  # persist after every test — a timeout mid-battery must not lose prior results
        status = "LOCKED" if row["complete"] else ("PASS(streak)" if clean else "FAIL/ERR")
        print(f"  T:{tid} [{status}] {label}: {note!r} ({elapsed:.1f}s)")
        if cfg.get("sleep", 0) > 0:
            time.sleep(cfg["sleep"])


def run_r_battery(state, save_cb):
    mod = _load_module("gemini_reasoning_probe", "gemini_reasoning_probe.py")
    cfg = mod.ENDPOINTS["flash_36"]
    api_key = mod.resolve_key(cfg["passage_key"])
    for t in mod.TESTS:
        tid = t["id"]
        key = f"R:{tid}"
        if state.get(key, {}).get("complete"):
            continue
        resp, elapsed, err = mod.call_gemini(cfg["model"], api_key, t["prompt"], t["max_tokens"], cfg["thinking"])
        if cfg.get("sleep", 0) > 0:
            time.sleep(cfg["sleep"])
        if err and not resp:
            score = 0
            note = f"ERR:{err[:60]}"
            clean = False
        else:
            try:
                raw_score = t["scorer"](resp)
                score = int(raw_score) if isinstance(raw_score, bool) else raw_score
            except Exception:
                score = 0
            note = repr(resp[:60])
            clean = (score == t["max_score"])
        row = record_result(state, "R", tid, t.get("label", tid), t["max_score"], score, clean, note)
        save_cb(state)  # persist after every test — a timeout mid-battery must not lose prior results
        status = "LOCKED" if row["complete"] else ("PASS(streak)" if clean else "PARTIAL/FAIL")
        print(f"  R:{tid} [{status}] {score}/{t['max_score']}: {note} ({elapsed:.1f}s)")


def run_c_battery(state, save_cb):
    mod = _load_module("coding_battery", "coding_battery.py")
    cfg = mod.ENDPOINTS["flash_36"]

    # Main TESTS list (C1-C6)
    for tid, label, max_score, prompt, scorer, max_tok in mod.TESTS:
        key = f"C:{tid}"
        if state.get(key, {}).get("complete"):
            continue
        response, elapsed, err = mod.call_api(cfg, prompt, max_tokens=max_tok)
        if err:
            score, notes = 0, [err[:60]]
            clean = False
        else:
            score, notes = scorer(response)
            clean = (score == max_score)
        note = "; ".join(notes[:2])[:80] if notes else ""
        row = record_result(state, "C", tid, label, max_score, score, clean, note)
        save_cb(state)  # persist after every test — a timeout mid-battery must not lose prior results
        status = "LOCKED" if row["complete"] else ("PASS(streak)" if clean else "PARTIAL/FAIL")
        print(f"  C:{tid} [{status}] {score}/{max_score}: {note} ({elapsed:.1f}s)")
        if cfg.get("sleep", 1.0) > 0:
            time.sleep(cfg["sleep"])

    # C8 is handled separately in coding_battery.py (TTLCache vs vitest) — needs a live
    # response to score against (run_c8 executes vitest against the generated code), so
    # it can't be pre-scored like the others; must call_api first, then run_c8(cfg, response).
    key = "C:C8"
    if not state.get(key, {}).get("complete"):
        response, elapsed, err = mod.call_api(cfg, mod.C8_PROMPT, max_tokens=4000)
        if err:
            score, notes = 0, [err[:60]]
            clean = False
        else:
            score, notes = mod.run_c8(cfg, response)
            clean = (score == 5)  # C8 max_score per coding-battery-spec.md
        note = "; ".join(notes[:2])[:80] if notes else ""
        row = record_result(state, "C", "C8", "TTLCache vs vitest", 5, score, clean, note)
        save_cb(state)
        status = "LOCKED" if row["complete"] else ("PASS(streak)" if clean else "PARTIAL/FAIL")
        print(f"  C:C8 [{status}] {score}/5: {note} ({elapsed:.1f}s)")


def main():
    if "--reset" in sys.argv:
        if os.path.exists(STATE_PATH):
            os.remove(STATE_PATH)
        print("State cleared.")
        return

    state = load_state()

    if "--status" in sys.argv:
        print_status(state)
        return

    battery_arg = next((a.split("=", 1)[1].upper() for a in sys.argv if a.startswith("--battery=")), None)

    print(f"=== Gemini 3.6 Flash incremental run — {time.strftime('%Y-%m-%d %H:%M:%S')} ===")
    print(f"(need {STREAK_TO_COMPLETE} consecutive clean passes per test to lock in)\n")

    if battery_arg in (None, "T"):
        print("-- T battery --")
        run_t_battery(state, save_state)

    if battery_arg in (None, "R"):
        print("\n-- R battery --")
        run_r_battery(state, save_state)

    if battery_arg in (None, "C"):
        print("\n-- C battery --")
        run_c_battery(state, save_state)

    print()
    print_status(state)

    n_total = len(state)
    n_done = sum(1 for r in state.values() if r["complete"])
    if n_total > 0 and n_done == n_total:
        print("\nALL TESTS LOCKED IN — composite score is final, no more runs needed.")


if __name__ == "__main__":
    main()
