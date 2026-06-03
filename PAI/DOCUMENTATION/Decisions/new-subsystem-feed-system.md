---
name: new-subsystem-feed-system
title: "Added subsystem: Feed System — knowledge acquisition pipeline"
date: 2026-05-31
status: complete
detected: new-subsystem
change: "New subsystem \"Feed system\" added to Subsystem Reference"
---

## Decision

Added a knowledge acquisition layer that did not exist in upstream PAI: `TLDRCatchup.ts` (cron orchestrator), `TLDRHarvest.ts` (profile-scored article ingestion), `KnowledgeHarvester.ts` extended with agy backend and `--url` harvest mode, `SessionHarvester.ts` for mining prior session artifacts, and `KnowledgeGraphLib.ts` (wholly new) for typed graph-enhanced retrieval with wikilink traversal.

## Alternatives Rejected

Manual reading without pipeline automation: information consumed doesn't surface at OBSERVE. Reading is wasted if it never becomes retrievable session context.

RSS readers without PAI integration: information stays in a separate tool, never enters the BM25 index, never surfaces automatically during Algorithm OBSERVE.

Semantic embedding retrieval: DCI (arXiv:2605.05242) found BM25+grep outperforms semantic embeddings by 16 points for agentic retrieval at bounded corpus sizes, at lower cost and with no external API dependency. Lexical-first is the validated choice for this corpus scale.

## Evidence

GBrain (Tan 2026) found +31.4pt precision improvement from graph extraction on a comparable corpus scale, validating the `KnowledgeGraphLib.ts` typed graph layer. The feed pipeline turns daily reading into ambient OBSERVE context — the backlog surfaces automatically, not via manual paste. `KnowledgeGraphLib.ts` did not exist at initial commit.

## Consequences

Feed ingestion follows the cron → TLDRCatchup → `tldr-suggestions.md` → `PROJECTS_TODO.md` → TLDRHarvest → `KNOWLEDGE/TLDR/` pipeline; new feed sources are added to `TLDRHarvest.ts`; `KnowledgeGraphLib.ts` is the canonical graph layer and requires `[[wikilink]]` syntax in notes to build live graph edges.
