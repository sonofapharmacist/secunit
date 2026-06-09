---
name: new-pipeline-domain-doc-integrity
title: "Added pipeline domain: Doc Integrity"
date: 2026-05-31
status: complete
detected: new-pipeline-domain
change: "New pipeline domain \"Doc Integrity\" added to Pipeline Topology"
---

## Decision

Added "Doc Integrity" as a distinct pipeline domain: `DocIntegrity.hook.ts` (Stop event) → `DocCrossRefIntegrity.ts` + `RebuildArchSummary.ts` → `ArchitectureSummaryGenerator.ts`. The handlers (`DocCrossRefIntegrity.ts`, `RebuildArchSummary.ts`) were written for this fork; `ArchitectureSummaryGenerator.ts` was extended to auto-stub ADRs on architectural threshold detection.

## Alternatives Rejected

Fold into the Hook pipeline: scope mismatch — this is architectural enforcement that fires at session end, not a lifecycle event handler. Grouping it with session-management hooks obscures its purpose.

Fold into Config pipeline: integrity checking is an output concern. It runs after work is done to catch inconsistencies before they're committed, not at configuration time.

## Evidence

Without the stop gate, sessions modifying architecture docs had no feedback loop — cross-reference drift was silent until it caused a downstream session failure. `DocCrossRefIntegrity.ts` and `RebuildArchSummary.ts` did not exist at initial commit; both were written for this fork. The ArchitectureSummaryGenerator ADR stub behavior is entirely this fork's work.

## Consequences

Architecture doc changes trigger ADR stub generation and summary rebuild at session end via `DocIntegrity.hook.ts`; `ArchitectureSummaryGenerator.ts` is the stub-writer and threshold detector; `release.ts` gates on unfilled stubs before push. When modifying any file in this pipeline, trace the full cascade: doc change → DocIntegrity fires → stubs generated → release gate checks them.
