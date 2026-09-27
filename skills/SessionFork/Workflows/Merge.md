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
### Step 2 — Read the fork tracking file and Conclude artifact

Load `MEMORY/WORK/{parent_slug}/_forks/{fork_slug}.json` and `{fork_slug}.conclude.md`. Abort if `status` is not `concluded` — Merge only operates on completed Conclude artifacts, never on an open fork's raw transcript.

### Step 3 — Determine the merge destination

- If `parent_isa_path` is set: append to that ISA's `## Decisions` (always) and `## Changelog` (if the Conclude artifact's Refuted-by field is non-trivial — i.e., something was actually refuted, which is Changelog-worthy per the ISA's own C/R/L contract).
- If no `parent_isa_path`: there is no file to append to, so the merge target is **whichever session is running this Merge invocation right now** — surface the Conclude artifact's content directly in that session's response, prefixed with the provenance tag (`[from fork {fork_slug}]:`). This is a one-shot action, not a durable write — idempotency for repeated invocations is handled entirely at Step 6a, not here.

**No-ISA branch: cross-process reality.** Be precise about what surfacing "in this session's response" does and doesn't do: it enters *this* session's transcript as a single dense turn. **It does not reach any other session automatically.** If Merge is being run inside the forked session itself (the common case — Conclude/Merge typically happen where the detour's work lives), the distillation lands in the fork's own context, not the original parent's. There is no cross-process channel that pushes it back — the fork and its parent are separate `claude` processes, same reason `Agent()`'s in-process dispatch and `--fork-session`'s process-launch boundary are different mechanisms (see `Fork.md` Step 5). If the user's actual goal is getting this content into the *original parent session*, they must carry it there themselves — see Step 7's guidance on relaying it.

#### Step 3a — Same-parent detection (no-ISA branch only)

Within the no-ISA branch, before deciding how much of the Conclude artifact to surface, check whether this Merge invocation is running in the *exact same process* as the fork's recorded parent — not a guess, a literal string comparison:

```
same_parent = (env.CLAUDE_CODE_SESSION_ID == tracking_json.parent_session_id)
```

This check belongs here, at Merge-invocation time, not inside `Conclude`. `Conclude` always runs inside the forked process — its own `CLAUDE_CODE_SESSION_ID` is structurally never equal to `parent_session_id` (that's the whole reason the fork exists), so a same-process check has no meaningful place to live until something reads the artifact back. Merge is that something.

- **Match** (`same_parent = true`): the reader is the exact parent session that spawned this fork and already holds everything discussed before the fork happened. Proceed to Step 4's **delta mode**.
- **No match, missing field, or `CLAUDE_CODE_SESSION_ID` unreadable**: treat as a cold or unconfirmable reader. Proceed to Step 4's **full mode** — today's existing behavior, unchanged. **Ambiguity always resolves to full mode, never to delta mode.** A false "cold reader" costs the parent a longer read; a false "known reader" silently drops context the reader doesn't actually have — the two mistakes are not equally costly, so the fallback direction is fixed, not a coin flip.

### Step 4 — Build the provenance-tagged append

**Two modes for the no-ISA branch, selected by Step 3a. The ISA-destination branch is unaffected — it always uses full mode, appending the Conclude artifact's complete C/R/L text as already documented below.**

#### Full mode (ISA branch always; no-ISA branch when `same_parent` is false or unconfirmed)

This is today's behavior, unchanged:

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

#### Delta mode (no-ISA branch only, `same_parent` confirmed true)

The reader is the exact parent session that spawned this fork — everything discussed before the
fork already exists in its transcript. Restating it is pure waste, the recompute-waste pole of
summarization rot (see `[[summarization-rot-two-poles]]` in the Knowledge archive if present).
Surface only what changed:

```markdown
[from fork {fork_slug}, same-session merge]:
{one or two sentences stating ONLY what is newly true that wasn't true before the fork — the
delta on Criterion-now, plus any Refuted-by/Learned content that is itself new information,
not a restatement of the fork's starting premise (which the parent already supplied when it
spawned the fork in the first place)}
```

Building the delta is a **subtraction from the full Conclude artifact, not a fresh rewrite**:
walk the artifact's four fields and drop any clause whose content the parent session's own
transcript already states — the fork's `fork_reason` (recorded in the tracking JSON, itself
usually lifted from something the parent said) is a reliable signal for what the parent already
knows going in. What's left after that subtraction is the delta. If, after subtraction, every
field is empty (the fork confirmed its starting premise and produced no new specifics), say that
plainly — "confirmed as expected, no new findings" — rather than manufacturing content to fill
the shape.

**The Anchor Rule still applies to delta mode.** Every claim retained after subtraction — the
things that ARE new — must carry a concrete anchor (quoted error/output, `file:line`, named
approach, or specific number), exactly as `Conclude.md`'s Anchor Rule already requires of the
source artifact. Delta mode is permitted to omit content the reader already has; it is never
permitted to state unanchored new claims. If a "new" claim has no anchor, that is a defect in
the underlying Conclude artifact, not license to assert it looser in the delta — go back to the
full Conclude artifact and find the anchor, or drop the claim.

**Delta mode never touches the on-disk Conclude artifact.** `{fork_slug}.conclude.md` stays
exactly as `Conclude` wrote it — full, self-contained, anchored, unconditionally. Delta mode is
something Merge derives at surface-time for *this specific reintegration*; the full artifact
remains on disk under `.archive/` after Step 6, available in full to any future reader who is
not the confirmed same parent.

### Step 5 — Apply or dry-run

If `dry_run: true`, emit the planned append and stop. Otherwise apply via Edit.

### Step 6 — Archive the fork

Move `{fork_slug}.json` and `{fork_slug}.conclude.md` to `MEMORY/WORK/{parent_slug}/_forks/.archive/`. Set `status: "merged"` before archiving. The archive is permanent — forensic value, same as ISA Reconcile's ephemeral archive.

**Step 6a — for the no-ISA case only:** since there's no destination file to check for a prior `[from fork {fork_slug}]` entry (Step 3's no-ISA branch), the archive step itself becomes the idempotency guard — once `status` flips to `"merged"` and the files move to `.archive/`, a second Merge attempt on the same `fork_slug` finds no `_forks/{fork_slug}.json` at the open location and can report "already merged" instead of silently re-surfacing the content. Check for the file's absence at the open path before treating a no-ISA merge as new work.

### Step 7 — Emit the report, then tell the user what to do next in plain language

```yaml
status: applied | dry_run | aborted
fork: {fork_slug}
destination: {parent_isa_path or "this session's context"}
merge_mode: full | delta | n/a (ISA branch)
same_parent: true | false | unconfirmed
decisions_added: 1
changelog_added: 0 | 1
archived_to: MEMORY/WORK/{parent_slug}/_forks/.archive/{fork_slug}.conclude.md
```

Beyond the structured report, close the loop for the human — don't leave them to ask "so what now?":

- **If this Merge ran in delta mode** (same-parent confirmed): say plainly that the full Conclude artifact is preserved at the archived path if they want the complete record — delta mode surfaced only the new facts because the reader (this session) already had the rest.
- **If this Merge ran in full mode inside the forked session** (no `parent_isa_path`, `same_parent` false or unconfirmed, merge target was this session's own context): say plainly that the distillation is now in *this* session's transcript, not the original parent's. If the user's goal was to bring it back to the parent, tell them how: reopen the parent session/terminal and paste the Conclude artifact's content (or reference its archived path — `MEMORY/WORK/{parent_slug}/_forks/.archive/{fork_slug}.conclude.md` — which they can point the parent session at directly, e.g. "read that file and fold it in").
- **If there is nothing further to do in this forked session**, say so explicitly: they can exit it now (`Ctrl+D`, `/exit`, or just close the terminal) — nothing more needs to happen here, since the Conclude and Merge artifacts are already persisted to disk under `.archive/` and survive the session closing.
- **If the fork still has other open work**, say that too — exiting isn't mandatory, only appropriate once the detour's purpose is fully spent.

## Failure modes

- **Fork status is not `concluded`:** abort. Merging an open fork means merging an incomplete or unvalidated distillation — run `Conclude` first.
- **Full-mode merge output is noticeably shorter than the Conclude artifact:** this means something was dropped during the append. Re-derive the append from the Conclude artifact's full text rather than proceeding. **This check does not apply to delta mode** — delta mode is deliberately, correctly shorter than the source artifact by design (Step 4's subtraction). Don't flag a well-formed delta as a lossiness failure; that conflates the two distinct rot poles this skill guards against (see `Conclude.md`'s Anchor Rule for the consolidation-loss pole, Step 3a/Step 4 delta mode for the recompute-waste pole).
- **Delta-mode output contains an unanchored "new" claim:** fails the Anchor Rule exactly as an unanchored Conclude field would. Re-derive from the full artifact and either find the anchor or drop the claim — do not surface an unanchored assertion just because it's short.
- **No `parent_isa_path` and the user is not in an interactive session to receive the surfaced content:** abort and ask where the conclusion should land — do not silently drop it.
- **`same_parent` detection is ambiguous (env var unreadable, tracking field missing) and the workflow defaults to delta mode anyway:** this is a bug, not an acceptable degradation — re-read Step 3a. Ambiguous must always resolve to full mode. If this happens, treat it as a defect in this workflow's own logic and fix the detection code path, not the individual merge.

## Idempotency

Like Reconcile, Merge should be safe to retry against the same fork if the first attempt was interrupted before Step 6 — check the destination for an existing `[from fork {fork_slug}]` entry before appending again. Delta mode's subtraction (Step 4) is deterministic given the same fork tracking JSON and Conclude artifact, so a retried delta-mode merge produces the same delta — no special-casing needed beyond the existing idempotency check.
