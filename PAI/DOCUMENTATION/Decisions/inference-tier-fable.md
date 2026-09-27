---
name: inference-tier-fable
title: "Added: Fable 5 as 4th Inference.ts tier (api-direct, fallback-aware)"
date: 2026-07-08
status: complete
detected: manual
change: "Inference.ts gets a 4th tier 'fable' (claude-fable-5 via Anthropic API direct); tier is honest surface but not a routing recommendation"
---

## Decision

Added a fourth tier `fable` to `Inference.ts`. Sits alongside the existing `fast | standard | smart` tiers and routes through the Anthropic API directly via `@anthropic-ai/sdk` rather than the Anthropic CLI subscription path. The Claude CLI does not expose Fable 5, Anthropic `betas`, or the `effort` output-config parameter — the API-direct path was the only way to wire it in.

**Concretely:**
- `LEVEL_CONFIG.fable = { model: 'claude-fable-5', defaultTimeout: 600000 }` (10-minute default — Fable at `xhigh` is the slow path).
- New exported helper `inferenceAnthropicApi()` that uses `client.beta.messages.create()` with `betas: ['server-side-fallback-2026-06-01']` and `fallbacks: [{ model: 'claude-opus-4-8' }]`. baseURL is pinned to `https://api.anthropic.com` to bypass any local LiteLLM/proxy allowlists.
- Anthropic API key resolves via `passage show api/anthropic` with 60s TTL cache (the local `ANTHROPIC_API_KEY` env var carried an OpenRouter-shaped key — `sk-or-v1-...` — that the Anthropic API rejected).
- Default effort is `xhigh`. Captured metadata per call: `apiModel`, `apiStopReason`, `stopDetailsCategory`, `apiIterations`, `apiInputTokens`, `apiOutputTokens`, `apiThinkingTokens`. All four surfaces that filter on tier name (`['fast','standard','smart']` lists × 4) updated to include `'fable'`.
- `tier-inference.ts`: `Tier` union and `VALID_TIERS` both extended to include `'fable'`.
- `USER/Config/inference-routing.yaml`: `claude-fable-5` entry registered under `tier: fable`, `preferred_host: anthropic-api`, base_url `https://api.anthropic.com/v1/messages`.
- `TOOLS/package.json`: added `@anthropic-ai/sdk@0.110.0`.

**Despite being wired, Fable 5 is not a routing recommendation.** Three evals agree it should not receive PAI work:

1. Unified bench 25/53, R5 = 0/2 (`claude-fable-5-unified-bench-2026-07`).
2. Project 1 head-to-head: Fable 5 wins on coverage + specificity + PAI-specific accuracy (10/10), but the planning call is served by `claude-opus-4-8` via `server-side-fallback-2026-06-01` because the `cyber` stop-category fires on threat-model-class prompts. The 10/10 win is Opus 4.8's plan, not Fable 5's.
3. The `cyber` category is structural — Fable 5 was retrained 2026-07-01 with stricter refusal routing and treats security-domain input as out-of-scope. The eval is a measurement of Opus 4.8 (not Fable 5) when the prompt lands on security-class work.

Routing posture going forward: the threat-model / plan-audit slot for security-class work routes to Opus 4.8 directly (via Inference.ts `standard` tier with model override, or a dedicated future `opus` tier). Fable 5 stays wired because the 4-stage job-packet pattern (cheap prep → frontier plan → cheap exec → fresh-context verify) is solid architecture and an honest Fable 5 stub keeps the surface aligned with the Anthropic model lineup.

## Alternatives Rejected

**Route Fable 5 to PAI security work via fallback.** Tempting because the eval shows Opus 4.8 winning — but routing through Fable 5 to "buy" Opus 4.8 costs more (Fable 5 list price is $10/$50 per MTok vs Opus 4.8 $5/$25) and adds refusal-classification latency we don't get billed for but do wait on. Direct Opus 4.8 is the same quality at half the price with no `cyber`-refusal risk path.

**Do not add the tier at all.** Rejected because (a) the wrapper *works* and the code path is non-trivial — leaving it on disk-out-of-tree loses the surface, and (b) some legitimate Fable 5 use cases exist (C8-style short coding where it scores 5/5 perfect on the unified bench; long-context document analysis where 1M ctx + always-on thinking is genuinely useful). Closing the door entirely would lose a real capability for narrow, non-security workloads.

**Use the Anthropic CLI subscription path with Fable 5 routing.** Doesn't work — Fable 5 access requires API-direct auth per the July 1 redeploy terms. CLI subscription path scrubs Fable 5 calls.

**Use OpenRouter-routed Fable 5.** Falls into the same `cyber` category as direct API; OpenRouter doesn't expose Anthropic betas; effort parameter requires Anthropic SDK shape. Not a viable wire path.

## Evidence

- **Inference.ts:** 227 line diff (2388-2581 region — dispatch branch in `_inferenceCore` for `level === 'fable'` + `inferenceAnthropicApi` function definition + key resolution helper).
- **Project 1 eval results:** `PAI/TOOLS/FreeTierEvals/threat_model_bench_results/threat_model_bench_2026-07-08T18-33-{50,51}{,_fable-5,_gpt-5.4,_haiku-4.5}.json`. Fable 5 served by `claude-opus-4-8`, all other slots served direct.
- **Routing verdict (durable):** `PAI/MEMORY/KNOWLEDGE/Research/claude-fable-5-ken-huang-10-weekend-security-projects-2026-07.md` §PAI Routing Verdict.
- **Unified bench base rate:** `PAI/MEMORY/KNOWLEDGE/Research/claude-fable-5-unified-bench-2026-07.md` (25/53; R5=0/2).
- **Eval source:** `PAI/TOOLS/FreeTierEvals/threat_model_bench.ts` (1415 lines; TypeScript port of Huang's `projects/01_threat_model/threat_model.py`).

## Consequences

- **Callers who want Fable 5 directly use `--level fable`.** Anthropic API key must be present in `passage show api/anthropic` (60s TTL cache); missing key surfaces a clear error message at the API-key check point in `inferenceAnthropicApi`.
- **The threat-model / plan-audit slot for security work routes Opus 4.8 direct** (via `--level standard --model claude-opus-4-8` until a dedicated `opus` tier lands, if it ever does). Don't route via Fable 5; you'll pay Fable 5 prices for Opus 4.8 work.
- **The job-packet pattern (cheap prep → frontier plan → cheap exec → fresh-context verify) is adopted** in PAI workflows. Frontier-model slot: Opus 4.8 (security-class) / Haiku 4.5 + gpt-5.4 tied (general, per `unified-bench-2026-06-16`).
- **Memory inference result schema changed.** All `InferenceResult` consumers now have access to `apiModel`, `apiStopReason`, `stopDetailsCategory`, `apiIterations`, `apiInputTokens`, `apiOutputTokens`, `apiThinkingTokens` — these are populated only on the fable (api-direct) path, but the schema is uniform. Other paths return `undefined` for these fields. Consumers building on fallback provenance should be ready for that.
- **Detection threshold.** This is a `manual` ADR because it doesn't trip the auto-stub detectors (no algorithm version bump, no new subsystem, no new pipeline domain). The cfg change to `inference-routing.yaml` and the tier-inference.ts union extension don't cross the 4-line / 20-line thresholds in `ArchitectureSummaryGenerator.ts:detectChanges` either. Surfaced for review by name-match only.
