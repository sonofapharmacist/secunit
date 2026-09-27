---
name: new-subsystem-observability-system
title: "Added subsystem: Observability System — JSONL instrumentation layer"
date: 2026-05-31
status: complete
detected: new-subsystem
change: "New subsystem \"Observability system\" added to Subsystem Reference"
---

## Decision

Instrumented PAI with a JSONL-based observability layer: tool activity, tool failures, prompt classification decisions, and satisfaction signals all logged to `MEMORY/OBSERVABILITY/`. The upstream hooks existed as infrastructure; the discipline of using them as an evidence base for system changes — and the tripwires that act on them — is this fork's addition.

## Alternatives Rejected

Intuition-based system changes: the upstream approach. Changes were made based on felt experience, not counted failures. This is how a 8.59% fail-safe rate goes undetected until it's been running for weeks.

Database logging: JSONL is grep-able and jq-queryable with zero tooling overhead. A single `jq` query surfaces the fail-safe rate; a database requires a schema, a connection, and a query interface before you can ask the first question.

## Evidence

The observability data produced the specific numbers that justified v7.0.0: 146 failure events in May 2026, 8.59% fail-safe rate above the 5% tripwire, `within_budget: true` self-reports on sessions where violations were caught after the fact. None of those numbers were felt; all were counted. The v7.0.0 reliability release was built on this data — without the instrumentation, the failure modes were invisible.

## Consequences

Tripwires are set: >3 fail-safe events per session or >5% weekly triggers a revert review of fail-safe routing. Mode-classifier.jsonl audit cadence is weekly. The observability layer is the evidence base for future Algorithm changes — any proposed change should cite log data, not intuition.
