# Example Session: Knowledge Ingest → Cross-Link → ISA Scaffold

> Captured 2026-07-15. A short, real (unedited) session showing PAI's Knowledge
> Archive and Algorithm working together end-to-end — not a scripted demo.

## What happened, in order

1. **GP pasted a bare URL** (`knowledge <url>`) for a 3Blue1Brown lesson on
   attention mechanisms. No further instruction given.
2. **Munro inferred intent from the `knowledge` prefix** and routed to the
   `Knowledge` skill's `ingest` workflow rather than `Research` or
   `ExtractWisdom` — the user named the destination, not the action.
3. The skill created a new seedling note in `KNOWLEDGE/Ideas/`, auto-selected
   "light mode" (word count under the 800-word auto-detect threshold, so the
   full index rebuild was skipped), and reported back in NATIVE format.
4. **GP pasted a second URL**, this time a Towards Data Science article on
   context rot in Claude Code. First skill invocation returned an empty
   "Ready when you are" — a silent no-op, not an error. Munro caught this by
   noticing the result didn't match the shape of a completed ingest, and
   retried with an explicit `url=` argument, which succeeded.
5. The second ingest **rippled cross-links into four existing notes**,
   including the attention-mechanism note from step 3 — the archive found a
   real conceptual connection (intrinsic rot ↔ softmax attention floor)
   without being told to look for one.
6. **GP asked two follow-up questions** ("how did that come up" / "what
   should I look into next") about a single detail buried in the ingest
   report: a "sessions as git branches" fork/`/conclude`/`/merge` pattern the
   source article proposed, which PAI has no named equivalent for.
7. Munro answered both in plain prose (no tool calls needed — the answer was
   already in context from the ingest), and proposed four concrete next
   steps rather than a vague "worth investigating further."
8. **GP asked to save the session as a demo AND scaffold an ISA** for the
   branch-methodology investigation. Two genuinely different deliverables in
   one sentence — a documentation case study (this file) and a work-tracking
   artifact (`MEMORY/WORK/session-branching-methodology-investigation/ISA.md`).

## Why this is a good showcase

- **Silent-failure recovery**: step 4 shows the system catching a no-op
  skill result instead of reporting false success — this is the exact
  failure mode ("assistant analyzed cluster instead of actually fixing it")
  flagged in recent learning signals, handled correctly here.
- **Emergent cross-linking**: the archive connected two unrelated URLs
  pasted minutes apart through actual conceptual overlap, not because either
  ingest call referenced the other.
- **Proportionate response**: a two-sentence follow-up question got a
  two-sentence-scale answer with a recommendation, not a re-run of the full
  ingest pipeline.
- **Correct artifact routing on a compound ask**: "save this as a demo, then
  ISA the next steps" was recognized as two distinct outputs needing two
  distinct homes (`DOCUMENTATION/Examples/` vs `MEMORY/WORK/*/ISA.md`)
  rather than being mashed into one file.

## Artifacts produced

- `PAI/MEMORY/KNOWLEDGE/Ideas/attention-mechanism-transformers-3blue1brown.md`
- `PAI/MEMORY/KNOWLEDGE/Ideas/governed-context-managing-context-rot-claude-code.md`
- `PAI/MEMORY/WORK/session-branching-methodology-investigation/ISA.md`
- This file

## Not included

No credentials, Tailscale hostnames, or personal identifiers appear in this
session — safe to reference in a secunit release if GP wants a public
walkthrough later. Not yet published externally; this file is documentation
only.
