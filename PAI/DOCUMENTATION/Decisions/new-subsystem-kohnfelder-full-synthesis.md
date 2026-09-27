---
name: new-subsystem-kohnfelder-full-synthesis
title: "Added subsystem: Kohnfelder full synthesis"
date: 2026-06-05
status: complete
detected: new-subsystem
change: "New subsystem \"Kohnfelder full synthesis\" added to Subsystem Reference"
---

## Decision

Migrated the Kohnfelder *Designing Secure Software* synthesis from auto-memory (session-start ambient context) into the PAI Knowledge Archive at `PAI/MEMORY/KNOWLEDGE/Research/designing-secure-software.md`. Registered it as a named subsystem entry in ARCHITECTURE_SUMMARY so it surfaces in retrieval context for security design queries.

## Alternatives Rejected

**Keep in auto-memory:** Auto-memory is ambient session-start context — loaded unconditionally every session. A 1,500-word research synthesis bloats every session's baseline context whether or not security work is happening. The Knowledge Archive retrieves on-demand via BM25 (MemoryRetriever), which is the right home for reference material.

**Leave as a flat research note with no subsystem registration:** The Kohnfelder framework (CIA, STRIDE, DREAD, threat patterns, SDR) is load-bearing for ASA architectural decisions and security design reviews. Registering it as a subsystem entry ensures it appears in the routing table and gets surfaced by context-aware lookups, not just ad-hoc searches.

## Evidence

- `PAI/MEMORY/KNOWLEDGE/Research/designing-secure-software.md` — full synthesis, BM25-indexed
- `ARCHITECTURE_SUMMARY.md` subsystem table entry added 2026-06-05
- Used as primary reference in ASA SDR design and NomShub/Miasma attack surface analysis sessions

## Consequences

- Kohnfelder framework retrieves automatically on security design and SDR queries via MemoryRetriever
- Zero baseline context cost when not doing security work
- Must remember to load explicitly on first ASA session if MemoryRetriever hasn't warmed yet
