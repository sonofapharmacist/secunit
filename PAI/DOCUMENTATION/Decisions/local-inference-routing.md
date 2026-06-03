---
name: local-inference-routing
title: "Added: Local-first inference routing layer"
date: 2026-05-31
status: complete
detected: manual
change: "Local inference routing layer built on top of upstream Inference.ts"
---

## Decision

Built a complete local-first inference routing layer on top of Claude Code: `Inference.ts` (24 commits, substantially rewritten for this fork) with warmth-aware routing, `inference-routing.yaml` (tier manifest mapping model names to fast/standard/smart tiers), `skill-routing.yaml` (per-skill backend overrides), automatic fallback to Claude on local failure or rate limits, and latency logging per invocation. Routes to any OpenAI-compatible backend — Ollama, llama.cpp, llama-server, LM Studio. Added benefit: `BenchmarkLocalModels.ts` and `QualityTestModels.ts` provide reusable tooling to measure throughput and output quality across any configured endpoint before committing a model to a tier, giving the routing layer an evidence base rather than a guess.

## Alternatives Rejected

Claude API only: cost ceiling at scale, no local hardware leverage. With V100s and capable local models available, routing sub-tasks locally is a meaningful cost and latency lever.

Static model assignment: doesn't account for cold-start penalty. A model already loaded in memory is materially faster than a cold load; warmth-aware routing routes to already-loaded models to avoid the hit.

Per-skill manual invocation: requires an explicit routing decision at every call. The routing layer makes tier selection automatic from context — fast/standard/smart maps to the task tier without intervention.

## Evidence

`Inference.ts` received 24 commits — the upstream file existed as a scaffold; the routing architecture (warmth tracking, per-GPU host keys, skill-level overrides, llama-server migration, `/no_think` injection for qwen3 models, latency logging) is entirely this fork's work. The benchmark tooling produces measurable throughput and quality numbers that make tier assignment defensible rather than estimated.

## Consequences

Local models handle sub-tasks at specific tiers; Claude remains the orchestrator for Algorithm execution, DA identity, and skill routing; `inference-routing.yaml` and `skill-routing.yaml` are the configuration contracts; latency baselines from `BenchmarkLocalModels.ts` must be populated before tier assignment is reliable; `PAI_PREFER_LOCAL_HOST` env override exists for forcing a specific backend.
