---
name: algorithm-version-v7.1.0
title: "Algorithm version bumped to v7.1.0 — Stub surface, silent internals"
date: 2026-05-31
status: complete
detected: algorithm-version
change: "Algorithm version changed from v7.0.0 to v7.1.0"
---

## Decision

Bumped Algorithm from v7.0.0 to v7.1.0 to codify "stub surface, silent internals" — Algorithm entry emits exactly one line (`♻︎ PAI v7.1.0 → [8-word task name]`); ISA state surfaces only via direct file Read, never AI-generated narration.

## Alternatives Rejected

Encode as a CLAUDE.md operational note: lower authority, doesn't survive context compaction as reliably as doctrine embedded in the version file itself.

Leave as informal convention: the narration was producing embedded AI-generated "facts" that subsequent turns trusted without re-reading the source file. Any fabricated ISC count or phase label became ground truth.

## Evidence

Field observation: Algorithm entry was generating verbose ISA status summaries ("ISA recovered. N ISCs, M/N complete, phase: observe") before beginning work. The narration is AI-generated, not file-read — fabrications embed as apparent ground truth that future turns trust without re-verification. The same state information at zero risk comes from surfacing the raw file Read.

## Consequences

One-line entry stub at all tiers and effort levels; ISA state must come from Read tool output only; AI paraphrase of ISA state is explicitly banned in the doctrine. Rolling back to v7.0.0 restores verbose entry narration.
