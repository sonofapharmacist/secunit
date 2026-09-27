---
name: algorithm-version-v8.0.0
title: "Algorithm version bumped to v8.0.0 — harness-enforced doctrine replaces prompted ceremony"
date: 2026-09-23
status: complete
detected: algorithm-version
change: "Algorithm version changed from v7.1.1 to v8.0.0"
---

## Decision

Bumped Algorithm from v7.1.1 (729 lines) to v8.0.0 (119 lines) on 2026-09-23 by writing `8.0.0` to `PAI/ALGORITHM/LATEST`. The substance is recorded in `algorithm-v8-harness-first.md` and, for the classifier fields and subagent routing, in `model-routing-policy.md`. This record covers the version bump itself.

In short: the verification doctrine stays (ISC granularity, the probe tables, forbidden language, Rules 1–3 including Cato via direct Bash, reproduce-first), enforcement moves into hooks gated on `LATEST`, and the ceremony goes (E1–E5 thinking and delegation floors, phase narration, INTENT ECHO, the stop-the-line block, ISC count floors). Criteria are written only when "done" has a nameable probe. The CLAUDE.md MODES section and scope-gate rule were rewritten in the same change.

## Alternatives Rejected

**Keep v7.1.1 and strengthen the wording.** Rejected. Since the Claude 5 family, the executing model near-totally ignores `MODE: ALGORITHM` routing. Across 178 completed v7 ISAs, only 21% of checked criteria carried a checkable evidence line under the strict rule, and 7 of 9 deep ISAs had no Cato audit on record (2 of those predate the audit log, so 5 are real misses). More prose does not change that.

**Cut the Algorithm to ~80 lines and drop what the model ignores.** Rejected after a seven-model, six-vendor panel review. Six of seven reviewers made the same correction: a model ignoring a rule is evidence that enforcement is broken, not that the rule is obsolete. Cato, the probe tables, and observability data were kept or moved to hooks rather than deleted.

**Run a 20-session opt-in A/B (v7 vs v8) before flipping.** Declined by GP. Replaced by flipping with passive monitoring and a one-line rollback.

## Evidence

- **Build checks (2026-09-23):** `wc -l v8.0.0.md` → `119`. Verbatim sections from v7.1.1 → `5/5` lines matched. Cut terms → `0` hits. Each v8 hook was run with `LATEST` at `7.1.1` and at `8.0.0`, showing v7 behavior unchanged and v8 behavior only under 8.0.0. Full log: `MEMORY/WORK/20260923-algorithm-v8-harness-first/ISA.md`, `## Verification`.
- **Cato audit** (codex gpt-5.5): verdict `concerns`, medium. All five findings were criteria wording that overclaimed the code; each was reworded to match.
- **First week after the flip (2026-09-23 to 2026-09-25):**
  - Classifier: 65 prompts, `0` fail-safes, against a tripwire of more than 5% a week.
  - Gates: 40 sessions, and no transcript shows an observe-gate or completion-lint block. The tripwire for blocking genuinely finished work never fired.
  - ISAs: 2 completed under v8, both with 100% checkable evidence after backfill. `AlgorithmAB.ts` reports `2/20`, too few for a verdict.
  - ISA volume dropped sharply, as intended: work without a nameable probe lives in project notes instead.

## Consequences

- **Rollback:** write `7.1.1` to `PAI/ALGORITHM/LATEST`. Every v8 hook behavior is gated on it. The CLAUDE.md MODES text would also need reverting from git.
- **Monitoring:** the classifier fail-safe tripwire stays in CLAUDE.md Operational Notes. `bun PAI/TOOLS/AlgorithmAB.ts` rescores against the v7 baseline (`ab-baseline-2026-09-23.json`) any time.
- **Known limitation, Bash edits bypass the completion lint.** The lint (`PhaseTransitionGuard`) and the completion breadcrumb (`ISASync`) fire on Write/Edit only. On 2026-09-23, `model-routing-policy` was closed with a `sed -i` edit: observe → complete, all criteria ticked, no `## Verification`. Its evidence was backfilled on 2026-09-25 and all six criteria held. GP chose not to add a hook for this: the harness has one operator plus the DA, so the rule is "close ISAs with Edit, not shell." If the harness gains other operators or unattended agents that close ISAs, revisit with a Stop-hook sweep of ISAs that turned `complete` during the session.
- **Known limitation, evidence is shape-checked.** The lint requires a quoted action or result on each evidence line. It does not confirm that the quote is real tool output.
- Scoring depends on the one-line breadcrumb in `MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl`. An ISA completed without it is scored as v7.
