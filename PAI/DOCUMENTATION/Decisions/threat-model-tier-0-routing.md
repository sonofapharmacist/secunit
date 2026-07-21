---
name: threat-model-tier-0-routing
title: "Adopted: Kimi K2.6 as alternate Tier-0 threat-model sec-planner (Opus 4.8 primary)"
date: 2026-07-08
status: complete
detected: manual
change: "PAI threat-model routing promoted Kimi K2.6 from generic Tier-1 cloud model to alternate Tier-0 sec-planner; Opus 4.8 stays primary; cost-conscious and Opus-blindsport-checked runs route to Kimi. Updated 2026-07-09: extended routing table with Cohere, Devstral Med, DeepSeek V4 Flash (Tier-1) and mistral-small-3.1-24b (Tier-1.5 local) after the 32-slot full sweep."
---

## Decision

After the 16-slot Project 1 threat-model sweep (`PAI/MEMORY/KNOWLEDGE/Research/threat-model-bench-2026-07-08.md`), Kimi K2.6 (`moonshotai/kimi-k2.6` via OpenRouter) is adopted as PAI's **alternate** Tier-0 sec-planner. **Opus 4.8** stays primary. Sonnet 5 / Haiku 4.5 are the workhorse / workhorse-cheap for general (non-security-class) workloads.

**Update 2026-07-09:** the same research file was extended with a follow-up sweep (Cohere direct, Mistral-direct rerun, 12 local V100 models, DeepSeek V4 Flash) — 32 slots total, 28 scored. The Tier-0 verdict (Opus 4.8 primary, Kimi K2.6 alternate) is unchanged; the extension adds three new Tier-1 entries and the first-ever local-tier PAI 2/3 result. Routing table below reflects the full 32-slot dataset.

**Routing table (canonical, 32-slot dataset):**

| Slot | Model | Tier | Latency | Cost | Use |
|------|-------|------|---------|------|-----|
| primary | `claude-opus-4-8` | Tier-0 | 83s | $0.071 | Default sec-planner. Best PAI-specific accuracy (3/3) at lowest cost of frontier-class models. |
| **alternate** | **`moonshotai/kimi-k2.6`** | **Tier-0** | **180s** | **$0.103** | **Cost-conscious runs; Opus-blind-spot cross-check.** |
| cheap_T1 | `MiniMax/MiniMax-M3` | Tier-1 | 88s | $0.098 | Fast + capable; ties GLM-5.1 + Cohere at 8.16/10, PAI 2/3. |
| cheap_T1_alt | `z-ai/glm-5.1` | Tier-1 | 111s | $0.083 | Cheap Chinese alternative; use when M3 has a specific failure. |
| cheap_T1_alt2 | `command-a-plus-05-2026` (Cohere direct) | Tier-1 | 98s | $0.139 | **Added 2026-07-09.** Ties m3/GLM-5.1 at 8.16/10, PAI 2/3. Cohere's chat API doesn't expose `north-mini-code` yet — this is their flagship instead. Use when OpenRouter + Mistral-direct quotas are both exhausted. |
| cheap_T1_native | `devstral-medium-latest` (Mistral direct) | Tier-1 | 47s | $0.052 | **Added 2026-07-09.** 8.04/10, PAI 2/3 — cheapest Tier-1 slot in the whole sweep, ~32% of gpt-5.4's cost for the same PAI-specific score. |
| cheap_T1_router | `deepseek/deepseek-v4-flash` (OpenRouter/SiliconFlow) | Tier-1 | 61s | $0.054 | **Added 2026-07-09.** 8.04/10, PAI 2/3 — second-cheapest Tier-1. Confirmed live on SiliconFlow (earlier "endpoint may be dead" suspicion was unrelated NIM-specific). |
| **cheap_T1_local** | **`mistral-small-3.1-24b`** (your-inference-host V100, direct) | **Tier-1.5 local** | **38s** | **$0 (electricity)** | **Added 2026-07-09 — the local-tier finding.** 7.35/10, PAI 2/3, the **only local model of 12 tested** to clear the PAI-specific discriminator; 11/12 local models (incl. prod champ Qwen3-30B-A3B at 5.86/10, PAI 0/3) fail security-class reasoning even when they score well on the general unified bench. Route routine/offline threat-model work here when budget is zero and cloud isn't available — do not expect quorum-grade output. |
| workhorse | `claude-sonnet-5` | Tier-2 | 94s | $0.124 | Non-security general workhorse; PAI-specific 1/3 (avoid for sec-class). |
| workhorse_cheap | `claude-haiku-4-5` | Tier-2 | 112s | $0.122 | Same plan to workhorse; for budget burn. |
| avoid | `claude-sonnet-4-6` | Tier-2 | 204s | $0.131 | Slow + PAI-specific 0/3. |
| avoid | `claude-fable-5` | Tier-4 | ≥60s | wrapper | Thin wrapper, served by Opus 4.8 via `server-side-fallback-2026-06-01`. Don't route security work. |
| avoid_local | `qwen3:30b-a3b` (your-inference-host prod champ) | Tier-1.5 local | 58s | $0 | **Added 2026-07-09.** 5.86/10, PAI 0/3 — scores below every cloud model in the top-15 despite being the strongest local model on the general unified bench (42/53). Security-class reasoning is a distinct local-tier weakness from general capability; do not assume unified-bench rank predicts threat-model fitness. |

## Why Kimi K2.6 (not just Opus 4.8)

Opus 4.8 won on **scoring alone** — 9.28/10 vs Kimi's 9.34/10 they are within noise (Δ=0.06). The decision to add Kimi as alternate is structural, not numeric:

1. **Two distinct failure modes covered.** Kimi landed `meta_prompt_injection` (referenced the prep doc as a separate adversarial surface — Opus missed this) and `audit_trail_gap` (flagged the absence of gen-time attribution as a finding even though it was implicit in the manifest — Opus called it "covered" without naming it). PAI-specific 3/3 is load-bearing for both Opus and Kimi; run parity between them is high.
2. **Cost-efficient at $0.103.** Opus 4.8 at $0.071 is cheaper, but Kimi's price is in the same band as Tier-1 ($0.083-0.124) — viable for a *second* opinion without changing the budget class.
3. **Independent training pipeline.** Kimi K2.6 is MoonshotAI v.s. Anthropic. Cross-check value scales with independence. Two vendors on the same plan beats one vendor twice.
4. **Already wired in Anvil.** `AnvilProgress.ts` lists Kimi K2.6 as a default NIM slot per `reference_openrouter_models.md`; the audit adversarial auditor can be Kimi-routed already. Promoting to sec-planner formalizes a path that exists.
5. **Quorum rule.** When Opus and Kimi disagree on a finding, escalate to a third model (Sonnet 5 or Haiku 4.5 as tiebreaker at effort `low`). When they agree, the finding is durable.

## Why not make Kimi primary

- Latency 180s vs 83s (2.2× slower). For interactive threat-modeling during a planning session, the Opus path is faster.
- Cost 1.45× higher ($0.103 vs $0.071).
- Quorum with Opus at the same plan-quality tier is more valuable than running Kimi alone.
- PAI-specific 3/3 ties Opus — no differentiation at the discriminator level.

## What landed

1. `PAI/USER/Config/inference-routing.yaml`:
   - `kimi-k2.6:cloud` entry upgraded from generic `tier: smart` to include `role_sec_planner: alternate` with `role_sec_planner_use_when` (cost_sensitive_runs / opus_4_8_unavailable / cross_check_against_opus_blind_spots) and `role_sec_planner_excluded_when` (latency < 120s, non-OpenAI thinking-budget semantics).
2. `PAI/MEMORY/KNOWLEDGE/Research/threat-model-bench-2026-07-08.md`:
   - Routing-posture table at top of document; §3 contains the full decision rationale.
3. `PAI/TOOLS/FreeTierEvals/threat_model_bench.ts` kimiK26 slot already in `ROSTER` (line 430). No harness change required.
4. `PAI/TOOLS/AnvilProgress.ts` kimi slot already NIM-routed (`reference_openrouter_models.md`).

## Alternatives Rejected

**Make Kimi primary.** Doesn't beat Opus on latency or cost, and Opus already has the demonstrated PAI-specific accuracy track record. Kimi's blind-spot-finding edge is real but doesn't justify a flip.

**Drop Opus entirely.** Removes the latency/cost win and adds dependency on a single Chinese-training-pipeline model for security-class work. Quorum value is gone.

**Add a third primary (Sonnet 5).** Sonnet 5 is PAI-specific 1/3 — it doesn't have the discriminator to be primary for security work. Wrong slot for the role.

**Route Opus through Fable 5.** Already closed in `inference-tier-fable.md` ADR. Fable 5 list price 2× Opus 4.8 for the same Opus fallback work.

**Run a 3-way quorum (Opus + Kimi + Sonnet 5) on every threat-model pass.** Cost ≈ $0.071 + $0.103 + $0.124 = $0.298 per pass. Adding Sonnet 5 buys a 1/3 discriminator; the marginal info value vs cost is negative. Skip.

## Evidence

- Full 32-slot sweep results (three runs): `PAI/TOOLS/FreeTierEvals/threat_model_bench_results/threat_model_bench_2026-07-08T19-43-30*.json` + local/Cohere/DeepSeek-Flash follow-up files (2026-07-09).
- Full write-up: `PAI/MEMORY/KNOWLEDGE/Research/threat-model-bench-2026-07-08.md` (§6 covers the Cohere + local V100 addendum).
- Cross-reference from the canonical model-routing doc: `PAI/MEMORY/KNOWLEDGE/Research/pai-model-tiers-unified-2026-06.md`, Tier 4 — Specialized Tools.
- Fable ADR (closes the only adjacent option): `PAI/DOCUMENTATION/Decisions/inference-tier-fable.md`.

## Consequences

- Plan-audit slots for security-class work now have a documented alternate; PAI workflows that hit a 429 or refusal on Opus 4.8 should route to Kimi, not Sonnet 5.
- The two-model quorum (Opus + Kimi) becomes the recommended pattern for finding arbitration, not just budget-fallback.
- Discovery of additional Tier-0 sec-planner candidates (e.g., a future Mistral-native direct that scores 3/3 PAI-specific) would extend this ADR as a sibling, not replace it.
- **2026-07-09 addendum:** three new Tier-1 slots (Cohere command-a-plus, Devstral Med, DeepSeek V4 Flash) give PAI provider redundancy across five surfaces (Anthropic, OpenRouter, Mistral-direct, Cohere-direct, local) for threat-model work — no single provider outage blocks the whole pipeline. The local-tier finding (`mistral-small-3.1-24b` is the sole PAI-2/3 local model) establishes that **general unified-bench rank does not predict threat-model fitness** — the prod champ (`qwen3:30b-a3b`, 42/53 unified) scores worst-in-class here (5.86/10, PAI 0/3). Any future local-model promotion to production must be re-validated against the threat-model suite separately, not assumed from unified-bench rank.
