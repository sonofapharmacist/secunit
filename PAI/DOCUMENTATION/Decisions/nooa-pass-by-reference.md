---
name: nooa-pass-by-reference
title: "Deferred: NOOA pass-by-reference evaluation — not adopting; PoC threshold is a PAI-side cache-hit demonstration"
date: 2026-08-06
status: deferred
detected: manual
change: "Recorded the NOOA pass-by-reference economics from NVIDIA Labs' 2026-07-27 blog post; deferred adoption/PoC until a PAI-side cache-hit demonstration unblocks the question."
---

## Decision

**No code or routing change today.** Defer the question of whether NOOA-style pass-by-reference (live Python variables instead of text-serialized tool results) and its append-only, cache-valid transcript shape should shape PAI's orchestration layer. The intervening decision goes here, not in `inference-routing.yaml` or any skill config, because the right answer depends on a measurement that has not been made on a PAI workload.

The Decision is **defer, not reject**. Rejecting requires evidence NOOA's mechanism fails on PAI's shape. Deferring is correct because the cost evidence in the source material is compelling and cannot be dismissed without measurement.

## Why this is interesting

NVIDIA's NOOA blog post (`PAI/MEMORY/KNOWLEDGE/Research/nvidia-nooa-six-agent-capabilities-2026-07.md`) claims **parity or better, at roughly half the cost** on SWE-bench Verified:

- NOOA + GPT-5.5: 82.2% at ~29 calls / ~1.1M tokens/task (above published SOTA 79.2%)
- Comparison A (not NOOA): 78.2% at 66 calls / 2.2M tokens
- Comparison B (not NOOA): 78.6% at 29 calls / 1.3M tokens
- Median session peak 22–72k prompt tokens against 200–400k context windows

Two mechanisms drive this:

1. **Pass by reference.** Tool results become live Python variables composed directly in code, not round-tripped through the context window as text. The model sees a typed, bounded preview; the full value stays live in the execution environment.

2. **No context compaction on SWE-bench with frontier models.** Because tool results pass by reference and aren't serialized into the context window, transcripts stay append-only and cache-valid throughout the session. No summarization pass is needed. Prefill cache hits compound across the full task.

This second mechanism is the load-bearing one for PAI. The PAI orchestration layer — Algorithm phases, hook handlers, subagent transcripts — runs through Claude Code and produces JSON-tool-call transcripts that *are* serialized into context. PAI has invested in compactors, distillations (MemoryRetriever, WorkCompletionLearning), and KV-cache hacks. The NOOA claim, if portable to Claude Code, would remove a structural source of session-cost growth that those systems are designed to manage.

## Why not adopt now

Three reasons, in priority order.

1. **NOOA is a Python framework, PAI is TypeScript + Claude Code native.** NOOA's surface — `class Foo(Agent): def bar(...) ...` with docstrings-as-prompts and type annotations as enforced contracts — does not map to Claude Code's hook/skill/subagent topology. Wholesale adoption means rewriting the orchestration layer. Wholesale adoption is also out of scope per the source material: NOOA is labeled an "open-source research preview," explicitly not a replacement for existing harnesses.

2. **The 253-line generalist claim is fragile.** The SWE-bench 82.2% is from a "general-purpose 253-line agent, no benchmark-specific prompts." Generality is the strongest open-source argument and the most under-validated. PAI shapes its workload (multi-session ISCs, long-horizon research, hook-driven Phase discipline) differently from SWE-bench Verified. A NOOA-port that wins on SWE-bench may not move PAI's session economics.

3. **The cost claim assumes the full cache-valid proposition.** NOOA's 1.1M tokens/task is achieved because prefill cache hits compound across the full task — no compaction, no summarization pass, transcript stays append-only. PAI's transcripts today do not have this property: hook handlers transform state, Phase transitions emit deliverable structures, WorkCompletionLearning writes back. Until PAI measures its own cache-hit rates on a long-ISC session, the "halve cost" estimate is an upper bound that may or may not survive contact with the real workload.

## What would change this decision

A PAI-side PoC that measures **two numbers** on a representative long-ISC session (any session that runs through ≥3 Algorithm phases):

- **Effective cache-hit rate by turn**, measured against the same content recomputed fresh. This is the PoC answer to "is the cache-valid shape actually preserved when the orchestration layer mutates state between calls?" — the load-bearing claim from the source material.
- **Token cost per turn**, with and without a single compaction event (a Mid-ISC summary pass, a Phase boundary, or a hook transformation that rewrites context). This measures whether existing PAI compaction infrastructure earns its keep.

The threshold for moving this ADR from `deferred` to `consider-poc`:

- **Cache hit rate ≥ 70% by turn** across a 3-phase session: the NOOA mechanism is plausibly portable; greenlight a 2-week PoC to design a TypeScript variant or select an existing library.
- **Cache hit rate < 70%**: the mechanism is harness-specific and does not transfer; close the ADR with a `rejected (measurement: cache-valid shape is framework-coupled)` note in a follow-up ADR.
- **Compaction passes save < 30% of session tokens**: PAI's existing compactors are noise relative to the architecture cost they introduce; greenlight a structural rewrite.
- **Compaction passes save ≥ 30% of session tokens**: PAI's compactors earn their keep; keep the deferred decision and route follow-up to infrastructure hardening, not architecture.

The measurement is concrete enough to plan, small enough to do in an afternoon, and grounded in source material claims I do not yet believe enough to act on without.

## Alternatives Rejected

**Adopt NOOA wholesale.** Rejected: NOOA is research preview, not production-ready; the Python framework doesn't map to PAI's TypeScript + Claude Code topology; the cost claim has not been validated on a PAI-shaped workload.

**Adopt NOOA inspiration as a PAI design goal.** Rejected-via-deferral: writing a "PAI should be more like NOOA" ADR is philosophy without measurement. The PoC threshold above is the right amount of investment before locking a direction.

**Replace PAI's compaction infrastructure now.** Rejected: the existing compactors (MemoryRetriever, WorkCompletionLearning, KnowledgeHarvester) earn their keep in concrete ways — those systems are load-bearing for cross-session state, not just for session-internal context economics. Modifying them on the strength of a research-preview blog post is the wrong lever.

**Route Algorithm + skill execution through NOOA as a Python subprocess.** Rejected: the surface area is enormous (every Python class becomes an integration point), the model-portability claim is unsupported, and the failure mode is a silent bypass of every cache-validity claim once a Python object needs to cross back into a Claude Code call.

## Cross-cutting ADR implications

- **Pairs with `local-inference-routing.md`.** That ADR locked in a local-first routing layer built on Inference.ts (24 commits). This ADR is orthogonal — it concerns *session shape* (call structure, transcript economics), not model routing. A future revised routing table does not invalidate the NOOA thesis, and the NOOA thesis does not imply routing changes.

- **Distinct from `threat-model-tier-0-routing.md`.** That decision added Kimi K2.6 as alternate Tier-0 sec-planner; it concerns *which model* gets called. This ADR concerns *how the call transcript is shaped*. Same orchestrator, different optimization surface.

- **Distinct from `inference-tier-fable.md` and other ALGORITHM-tier ADRs.** Those concern model selection and prompt posture. This ADR is about the runtime substrate that wraps every model call.

## Evidence

- Source: NVIDIA Technical Blog, "Six Agent Harness Capabilities for Higher Model Performance," Cabral & Furgale, 2026-07-27, https://developer.nvidia.com/blog/six-agent-harness-capabilities-for-higher-model-performance/.
- Companion repo: `github.com/nvidia-nemo/labs-OO-Agents` (research preview, not production).
- Companion arxiv: `arxiv.org/abs/2607.20709` (full technical report; cite this when blog claims need corroboration).
- Companion paper: `arxiv.org/abs/2605.09650` (DreamTeam, referenced in blog).
- PAI research entry: `PAI/MEMORY/KNOWLEDGE/Research/nvidia-nooa-six-agent-capabilities-2026-07.md`.
- Related PAI ADRs: `threat-model-tier-0-routing.md` (model selection), `local-inference-routing.md` (routing infrastructure).

## Consequences

- The "halve session cost" estimate is locked as a **measured target**, not a foregone conclusion. No PAI infrastructure changes are made on the strength of the NOOA source material until the PoC threshold above clears.
- A new agent team will *not* route Algorithm or skill execution through NOOA; the integration surface is too large and the evidence is too partial.
- The next conversation that surfaces harness-transcript economics should pick up this ADR and either (a) run the measurement, (b) extend the threshold, or (c) close the ADR as `rejected` with a measurement note.
- If a follow-up PoC clears the threshold, this ADR is *not* the place to record the adoption decision — fork a sibling ADR so the deferred vs considered decision history stays separately auditable.
