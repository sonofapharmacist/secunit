---
name: new-subsystem-prod-model-change-checklist
title: "Adopted: prod model changes follow a four-surface checklist, enforced by RoutingDriftCheck.ts"
date: 2026-09-16
status: complete
detected: new-subsystem
deciders: GP + Munro
change: "Local prod model swaps now follow DOCUMENTATION/Tools/ProdModelChangeProcedure.md and must end with a clean `bun PAI/TOOLS/RoutingDriftCheck.ts --quiet`. `active_params_b` becomes a declared field in inference-routing.yaml."
bench: `MEMORY/KNOWLEDGE/Research/dgx-spark-local-red-team-bench-2026-09.md` (prompted this ADR)
related: [local-inference-dual-model-fast-standard-tier-2026-08-14, threat-model-tier-0-routing, dgx-spark-local-red-team-bench-2026-09, reference_ubullm]
replaces: (none)
supersedes: (none)
---

# Prod model change checklist, enforced by a drift check

## Context

Ingesting Roei Sherman's DGX Spark red-team benchmark (33 open-weight models, two
GB10 units) surfaced a finding worth applying to our own bench harness: on
bandwidth-bound hardware, throughput tracks **active** parameters, not total. A 70B
dense model ran at 2.9 tok/s while a 35B sparse MoE hit 193–228 — a ~66× gap between
models under 2× apart in nominal size.

`BenchmarkLocalModels.ts` had no parameter field at all; model shape lived only in the
name string. Adding it meant touching `inference-routing.yaml`, which is where the
actual problem turned up.

**`qwen3_next_80b_a3b` — the production model since 2026-08-08 — was never declared in
`inference-routing.yaml`.** `Inference.ts` `getTierForModel()` (line ~175) could not
find it and fell back to a guessed tier on every call, announcing it on stderr where
nothing surfaced it. Because that alias serves *both* standard and smart tiers,
smart-tier calls (Advisor, commitment-boundary review) had been silently resolving as
standard for five weeks.

The cause is structural, and `Inference.ts` had already documented it against itself,
in the comment above `DEFAULT_FALLBACK_MODELS`:

> *"Keep this in sync manually; there's no single source of truth shared between the two."*

The 2026-08-08 migration updated `PAI_CONFIG.yaml` and that code default. It did not
update the routing manifest. Nothing detected the gap because nothing was looking.

## Decision

**A local prod model change is a four-surface operation, and drift between those
surfaces is now mechanically detectable.**

1. `USER/Config/inference-routing.yaml` — tier resolution (**the surface missed in August**)
2. `USER/Config/PAI_CONFIG.yaml` — live routing decision
3. `TOOLS/Inference.ts` `DEFAULT_FALLBACK_MODELS` — degraded path, used only when PAI_CONFIG fails to load
4. The systemd unit on your-inference-host — `llama-server.service` (:11434) or `llama-server-fast.service` (:11436)

Procedure lives at `DOCUMENTATION/Tools/ProdModelChangeProcedure.md`. Every swap ends
with `bun PAI/TOOLS/RoutingDriftCheck.ts --quiet` returning exit 0.

`RoutingDriftCheck.ts` compares what is *served* against what is *declared* across all
three config surfaces. Five checks: served-not-declared, referenced-not-declared,
duplicate keys, missing params (warn), unreachable host (note only — a powered-down box
is not drift).

**`active_params_b` is now a declared field**, not something inferred from a model name.
Dense models declare it equal to `total_params_b`.

## Alternatives Rejected

**A single source of truth shared by all surfaces.** The correct fix in the abstract,
and what the `Inference.ts` comment wishes for. Rejected for now: 15 code files read
`inference-routing.yaml`, and PAI_CONFIG's ollama block carries prose context that a
generated file would lose. Unifying them is a real refactor with real blast radius, and
the failure mode we actually had was *undetected* drift, not *unavoidable* drift.
Detection buys most of the safety for a fraction of the risk. Revisit if the manual sync
keeps breaking.

**A PreToolUse or Stop hook instead of a CLI check.** Rejected: model swaps are rare
and deliberate, not a per-tool-call hazard. A hook would run constantly to catch
something that happens a few times a year, and would need a live host probe to be
meaningful — that is a network call in a hook, which is the wrong place for one. A
checklist step that a human or agent runs at swap time fits the actual cadence.

**Inferring active params from the model name.** `A3B` in an alias is a strong hint, and
this was tempting because it required no yaml edits. Rejected: it is a naming convention,
not a contract. `gemma4:26b` is a 26B/4B MoE with no marker in the name, and
`Qwen3-Next-80B-A3B` and `qwen3:30b-a3b-q4_K_M` use different casing for the same idea. A
wrong active-param count is worse than a blank one, because the tok/s-per-active-B ratio
silently becomes nonsense.

**Leaving it manual and writing only the doc.** Rejected on evidence: the August
migration *had* a procedure in the form of institutional knowledge, and still missed a
surface. An unenforced checklist is a checklist that gets skipped under time pressure.

**Deleting the auto-generated stub rather than filling it.** The detector fired on a
documentation row being added to CLAUDE.md's table, so an argument exists that no
architectural decision occurred. Rejected: the decision is not the doc. It is making
drift detection mandatory and `active_params_b` a required field — a policy change with
an enforcement gate, which is exactly what an ADR is for.

## Evidence

**The drift itself.** `qwen3_next_80b_a3b` appeared in `inference-routing.yaml` only
inside a comment on line 32. Verified directly against the live manifest loader:

```
qwen3_next_80b_a3b                 *** NOT IN MANIFEST ***
jackrong_v4_pro_qwen35_9b_mtp      fast
qwen2.5-coder:7b                   *** NOT IN MANIFEST ***
```

Both production-routed models and the code-level fast fallback were absent.
`BenchmarkLocalModels.ts:207` skips any model not in baselines, so the harness had
never benched the prod model either.

**Active vs total params, measured locally.** tok/s per active billion params on
your-inference-host's dual-V100 pool, from figures already recorded in `inference-routing.yaml`:

| Shape | tok/s/active-B |
|---|---|
| Sparse MoE (30B/3B, 30.5B/3.3B) | 35.3, 36.4 |
| Sparse MoE (80B/3B — prod) | 26.3 |
| Dense (24B, 27B, 27B) | 1.0, 0.7, 0.2 |

A ~35× spread by architecture at comparable total size. This data was already present
and invisible, because nothing normalized against active params. It independently
reproduces Sherman's finding on different hardware (V100 HBM2 vs GB10's 273 GB/s
unified), which is why the effect is treated as architectural rather than a GB10 quirk.

**Live measurement of prod**, 3 runs + warmup, 2026-09-16: 809ms p50, 78 tok/s. Close
to the 86.2 tok/s sustained figure documented in
`MEMORY/WORK/2026-08-07-eval-plan-64gb-fits/`. Recorded in the manifest rather than
copied from a comment.

**The checker was verified against the real failure.** Deleting the prod entry and
re-running reproduced the August condition from both angles:

```
[served-not-declared]     qwen3_next_80b_a3b — served by YOUR_TAILSCALE_IP:11434 but has
                          no entry in inference-routing.yaml
[referenced-not-declared] qwen3_next_80b_a3b
```

**Corroborating source.** `MEMORY/KNOWLEDGE/Research/dgx-spark-local-red-team-bench-2026-09.md`.

## Consequences

**Good.**

- The August failure class is now a one-command check instead of a stderr line nobody reads.
- The bench harness ranks by the axis that governs throughput on this hardware. `PARAMS T/A` and `TOK/S/AB` columns, plus `tokPerSecPerActiveB` in saved JSON.
- Prod is declared, so `BenchmarkLocalModels.ts` can finally bench it (+2% drift against the new baseline).
- 53 of 63 distinct models carry param declarations (65 raw entries before the duplicate-key collapse described below).

**Costs and open items.**

- The sync is still manual. This ADR buys detection, not prevention — if someone swaps a model and skips the check, drift returns silently. That is an accepted trade, not a solved problem.
- `RoutingDriftCheck.ts` reports **three errors that remain unfixed**, all pre-existing:
  - `DEFAULT_FALLBACK_MODELS.fast` names `qwen2.5-coder:7b`, which is neither served nor declared; the real alias is `qwen2.5-coder:7b-instruct-q4_K_M`. Latent — only reachable if `PAI_CONFIG.yaml` fails to load. Repointing the fallback chain is a routing decision, deliberately left to GP.
  - `qwen3.6:27b` and `gemma4:26b` are each declared twice. `Map.set` means last-wins, so two blocks are dead config.
  - The duplicate keys cause the pre-existing `skill-routing.test.ts:92` failure (`gemma4:e4b-it-q4_K_M` asserts the losing tier). Verified to fail identically against the pre-change tree.
- 10 models still lack params: 6 cloud/hosted (where local bandwidth is not the constraint) and 4 whose shape is genuinely unknown (`gemma4:e4b` is a MatFormer variant; `qwen3-coder-next:latest` is an unpinned tag). Left blank deliberately — see the rejected alternative above.
- `--quiet` is required for automation. The unfiltered run emits a param warning per undeclared model, which buries the errors.
- **Host addressing is inconsistent and was nearly a trap.** `BenchmarkLocalModels.ts` defaults `--host` to `YOUR_TAILSCALE_IP`, which is **host1** (retired 2026-05-19). your-inference-host is `YOUR_TAILSCALE_IP`, per `BenchV100.sh` and `PAI_CONFIG.yaml`. Documented in the procedure; the default is left unchanged pending a decision on whether host1 stays referenced at all.
