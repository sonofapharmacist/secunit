---
name: SessionFork
description: "Fork the live interactive session into an isolated branch for a detour (debugging tangent, exploratory research, risky experiment), then reintegrate only a structured, non-lossy distillation of what was learned — never the raw transcript. Three workflows: Fork (tag and track a `--continue --fork-session` branch with a pointer back to the parent session), Conclude (distill the branch into a C/R/L-shaped artifact — conjectured / refuted-by / learned / criterion-now — modeled on the ISA Changelog contract; rejects plain-prose summaries that state only a verdict without the rejected alternatives and why), Merge (reintegrate the Conclude artifact into the parent session's context or parent ISA's Decisions/Changelog as a single provenance-tagged append, never a transcript dump). Core thesis: forking without disciplined conclusion recreates the exact content-rot problem it exists to solve — a lossy summary that discards dead-end reasoning looks like preserved context while actually laundering it away. USE WHEN fork session, fork this conversation, branch this investigation, isolate this detour, conclude the fork, merge the fork back, session branching, keep the main thread clean, spin off a sub-investigation without polluting context, --fork-session, session as git branch. NOT FOR spawning parallel background workers that don't need the parent transcript (use Agent/Agent Teams — see AgentSystem.md), merging a pre-scoped ISA ephemeral feature file (use ISA's Reconcile workflow), or general context pruning within a single session (use existing context-optimization guidance)."
effort: medium
---

## 🚨 MANDATORY: Voice Notification (REQUIRED BEFORE ANY ACTION)

**You MUST send this notification BEFORE doing anything else when this skill is invoked.**

1. **Send voice notification**:
   ```bash
   curl -s -X POST http://localhost:31337/notify \
     -H "Content-Type: application/json" \
     -d '{"message": "Running the WORKFLOWNAME workflow in the SessionFork skill"}' \
     > /dev/null 2>&1 &
   ```

2. **Output text notification**:
   ```
   Running the **WorkflowName** workflow in the **SessionFork** skill to ACTION...
   ```

**This is not optional. Execute this curl command immediately upon skill invocation.**

# SessionFork — Governed Session Branching

## Thesis

A session fork is only worth taking if what comes back is *smaller and truer* than what went in — never smaller and vaguer. Forking isolates a detour's noise from the main thread; reintegration is where that isolation either pays off or gets thrown away. A `Conclude` step that reduces a branch's work to a plain-prose verdict ("decided X, moved on") discards the one thing forking was supposed to preserve: *why* the alternatives were rejected. That information doesn't just become unavailable — it disappears while looking like it was captured, which is worse than never forking, because it launders lossy compression as diligence.

This skill's structural bet borrows one half of what the ISA skill already solved for a different artifact: `Reconcile` merges ephemeral feature files back into a master ISA via two mechanisms — deterministic ID-keyed checkbox reconciliation (no equivalent here; forks have no ISC IDs) and verbatim, provenance-tagged appends to Decisions/Changelog (the half this skill actually inherits). `Conclude`'s C/R/L requirement generalizes the *shape* of Reconcile's Changelog contract, not its ID-matching rigor. Enforcement here is a mechanical anchor-citation check (see `Conclude.md`'s Anchor Rule), not the deterministic abort-on-mismatch guarantee Reconcile gets from stable IDs — a real, narrower rigor, and the skill should not be read as inheriting more than that.

**Full origin and comparison against PAI's existing Agent-dispatch and ISA-Reconcile mechanisms:** `MEMORY/WORK/session-branching-methodology-investigation/ISA.md`. Read that ISA before extending this skill — it documents *why* the scope is this narrow and *why* Conclude is non-negotiable on the C/R/L shape.

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| "fork this session", "branch off this detour", "isolate this investigation" | `Workflows/Fork.md` |
| "conclude the fork", "distill this branch", "wrap up the detour" | `Workflows/Conclude.md` |
| "merge the fork back", "reintegrate", "bring the conclusion into the main thread" | `Workflows/Merge.md` |

## Quick Reference

- **Fork** checks for prior art in `MEMORY/KNOWLEDGE/` and existing ISAs before committing to a branch — if the detour's question is already answered, Fork reports the existing findings instead of forking at all. Once a fork is warranted, it tags a `--continue --fork-session` branch with a slug and a pointer back to the parent session (and parent ISA, if one exists) — the tracking convention plus the prior-art gate are the whole job; the actual forking is Claude Code's native primitive, not reimplemented here.
- **Conclude** is the load-bearing workflow. It refuses to emit a distillation that lacks all four of: what was conjectured, what refuted it, what was learned, what the decision/criterion is now. A conclusion missing any of the four is not a Conclude output — it's an unfinished one.
- **Merge** appends the Conclude artifact verbatim, with a provenance prefix (`[from fork <slug>]:`), into the parent's Decisions/Changelog or context. It does not summarize the Conclude artifact further — that would be re-introducing the exact lossiness Conclude was built to prevent.
- This skill does not replace Agent/Agent Teams for parallel work that doesn't need the parent's accumulated transcript — that's cheaper and is the default per `AgentSystem.md`'s "refuse to recompute" principle. SessionFork exists specifically for the case where the detour *does* need full situational inheritance from the live session before branching off.

## Gotchas

- **Forking preserves the transcript; Agent dispatch does not — don't blur these.** `Agent()` spawns a fresh-context worker from a constructed prompt (cheap, the PAI default). `Fork` inherits the entire live session's accumulated context (expensive, but sometimes necessary — e.g., a debugging tangent that needs everything discussed so far). Reach for Fork only when the detour genuinely can't be scoped into a pointer-based Agent prompt.
- **A structurally valid Conclude artifact can still be pointless if Fork skipped the prior-art check.** The Anchor Rule verifies that reasoning is grounded in specifics; it does not verify the fork needed to happen. An agent that fabricates a plausible-sounding investigation into something already answered in `MEMORY/KNOWLEDGE/` or a prior ISA will pass every downstream check while producing a worse result than just citing what's already known. Fork's Step 2 exists specifically to catch this before the fork starts.
- **A Conclude output missing any of the four C/R/L fields is invalid, not just weak.** Do not accept "we decided X" as a complete Conclude artifact. If there were no rejected alternatives, say so explicitly ("no alternatives were seriously considered") rather than omitting the field — omission reads as forgotten, not absent.
- **Merge never re-summarizes the Conclude artifact.** If Merge's output is shorter than Conclude's, something was dropped without a paper trail. The provenance-tagged append should be the same size as the Conclude artifact, just relocated.
- **This skill is not a replacement for ISA Reconcile.** Reconcile merges a pre-scoped ephemeral *feature file* (ISC-slice of a master ISA) back into that master — deterministic, ID-keyed, no session-forking involved. SessionFork operates one level up: on the *session* itself, before any ISA ephemeral-file mechanics come into play. If the thing being merged is an ISC checklist slice, use Reconcile. If it's a forked conversation's reasoning trail, use Merge.
- **Don't invoke this for every subagent dispatch.** If the task can be handed to a background `Agent()` with a well-scoped prompt (the common case), do that instead — it's cheaper and is PAI's stated default. SessionFork's cost (full transcript inheritance) is only justified when the detour needs the parent's exact situational context, not just a description of it.
- **`parent_slug` is derived, never invented free-form — see `Fork.md`'s dedicated section.** ISA-backed sessions key off the ISA's containing directory name; ISA-less sessions key off `_session-forks/{parent_session_id}`. `Fork` persists whichever was chosen into the tracking JSON precisely so `Conclude` and `Merge` never have to re-derive it and risk disagreeing.
- **Most forks are abandoned, not concluded — that's expected, not a bug.** A tracking file can sit at `status: "open"` indefinitely if the detour didn't produce anything worth reintegrating. Mark it `"abandoned"` explicitly rather than leaving ambiguous `"open"` state; see `Fork.md`'s Abandoned-fork lifecycle section.
