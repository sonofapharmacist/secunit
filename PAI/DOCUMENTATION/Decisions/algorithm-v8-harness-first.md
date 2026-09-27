---
name: algorithm-v8-harness-first
title: "Algorithm v8: harness-enforced doctrine replaces prompted ceremony"
date: 2026-09-23
status: accepted
detected: algorithm-version-bump
change: "PAI/ALGORITHM/v8.0.0.md (119 lines) replaces v7.1.1 (729 lines) at the LATEST flip, pending GP go-ahead, monitored afterward with rollback tripwires (GP declined a pre-flip A/B). Enforcement moves from prose the model must perform into hooks gated on LATEST. The classifier emits MODEL / COST_TIER / CONFIDENCE instead of MODE / TIER."
---

> **Partly superseded 2026-09-23:** the classifier no longer emits MODEL / COST_TIER / CONFIDENCE. See `model-routing-policy.md`.

## Context

Since the Claude 5 family (Sonnet 5, Opus 5.5, Fable 5.1) the executing model near-totally ignores `MODE: ALGORITHM` routing. GP's work machine runs the same full harness minus personal information, and a notes-directory workflow ("pick up this work" pointed at collaborative and meeting notes) has had no problems with the Algorithm mostly skipped.

A first take proposed cutting the Algorithm to ~80 lines. It was reviewed by seven models across six vendor families (Gemini 3.8 Flash, GPT-6 Luna, DeepSeek V4 Pro 0813, GLM-5.3, Devstral 2512, Inkling, Kimi K2.6). Six of seven corrected it: a model ignoring the spec is evidence that enforcement is broken, not that the ideas are obsolete. Raw reviews: `MEMORY/WORK/20260923-algorithm-v8-harness-first/panel-*.md`.

## Decision

Keep the doctrine, move enforcement into hooks, delete the choreography.

**Kept in v8, verbatim where it matters:** ISC granularity rule and splitting test, ID-stability, inline-verification probe table, forbidden-language list, Rule 1 live-probe table, Rule 2 advisor, Rule 2a Cato via direct Bash with its verdict table, Rule 3 two-re-call cap, reproduce-first table, learning router, context recovery.

**Changed:**
- Criteria are written only when "done" has a nameable probe. A lightweight Goal / Criteria / Decisions file may live in a project's own notes directory.
- The scope gate's four questions become one `## Decisions` entry, not a visible block.
- Reproduce-first gains an explicit skip when reproduction is unsafe or impossible, logged.
- Effort tiers survive only as routing and time budget, keyed to the routed model. Cheaper models get more injected scaffolding (`PAI/ALGORITHM/model-scaffolds.yaml`).
- The classifier's fail-safe no longer routes to ALGORITHM E2.

**Deleted from the prompt:** the E1–E5 thinking and delegation floors, the closed capability enumeration and capability-name audit, ISC count floors, phase headers and phase narration, the INTENT ECHO block, the OBSERVE completion-token ceremony, the mandatory parallelism scan block, the stop-the-line closing block and its non-negotiable format rules, the capability-selection block.

**Moved to hooks (gated on `LATEST` ≥ 8):** a one-line completion breadcrumb (slug, timestamp, version) replacing the model-written reflection row, outcome-based observe gate (criteria have named probes), verify lint (no `[x]` without evidence before `phase: complete`), resume-time scope questions.

**Moved to on-demand scaffolds:** parallelism scan, deliverable manifest, intent restatement, premortem, preflight gates, advisor cadence. Injected per routed model class rather than mandated for all.

## Consequences

- The stop-the-line block had no downstream parser. `SatisfactionCapture`, `RelationshipMemory`, and `TabState` match `SUMMARY:` with a colon, which only the MINIMAL template in `CLAUDE.md` produces. Verified by regex test 2026-09-23.
- Two parts of `CLAUDE.md` contradict v8 and must be rewritten in the same change that flips `LATEST`. The MODES section instructs obeying the MODE line and reading the Algorithm first. The Critical Rule "Scope gate before ISCs at E2+ OBSERVE" instructs INTENT ECHO, a visible `🌡️ SCOPE GATE` block, and tier exemptions. Replacement text for both: `MEMORY/WORK/20260923-algorithm-v8-harness-first/claude-md-modes-v8.staged.md`.
- "High-stakes," which gates Rules 2 and 2a, is defined by a probe in v8: effort `deep`/`comprehensive`, or changes to `CLAUDE.md`, `PAI/ALGORITHM/`, `hooks/`, `settings.json`, or content leaving `~/.claude`.
- Model routing policy (which model for which task, automatic subagent and tool routing) is a separate ISA. Hooks cannot switch the main session model.

## Rollback

Write `7.1.1` to `PAI/ALGORITHM/LATEST`. All v8 hook behavior is gated on it, so this one write restores v7 behavior.
