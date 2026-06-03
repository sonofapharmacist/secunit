---
name: algorithm-version-v7.0.0
title: "Algorithm version bumped to v7.0.0 — Reliability over Ceremony"
date: 2026-05-24
status: complete
detected: manual
change: "Algorithm version changed from v6.3.0 to v7.0.0"
---

## Decision

Bumped Algorithm from v6.3.0 to v7.0.0 with six coordinated reliability changes: fail-safe routing to E2 (not E3) on classifier error; tier floor reductions (E3 thinking ≥4→≥1, ISC floor ≥32→≥16); ceremony elimination (EUPHORIC SURPRISE PREDICTION removed, voice curls removed from mandatory phase transitions); primacy repositioning of three most-violated CLAUDE.md rules to top 30 lines; mandatory `violations_self_reported` field in algorithm-reflections.jsonl; and chunked E2 execution with compaction between sessions.

## Alternatives Rejected

Incremental patches to v6.3.0: the failure modes were systemic and causally linked — fail-safe routing amplified ceremony, ceremony amplified phantom compliance, phantom compliance made failures invisible. All six changes needed to ship together.

Raising tier floors further: Jaroslawicz 2025 (arXiv 2507.11538) establishes a 68% compliance ceiling under high instruction density. Higher floors produce more phantom label compliance, not more genuine thinking.

## Evidence

Internal observability logged 146 failure events in May 2026, an 8.59% fail-safe rate above the 5% tripwire, and `within_budget: true` self-reports on sessions where violations were caught after the fact. The numbers were measurable only because the JSONL observability layer existed. The theoretical ceiling comes from Jaroslawicz 2025; the empirical confirmation came from the PAI observability data.

## Consequences

All sessions running v7.0.0+ route classifier errors to E2; E3 requires ≥1 deliberate thinking capability; EUPHORIC SURPRISE PREDICTION is permanently removed from the Algorithm output format; `violations_self_reported` is mandatory in reflections and `within_budget: true` alone is no longer sufficient for compliance. Tripwires set: >3 fail-safe events per session or >5% weekly triggers a revert review.
