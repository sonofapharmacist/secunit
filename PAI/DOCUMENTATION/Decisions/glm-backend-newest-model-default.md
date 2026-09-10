---
name: glm-backend-newest-model-default
title: "Adopted: glm.sh always defaults to Z.ai's newest GLM flagship (currently GLM-5.3)"
date: 2026-08-15
status: complete
detected: manual
change: "PAI/backends/glm.sh (canonical source) and ~/.claude/glm.sh (deployed copy) bumped ANTHROPIC_DEFAULT_SONNET_MODEL / ANTHROPIC_DEFAULT_OPUS_MODEL from glm-5.2 to glm-5.3. Established as a standing pattern, not a one-off edit: glm.sh's Sonnet/Opus slot tracks Z.ai's current flagship release, re-verified against PAI's own benches (unified-bench + threat-model-bench) before each bump, not applied on announcement alone."
---

## Decision

`glm.sh` — both the canonical source (`PAI/backends/glm.sh`) and the deployed copy (`~/.claude/glm.sh`) sourced directly by Claude Code sessions — defaults `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_OPUS_MODEL` to Z.ai's current flagship GLM model. As of 2026-08-15 that's **GLM-5.3**, up from GLM-5.2. `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` stay pinned to `glm-4.5-air` — the cheap-tier slot doesn't track the flagship bump.

This is now a standing maintenance pattern: **when Z.ai ships a new GLM flagship, `glm.sh`'s default is re-evaluated, not automatically bumped.** The gate is PAI's own bench data (unified-bench + threat-model-bench, per `PAI/TOOLS/FreeTierEvals/`), not the vendor's announcement or Z.ai's own server-side auto-routing (their devpack docs note that GLM-5.2/5.1 requests now auto-route to 5.3 server-side regardless of what PAI requests — glm.sh being explicit about the model string keeps the banner/docs honest even though the request would succeed either way).

## Why re-verify before each bump, not auto-track

1. **GLM-5.2 → GLM-5.3 was a net improvement, but not uniformly.** Threat-model-bench: GLM-5.2 scored 7.04/10 (PAI-specific 1/3, rank 13 of the 2026-07-08 sweep) — GLM-5.3 jumped to 9.00/10 (PAI 2/3, rank 3), a huge gain. But unified-bench C-battery (coding quality) is unstable on GLM-5.3: three standalone reruns landed 16/27, 9/27, 15/27 — real output variance, not infrastructure noise (confirmed no 503 retries, uniform latency). A flagship bump can improve one axis sharply while leaving another genuinely volatile; benching both before defaulting the interactive coding backend to it is the only way to catch that.
2. **Breaking API changes ride along with flagship bumps.** GLM-5.3 removed `thinking.type: "disabled"` entirely — any direct API caller (not just glm.sh) that assumed thinking could be turned off now gets HTTP 400 code 1210. This was only caught by actually calling the API during the bench work, not by reading the announcement. `glm.sh`'s banner comment now carries this caveat forward for anyone who reads the script before sourcing it.
3. **`glm.sh` is a general-purpose backend swap, not a benchmarked routing slot.** It's what a human sources to point an entire Claude Code session (all Algorithm phases, all built-in slash commands, ad-hoc chat) at Z.ai instead of Anthropic. That's a broader, less-controlled surface than a single named routing slot (e.g. Anvil's coding model, the threat-model sec-planner alternates) — it should track "best available from this vendor," re-confirmed each time, rather than silently drift or require the source to be re-diffed by hand to notice a stale default.

## Do we add GLM-5.3 to Anvil's roster?

**No, not on this data.** Two independent reasons, both grounded in the existing `threat-model-tier-0-routing` ADR's established pattern:

1. **Doesn't clear the Tier-0 quorum bar.** Anvil's threat-model quorum (Opus 4.8, Kimi K2.6, LongCat 2.0) all score ≥9.28/10 PAI-specific on threat-model-bench. GLM-5.3's 9.00/10 is genuinely strong — best Z.ai result to date, clear rank-3 — but sits with the Tier-1 cluster in spirit (m3/GLM-5.1/Cohere at 8.16, which GLM-5.3 now beats outright), not the quorum tier. Promoting a model into Anvil's default rotation is a higher bar than "beat its own predecessor."
2. **Anvil is a code producer; GLM-5.3's coding score is the volatile one.** The `threat-model-tier-0-routing` ADR already established, twice (GPT-5.6 Luna, `qwen3:30b-a3b`), that strong performance on one axis doesn't predict fitness on another — "bench separately, don't assume." GLM-5.3 is the inverse case: strong on threat-model reasoning (9.00/10), unstable on the coding battery Anvil actually exercises (9-16/27 across 3 runs, C2/C6 consistently failing). Routing Anvil's default coding role to a model with confirmed run-to-run coding-quality swings would be the exact mistake this ADR pattern exists to prevent.
3. **Vendor-diversity rationale doesn't apply here.** Anvil's quorum design (Anthropic + MoonshotAI + Meituan) is deliberately built so no single vendor's blind spots dominate the audit/planning role. Z.ai isn't currently a quorum vendor. Adding it would need its own justification pass (does Z.ai's blind-spot profile differ meaningfully from Meituan's, already in the pool?) — not a drive-by addition because glm.sh got bumped.

If a future GLM release clears threat-model-bench ≥9.28 **and** shows a stable (not just high-average) C-battery across multiple runs, that's the trigger to revisit Anvil's roster as a sibling decision — not this one.

## What landed

1. `PAI/backends/glm.sh` and `~/.claude/glm.sh`: `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` → `glm-5.3`. Banner echo updated with bench numbers (unified-bench 40/53, threat-model-bench 9.00/10) and the thinking-always-on caveat. `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` left at `glm-4.5-air` (unchanged).
2. `PAI/TOOLS/FreeTierEvals/threat_model_bench.ts` — new native `"zai"` provider (`callZai()`, `getZaiKey()`) added because GLM-5.3 isn't on OpenRouter yet (unlike every prior GLM slot in this file, which routes through OpenRouter). New `glm53` slot uses this path.
3. `PAI/TOOLS/FreeTierEvals/{anthropic_compat_eval.py, anthropic_compat_reasoning_probe.py, coding_battery.py, unified_bench.ts}` — GLM-5.3 wired in with the thinking-block fix (`thinking: {type: "enabled", budget_tokens: N}`, `max_tokens` padded by the same N).
4. `PAI/MEMORY/KNOWLEDGE/Research/glm-5-3-announcement-2026-08-14.md` — full bench writeup (unified-bench + threat-model-bench + harness-change notes).
5. `PAI/MEMORY/KNOWLEDGE/Research/pai-model-tiers-unified-2026-06.md` and `threat-model-bench-2026-07-08.md` — cross-linked entries, leaderboard updated (GLM-5.3 inserted at threat-model-bench rank 3).
6. Anvil's own default model (`meituan/longcat-2.0`, per `threat-model-tier-0-routing.md`) — **unchanged.** No GLM entry added to Anvil's roster.

## Alternatives Rejected

**Auto-bump glm.sh on every Z.ai release without re-benching.** Rejected — see GLM-5.2→5.3's uneven axis improvement above. A model string swap is cheap; a silently-degraded coding backend for interactive work is not.

**Leave glm.sh on GLM-5.2 since Z.ai auto-routes 5.2/5.1 requests to 5.3 server-side anyway.** Rejected — relying on undocumented vendor-side auto-routing behavior for PAI's own scripts is fragile (Z.ai could change or scope that routing at any time) and leaves the banner/docs lying about what model is actually being requested. Being explicit costs nothing.

**Add GLM-5.3 to Anvil now, since its threat-model score is close to the quorum tier.** Rejected per the reasoning above — the axis that matters for Anvil (coding stability) is exactly the one GLM-5.3 hasn't demonstrated yet.

## Evidence

- Full bench writeup: `PAI/MEMORY/KNOWLEDGE/Research/glm-5-3-announcement-2026-08-14.md`
- Threat-model-bench leaderboard (GLM-5.3 at rank 3): `PAI/MEMORY/KNOWLEDGE/Research/threat-model-bench-2026-07-08.md`
- Raw results: `PAI/TOOLS/FreeTierEvals/threat_model_bench_results/threat_model_bench_2026-08-15T17-10-24_glm53.json`, `PAI/MEMORY/WORK/2026-06-15-shell-fallback-deeper-tests/coding-batt-glm53.json` (overwritten per-run — 3 console-captured scores: 16/27, 9/27, 15/27)
- Prior Anvil vendor-diversity rationale (sibling ADR): `PAI/DOCUMENTATION/Decisions/threat-model-tier-0-routing.md`

## Consequences

- Sourcing `glm.sh` now puts a Claude Code session on GLM-5.3 for Sonnet/Opus-slot work by default. Anyone relying on the old GLM-5.2 default (e.g. a saved shell alias predating this change) should re-source.
- The re-verify-before-bump pattern means glm.sh's default can lag a Z.ai announcement by however long it takes to run both benches (unified-bench + threat-model-bench) — this is intentional friction, not an oversight.
- Anvil's roster is explicitly untouched by this change. Anyone reading `glm.sh`'s bump and assuming Anvil follows should be pointed at this ADR's "Do we add GLM-5.3 to Anvil's roster?" section.
- Future GLM flagship releases should repeat this same evidence-gate pattern: bench both suites, update this ADR (or its successor) with the new numbers, only then bump `glm.sh`.
