# Merge Workflow

Reintegrate a concluded fork's distillation into the parent session's context or parent ISA. Mirrors ISA `Reconcile`'s "verbatim append with provenance prefix" discipline — Merge does not summarize the Conclude artifact further.

## When to invoke

- A fork has been concluded (`Conclude` has produced a valid C/R/L artifact) and is ready to be brought back into the parent thread.

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| fork_slug | yes | The fork's tracking slug |
| dry_run | no | Default false. If true, report the planned append without writing. |

## Procedure

### Step 1 — Voice notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the Merge workflow in the SessionFork skill"}' \
  > /dev/null 2>&1 &
```

### Step 2 — Read the fork tracking file and Conclude artifact

Load `MEMORY/WORK/{parent_slug}/_forks/{fork_slug}.json` and `{fork_slug}.conclude.md`. Abort if `status` is not `concluded` — Merge only operates on completed Conclude artifacts, never on an open fork's raw transcript.

### Step 3 — Determine the merge destination

- If `parent_isa_path` is set: append to that ISA's `## Decisions` (always) and `## Changelog` (if the Conclude artifact's Refuted-by field is non-trivial — i.e., something was actually refuted, which is Changelog-worthy per the ISA's own C/R/L contract).
- If no `parent_isa_path`: there is no file to append to, so the merge target is **the live conversation itself, this turn** — surface the Conclude artifact's full content directly in the response to the user, prefixed with the provenance tag (`[from fork {fork_slug}]:`), so it enters the parent session's context as a single dense turn rather than the user having to go read a file. This is a one-shot action, not a durable write — there is nothing on disk to check for idempotency (see Step 6a below), so if Merge is invoked twice for the same no-ISA fork, the artifact is simply surfaced again; the caller (not this workflow) is responsible for not re-invoking Merge redundantly in that case.

### Step 4 — Build the provenance-tagged append

For the ISA-destination case, mirror Reconcile's exact prefix convention:

```markdown
- {ISO-8601} [from fork {fork_slug}]: {Conjectured, condensed to one clause} — {Criterion now}
```

in Decisions, and for Changelog (only if something was refuted):

```markdown
- [surfaced in fork {fork_slug}]:
  - conjectured: {full text from Conclude artifact}
  - refuted by: {full text from Conclude artifact}
  - learned: {full text from Conclude artifact}
  - criterion now: {full text from Conclude artifact}
```

**Do not condense the Changelog entry.** The Decisions-log line above is a pointer/summary by design (Decisions entries are always terse); the Changelog entry must carry the Conclude artifact's full C/R/L text verbatim. If you find yourself shortening the Changelog fields to make the entry "read better," stop — that's the exact lossiness this skill exists to prevent.

### Step 5 — Apply or dry-run

If `dry_run: true`, emit the planned append and stop. Otherwise apply via Edit.

### Step 6 — Archive the fork

Move `{fork_slug}.json` and `{fork_slug}.conclude.md` to `MEMORY/WORK/{parent_slug}/_forks/.archive/`. Set `status: "merged"` before archiving. The archive is permanent — forensic value, same as ISA Reconcile's ephemeral archive.

**Step 6a — for the no-ISA case only:** since there's no destination file to check for a prior `[from fork {fork_slug}]` entry (Step 3's no-ISA branch), the archive step itself becomes the idempotency guard — once `status` flips to `"merged"` and the files move to `.archive/`, a second Merge attempt on the same `fork_slug` finds no `_forks/{fork_slug}.json` at the open location and can report "already merged" instead of silently re-surfacing the content. Check for the file's absence at the open path before treating a no-ISA merge as new work.

### Step 7 — Emit the report

```yaml
status: applied | dry_run | aborted
fork: {fork_slug}
destination: {parent_isa_path or "session context"}
decisions_added: 1
changelog_added: 0 | 1
archived_to: MEMORY/WORK/{parent_slug}/_forks/.archive/{fork_slug}.conclude.md
```

## Failure modes

- **Fork status is not `concluded`:** abort. Merging an open fork means merging an incomplete or unvalidated distillation — run `Conclude` first.
- **Merge output is noticeably shorter than the Conclude artifact:** this means something was dropped during the append. Re-derive the append from the Conclude artifact's full text rather than proceeding.
- **No `parent_isa_path` and the user is not in an interactive session to receive the surfaced content:** abort and ask where the conclusion should land — do not silently drop it.

## Idempotency

Like Reconcile, Merge should be safe to retry against the same fork if the first attempt was interrupted before Step 6 — check the destination for an existing `[from fork {fork_slug}]` entry before appending again.
