---
name: threat-model-tier-0-routing
title: "Adopted: Kimi K2.6 as alternate Tier-0 threat-model sec-planner (Opus 4.8 primary)"
date: 2026-07-08
status: complete
detected: manual
change: "PAI threat-model routing promoted Kimi K2.6 from generic Tier-1 cloud model to alternate Tier-0 sec-planner; Opus 4.8 stays primary; cost-conscious and Opus-blindsport-checked runs route to Kimi. Updated 2026-07-09: extended routing table with Cohere, Devstral Med, DeepSeek V4 Flash (Tier-1) and mistral-small-3.1-24b (Tier-1.5 local) after the 32-slot full sweep. Updated 2026-08-08: added Meituan LongCat 2.0 as a second Tier-0 alternate (9.28/10, PAI 3/3, cheaper and faster than Kimi); GPT-5.6 Luna benched and rejected (PAI 1/3) — reconfirms unified-bench rank doesn't predict threat-model fitness."
---

## Decision

After the 16-slot Project 1 threat-model sweep (`PAI/MEMORY/KNOWLEDGE/Research/threat-model-bench-2026-07-08.md`), Kimi K2.6 (`moonshotai/kimi-k2.6` via OpenRouter) is adopted as PAI's **alternate** Tier-0 sec-planner. **Opus 4.8** stays primary. Sonnet 5 / Haiku 4.5 are the workhorse / workhorse-cheap for general (non-security-class) workloads.

**Update 2026-07-09:** the same research file was extended with a follow-up sweep (Cohere direct, Mistral-direct rerun, 12 local V100 models, DeepSeek V4 Flash) — 32 slots total, 28 scored. The Tier-0 verdict (Opus 4.8 primary, Kimi K2.6 alternate) is unchanged; the extension adds three new Tier-1 entries and the first-ever local-tier PAI 2/3 result. Routing table below reflects the full 32-slot dataset.

**Update 2026-08-08:** two OpenRouter promo-priced models added post-hoc and benched against the same rubric (`threat-model-bench-2026-07-08.md` §8). **Meituan LongCat 2.0 scores 9.28/10, PAI 3/3** — ties Opus 4.8's score exactly, beats Kimi K2.6 on both cost ($0.073 vs $0.103) and latency (126s vs 180s). Promoted to **second Tier-0 alternate**, sibling to Kimi per the extension clause in Consequences below. **GPT-5.6 Luna scores 6.86/10, PAI 1/3** — despite being the cheapest OpenAI-family model ever unified-benched (48/53 general suite), it fails the security-class discriminator. Stays off this table; **DEFER** for threat-model work, same disposition as the local `qwen3:30b-a3b` case (strong general score, weak PAI-specific reasoning).

**Routing table (canonical, updated 2026-08-08):**

| Slot | Model | Tier | Latency | Cost | Use |
|------|-------|------|---------|------|-----|
| primary | `claude-opus-4-8` | Tier-0 | 83s | $0.071 | Default sec-planner. Best PAI-specific accuracy (3/3) at lowest cost of frontier-class models. |
| alternate | `moonshotai/kimi-k2.6` | Tier-0 | 180s | $0.103 | Cost-conscious runs; Opus-blind-spot cross-check. Independent (MoonshotAI) training pipeline. |
| **alternate_2** | **`meituan/longcat-2.0`** | **Tier-0** | **126s** | **$0.073** | **Added 2026-08-08.** Cheapest and fastest of the three Tier-0 slots. Independent (Meituan) training pipeline — third distinct vendor in the quorum pool. Real PAI-specific findings: Hermes untrusted-chat-to-Bash bridging, Cato false-all-clear trickability, cross-session memory-write poisoning. |
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

## Why LongCat 2.0 as a second alternate (2026-08-08)

1. **Ties Opus 4.8 on score, beats Kimi on cost and latency.** 9.28/10 vs Opus's 9.28/10 (exact tie) and Kimi's 9.34/10 (within noise). At $0.073/126s, LongCat is cheaper and faster than Kimi ($0.103/180s) — it doesn't just add a third opinion, it's a *better-priced* Kimi-equivalent.
2. **Third independent training pipeline.** Opus = Anthropic, Kimi = MoonshotAI, LongCat = Meituan. Three distinct vendors now cover the quorum pool — cross-check value keeps scaling with independence per the same logic that justified Kimi.
3. **Real PAI-specific findings, not just a passing score.** LongCat named concrete PAI mechanisms unprompted: Hermes bridging untrusted external chat into Munro's high-trust Bash/Gmail/Drive context, Cato being trickable into a false all-clear (undermines maker-never-grader), and cross-session memory-write poisoning via MEMORY/KNOWLEDGE re-execution. Same caliber as the findings that qualified Kimi in the original sweep.
4. **Confirms rather than complicates the existing rule.** Same eval batch also benched GPT-5.6 Luna, which scored well on the general unified suite (48/53) but only PAI 1/3 here — reinforcing "unified-bench rank does not predict threat-model fitness" (already established by the `qwen3:30b-a3b` local finding, Consequences below). LongCat's high unified score (51/53) turning into a genuine 3/3 is the exception that required verification, not an assumption.

## Why not make Kimi or LongCat primary

- Both add latency over Opus (126-180s vs 83s) — the Opus path stays fastest for interactive threat-modeling during a planning session.
- Both cost more than Opus ($0.073-0.103 vs $0.071).
- Quorum with Opus at the same plan-quality tier is more valuable than replacing it; PAI-specific 3/3 ties Opus on both — no differentiation at the discriminator level that would justify a primary-slot flip.
- Between Kimi and LongCat: no promotion of one over the other. They're kept as parallel alternates — pick by cost/latency preference (LongCat cheaper/faster) or vendor-diversity need (whichever hasn't been used recently in a quorum pass).

## What landed

1. `PAI/USER/Config/inference-routing.yaml`:
   - `kimi-k2.6:cloud` entry upgraded from generic `tier: smart` to include `role_sec_planner: alternate` with `role_sec_planner_use_when` (cost_sensitive_runs / opus_4_8_unavailable / cross_check_against_opus_blind_spots) and `role_sec_planner_excluded_when` (latency < 120s, non-OpenAI thinking-budget semantics).
   - **2026-08-08: `longcat-2.0:cloud` entry added, mirroring the same `role_sec_planner: alternate` structure.**
2. `PAI/MEMORY/KNOWLEDGE/Research/threat-model-bench-2026-07-08.md`:
   - Routing-posture table at top of document; §3 contains the full decision rationale. §8 (added 2026-08-08) covers the LongCat + Luna post-hoc results.
3. `PAI/TOOLS/FreeTierEvals/threat_model_bench.ts` kimiK26 slot already in `ROSTER` (line 430). `longcat2` and `luna56` slots added 2026-08-08.
4. `PAI/TOOLS/AnvilProgress.ts` — **2026-08-08: default model switched from `kimi-k2.6` to `meituan/longcat-2.0`.** `postMoonshot` now routes any non-`kimi-*` model string to OpenRouter automatically (prefix-based dispatch); Kimi K2.6 remains available via explicit `--model kimi-k2.6` override. See `agents/Anvil.md` for the persona update.

## Alternatives Rejected

**Make Kimi primary.** Doesn't beat Opus on latency or cost, and Opus already has the demonstrated PAI-specific accuracy track record. Kimi's blind-spot-finding edge is real but doesn't justify a flip.

**Drop Opus entirely.** Removes the latency/cost win and adds dependency on a single Chinese-training-pipeline model for security-class work. Quorum value is gone.

**Add a third primary (Sonnet 5).** Sonnet 5 is PAI-specific 1/3 — it doesn't have the discriminator to be primary for security work. Wrong slot for the role.

**Route Opus through Fable 5.** Already closed in `inference-tier-fable.md` ADR. Fable 5 list price 2× Opus 4.8 for the same Opus fallback work.

**Run a 3-way quorum (Opus + Kimi + Sonnet 5) on every threat-model pass.** Cost ≈ $0.071 + $0.103 + $0.124 = $0.298 per pass. Adding Sonnet 5 buys a 1/3 discriminator; the marginal info value vs cost is negative. Skip.

## Evidence

- Full 32-slot sweep results (three runs): `PAI/TOOLS/FreeTierEvals/threat_model_bench_results/threat_model_bench_2026-07-08T19-43-30*.json` + local/Cohere/DeepSeek-Flash follow-up files (2026-07-09).
- Full write-up: `PAI/MEMORY/KNOWLEDGE/Research/threat-model-bench-2026-07-08.md` (§6 covers the Cohere + local V100 addendum; §8 covers the 2026-08-08 LongCat + Luna post-hoc additions).
- LongCat 2.0 result: `PAI/TOOLS/FreeTierEvals/threat_model_bench_results/threat_model_bench_2026-08-04T17-37-38_longcat2.json`.
- GPT-5.6 Luna result (rejected): `PAI/TOOLS/FreeTierEvals/threat_model_bench_results/threat_model_bench_2026-08-08T15-40-14_luna56.json`.
- Cross-reference from the canonical model-routing doc: `PAI/MEMORY/KNOWLEDGE/Research/pai-model-tiers-unified-2026-06.md`, Tier 4 — Specialized Tools.
- Fable ADR (closes the only adjacent option): `PAI/DOCUMENTATION/Decisions/inference-tier-fable.md`.

## Consequences

- Plan-audit slots for security-class work now have two documented alternates; PAI workflows that hit a 429 or refusal on Opus 4.8 should route to Kimi K2.6 or LongCat 2.0, not Sonnet 5.
- The quorum pattern extends from two models to three: Opus + Kimi + LongCat, any two of which can arbitrate a finding without needing Sonnet 5 as tiebreaker. Cost of a full three-way pass: ~$0.071 + $0.103 + $0.073 = $0.247 — still cheaper than the rejected Opus+Kimi+Sonnet-5 quorum ($0.298) despite adding a third opinion, because LongCat undercuts Sonnet 5 on cost while clearing the discriminator Sonnet 5 fails.
- Discovery of additional Tier-0 sec-planner candidates (e.g., a future Mistral-native direct that scores 3/3 PAI-specific) would extend this ADR as a sibling, not replace it. LongCat 2.0 (2026-08-08) is the first realization of that clause.
- **2026-07-09 addendum:** three new Tier-1 slots (Cohere command-a-plus, Devstral Med, DeepSeek V4 Flash) give PAI provider redundancy across five surfaces (Anthropic, OpenRouter, Mistral-direct, Cohere-direct, local) for threat-model work — no single provider outage blocks the whole pipeline. The local-tier finding (`mistral-small-3.1-24b` is the sole PAI-2/3 local model) establishes that **general unified-bench rank does not predict threat-model fitness** — the prod champ (`qwen3:30b-a3b`, 42/53 unified) scores worst-in-class here (5.86/10, PAI 0/3). Any future local-model promotion to production must be re-validated against the threat-model suite separately, not assumed from unified-bench rank.
- **2026-08-08 addendum:** the unified-bench-doesn't-predict-fitness rule is reconfirmed a second time, now on a cloud frontier-tier model rather than a local one — GPT-5.6 Luna's 48/53 unified score did not carry over to PAI-specific reasoning (1/3). This is now a two-for-two pattern (local `qwen3:30b-a3b` + cloud `gpt-5.6-luna`) and should be treated as the default expectation, not a surprising exception, for any future candidate: **bench threat-model separately regardless of unified-bench rank, cloud or local.** Conversely, LongCat 2.0's unified strength (51/53) DID carry over (PAI 3/3) — high unified score is necessary-but-not-sufficient signal to justify running the threat-model bench, not a substitute for it.
- **2026-08-08: fully landed.** `inference-routing.yaml`'s `longcat-2.0:cloud` entry is in place (mirrors Kimi's `role_sec_planner: alternate` block) and Anvil's default model switched from `kimi-k2.6` to `meituan/longcat-2.0` in the same change — both the routing config and the code that consumes it are now consistent with this ADR's verdict.
