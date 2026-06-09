---
name: new-subsystem-memory-system
title: "Extended subsystem: Memory System — graph layer and Projects domain"
date: 2026-05-31
status: complete
detected: new-subsystem
change: "New subsystem \"Memory system\" added to Subsystem Reference"
---

## Decision

Extended the upstream memory system with three additions: `KnowledgeGraphLib.ts` (new typed graph layer with wikilink traversal, not present at initial commit), Projects as a first-class retrieval domain added to the DOMAINS arrays in `MemoryRetriever.ts`, `KnowledgeGraph.ts`, and `KnowledgeGraphLib.ts`, and an agy-backend harvest path in `KnowledgeHarvester.ts`. The upstream system had People, Companies, Ideas, Research domains; active project state was not retrievable.

## Alternatives Rejected

Flat `PROJECTS_TODO.md` as the project state store: not BM25-scoreable, not graph-traversable, accumulates until it's too large to excerpt and gets manually grepped session by session. That was the documented failure mode before the Projects domain was added.

Separate project management tool: breaks the single-surface retrieval model. OBSERVE would need to consult multiple systems; automatic context surfacing becomes impossible.

## Evidence

Active project notes absent from retrieval meant GP had to re-explain project state each session — context that should have been ambient wasn't. After the Projects domain addition, project context surfaces automatically at OBSERVE from structured `KNOWLEDGE/Projects/` files. GBrain (Tan 2026) found +31.4pt precision improvement from graph extraction on a comparable corpus scale, validating the `KnowledgeGraphLib.ts` layer.

## Consequences

New retrieval domains are a one-line addition to three DOMAINS arrays (MemoryRetriever.ts, KnowledgeGraphLib.ts, KnowledgeGraph.ts); project notes follow the `title:` + `tags:` + `## Context` + `## Related` wikilink contract; the graph layer requires `[[wikilink]]` syntax in notes to build live traversable edges.
