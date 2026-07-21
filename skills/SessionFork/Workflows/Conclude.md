# Conclude Workflow

Distill a forked session's work into a structured, non-lossy artifact. This is the workflow the whole skill exists to get right — a Conclude output that collapses to a plain verdict defeats the purpose of having forked in the first place.

## When to invoke

- A `SessionFork`-tagged branch has finished its investigation (or reached a natural stopping point) and is ready to be reintegrated via `Merge`.

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| fork_slug | yes | The fork's tracking slug from `Fork` |

## The C/R/L Contract (non-negotiable)

Modeled directly on the ISA skill's Changelog format (`~/.claude/skills/ISA/SKILL.md`, "Changelog format is non-negotiable" gotcha). Every Conclude artifact must contain all four fields. **A conclusion missing any field is not a valid Conclude output — do not emit it as complete.**

| Field | Content | If genuinely empty |
|-------|---------|---------------------|
| **Conjectured** | What the fork set out to test, try, or answer — the working hypothesis or approach at the start | Never empty — this is why the fork exists |
| **Refuted by** | What evidence, error, or dead end disproved the initial approach (or approaches, if more than one was tried) | If nothing was refuted (first approach worked cleanly), state that explicitly: "no refutation — first approach held" |
| **Learned** | The durable insight — what would change how this is approached next time, independent of the specific decision made | Never empty if any refutation occurred; if no refutation, may restate the conjecture as confirmed |
| **Criterion now** | The decision, code, or state that resulted — what's true now that wasn't true before the fork | Never empty — this is the fork's output |

**Anti-pattern to reject:** "Investigated X, decided to do Y." This is a verdict, not a conclusion — it has a Criterion-now but no Conjectured/Refuted-by/Learned. If the fork tried more than one approach, every rejected approach needs its own Refuted-by entry, not a single aggregated "other approaches didn't work."

## The Anchor Rule (mechanical, not a taste judgment)

Four headers with content is not the same as four headers with *preserved reasoning* — a field can be present and still be hollow ("tried a simpler approach first, didn't work, learned to be more careful"). Structural presence is checkable by a script; hollowness requires actually comparing the artifact against what happened, which is precisely the check a self-review tends to skip because the writer already believes their own summary.

So the check is not "reread and judge if it feels vague." It is: **every `Refuted by` and `Learned` field must contain at least one concrete anchor** — one of:

- a quoted error message, stack trace line, or command output
- a `file:line` reference
- the name of a specific rejected approach, library, or design (not "an alternative" — the actual thing)
- a specific number, threshold, or measured value that drove the decision

**A field with zero anchors fails this rule, full stop — rewrite it before Step 5, don't wave it through.** This is a pass/fail check, the same way ISA `Reconcile` treats a missing canonical header as an abort condition rather than a judgment call (`skills/ISA/Workflows/Reconcile.md`, "Missing canonical header on ephemeral: abort"). If the fork's actual work produced no anchor-able specifics for a field (genuinely nothing concrete happened), say that explicitly — "no specific error observed; approach was rejected on inspection alone" is itself an anchor-shaped statement, distinct from silently having no anchor at all.

## Procedure

### Step 1 — Voice notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the Conclude workflow in the SessionFork skill"}' \
  > /dev/null 2>&1 &
```

### Step 2 — Read the fork tracking file

The caller must already know `parent_slug` to locate this file (it was reported back at the end of `Fork`'s Step 6, or is recoverable by grepping `_forks/*.json` for `"fork_slug": "{fork_slug}"` under `MEMORY/WORK/` if lost). Load `MEMORY/WORK/{parent_slug}/_forks/{fork_slug}.json` and read `parent_slug`, `parent_session_id`, `parent_isa_path`, and `fork_reason` from its contents — don't re-derive any of these, the tracking file is authoritative per `Fork`'s "never re-derive downstream" rule.

### Step 3 — Reconstruct the C/R/L fields from the fork's actual work

Walk back through what the fork tried, in order. For each distinct approach: what was conjectured, what refuted it (or didn't), what was learned. Do not paraphrase away specifics — quote error messages, cite file:line, name the approach that failed and why, the same way an ISA Decisions entry would ("❌ DEAD END: Tried X — Y happened. Don't retry.").

### Step 4 — Write the Conclude artifact

`MEMORY/WORK/{parent_slug}/_forks/{fork_slug}.conclude.md`:

```markdown
# Fork Conclusion: {fork_slug}

**Fork reason:** {fork_reason}
**Concluded:** {ISO-8601}

## Conjectured
{what was tried, in order if multiple approaches}

## Refuted by
{what disproved each approach, or explicit "no refutation" statement}

## Learned
{durable insight, independent of the specific decision}

## Criterion now
{what's true now that wasn't true before the fork}
```

### Step 5 — Validate against the Anchor Rule

Re-read the written artifact field by field. For `Refuted by` and `Learned`, explicitly check off which anchor type (quoted error/output, file:line, named rejected approach, or specific number/threshold) each field contains — or confirm it carries the explicit "no anchor because X" statement. **A field with neither an anchor nor an explicit no-anchor statement fails validation; rewrite it before proceeding.** This is a checklist, not a vibe check — the point of the Anchor Rule is that it doesn't rely on the same reasoning that produced the summary to also judge the summary.

### Step 6 — Update fork tracking status

Set `"status": "concluded"` in the tracking JSON.

## Failure modes

- **All four headers present but `Refuted by` / `Learned` carry zero anchors and no explicit no-anchor statement:** fails Step 5's Anchor Rule. This passes a naive structural check (headers exist) but fails the actual intent (reasoning preserved). Re-derive from the fork's real transcript before proceeding — headers are not the goal, anchored reasoning is.
- **Fork tracking file missing:** abort — Conclude has no parent pointer to report back to without it. Do not proceed by guessing the parent.
- **Fork tracking file status is `"fork_failed"` or `"abandoned"`:** abort — there is nothing to conclude. Concluding a failed or abandoned fork produces a distillation of work that was never actually completed.
