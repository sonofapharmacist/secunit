---
name: new-subsystem-kohnfelder-framework-cia-stride-dread-patterns-sdr
title: "Added subsystem: Kohnfelder framework (CIA, STRIDE, DREAD, patterns, SDR)"
date: 2026-05-31
status: complete
detected: new-subsystem
change: "New subsystem \"Kohnfelder framework (CIA, STRIDE, DREAD, patterns, SDR)\" added to Subsystem Reference"
---

## Decision

Added the Kohnfelder security framework — CIA gold standard, Four Questions, STRIDE, DREAD, 15 design patterns + 4 anti-patterns, SDR process — as a PAI knowledge subsystem with a retrieval-indexed reference file. Reflects a security consultant's daily toolset; this is the vocabulary used in threat modeling, design reviews, and client engagements.

## Alternatives Rejected

Rely on model training data for framework knowledge: inconsistent recall of specific DREAD scoring weights and pattern names under session load. The framework is precise enough that imprecision matters — a misremembered STRIDE category or wrong DREAD axis produces wrong threat models.

Always-loaded CLAUDE.md context: too large for startup; reference material burns tokens every session even when not doing security work. Better served by on-demand BM25 retrieval that surfaces only when security design queries land at OBSERVE.

## Evidence

Security consulting work, client SDRs, and threat modeling require consistent framework vocabulary. MemoryRetriever surfaces the Research file automatically on security design queries; the full synthesis in auto-memory covers Ch 6+7 for architectural decisions. Having the framework indexed means it surfaces without explicit loading — it becomes ambient context for security work the same way project state surfaces for project work.

## Consequences

Security design queries during OBSERVE trigger automatic Kohnfelder retrieval; the framework vocabulary (STRIDE categories, DREAD axes, the 15 patterns) is available without manual loading; the full synthesis file is the reference for deep architectural SDR work.
