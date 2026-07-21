# Fork Workflow

Tag and track a session branch. The forking mechanic itself is Claude Code's native `--continue --fork-session` — this workflow adds the naming/tracking convention that makes `Conclude` and `Merge` able to find their way back to the parent.

## When to invoke

- A detour (debugging tangent, exploratory research, risky experiment) needs the full accumulated context of the current live session, not just a description of it — otherwise prefer a background `Agent()` dispatch, which is cheaper (see `AgentSystem.md`, "refuse to recompute" principle).
- The user or Algorithm explicitly wants the main thread kept clean while the detour runs.

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| fork_reason | yes | One sentence: what this fork exists to investigate |
| parent_session_id | yes | The current session's identifier |
| parent_isa_path | no | If the parent session has an active ISA, its path — `Merge` will append there if present |

## Determining `parent_slug` (the tracking-directory key)

Every tracking file this workflow writes lives under a `{parent_slug}` directory. That slug is **derived, never invented free-form** — pick exactly one of the two cases before Step 4:

- **ISA-backed session** (`parent_isa_path` is set): `parent_slug` is the directory name immediately containing the ISA file — i.e., `MEMORY/WORK/{parent_slug}/ISA.md` → `parent_slug` is that path segment. Tracking files live at `MEMORY/WORK/{parent_slug}/_forks/`.
- **No ISA** (`parent_isa_path` is unset): there is no existing work directory to key off of, so mint one: `parent_slug = "_session-forks/{parent_session_id}"`. Tracking files live at `MEMORY/WORK/_session-forks/{parent_session_id}/_forks/`.

**Persist whichever `parent_slug` was determined into the tracking JSON** (Step 3) — `Conclude` and `Merge` read it back rather than re-deriving it, so the two workflows can never disagree with `Fork` about where the tracking file lives.

## Procedure

### Step 1 — Voice notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the Fork workflow in the SessionFork skill"}' \
  > /dev/null 2>&1 &
```

### Step 2 — Check for prior art before committing to the fork

A fork is only worth its cost if the detour actually needs fresh investigation. Before generating a slug, spend one targeted pass checking whether the answer already exists:

- Grep `MEMORY/KNOWLEDGE/` and prior `MEMORY/WORK/*/ISA.md` files for the fork's subject matter — the same "refuse to recompute" instinct `AgentSystem.md` applies to delegation applies here too.
- If prior art fully answers `fork_reason`: skip the fork entirely. Report the existing findings back (with file citations) instead of manufacturing a new investigation — a fabricated fork that ignores real, already-diagnosed answers is worse than no fork at all.
- If prior art is partial (answers some but not all of the question): proceed with the fork, but seed it with pointers to what's already known so the forked session isn't rediscovering it from scratch.
- If nothing relevant exists: proceed to Step 3 as normal.

This check is cheap (one grep pass) relative to the cost of a fork (full transcript inheritance) — skipping it risks producing a plausible-sounding but ungrounded conclusion when a real, cited answer was sitting in memory the whole time.

### Step 3 — Generate the fork slug

`YYYYMMDD-HHMMSS_<short-reason-slug>` — same convention as ISA `slug` fields, so forks sort and grep alongside other work artifacts.

### Step 4 — Write the fork tracking file

Create `MEMORY/WORK/{parent_slug}/_forks/{fork_slug}.json`, using the `parent_slug` determined above:

```json
{
  "fork_slug": "{fork_slug}",
  "parent_slug": "{parent_slug}",
  "parent_session_id": "{parent_session_id}",
  "parent_isa_path": "{parent_isa_path or null}",
  "fork_reason": "{fork_reason}",
  "created": "{ISO-8601}",
  "status": "open"
}
```

This is the pointer `Conclude` and `Merge` read to know where to reintegrate. Without it, a Conclude artifact has nowhere documented to merge back to. `parent_slug` is the field that makes the directory itself locatable — never re-derive it downstream; read it from this file.

If Step 2 found partial prior art, record it in the tracking file too — add a `prior_art` field listing the cited paths, so `Conclude` can distinguish what the fork actually discovered from what it inherited already-known.

### Step 5 — Invoke the native fork

Run `claude --continue --fork-session` (or the session's equivalent fork invocation). The forked session inherits the full parent transcript up to this point.

**If the native fork invocation fails** (non-zero exit, unsupported in this Claude Code version, etc.): set `"status": "fork_failed"` in the tracking file and report the failure — do not leave the tracking file at `"open"` for a fork that never actually happened, and do not proceed to hand a fork_slug to the user as if a working branch exists.

### Step 6 — Confirm

Report the fork slug and tracking file path back to the user. State explicitly what the fork exists to investigate (echo `fork_reason`) so the detour doesn't drift from its stated purpose.

## Abandoned-fork lifecycle

A fork that never reaches `Conclude` is the expected common case, not an edge case — most detours don't produce something worth reintegrating. Left alone, `status: "open"` tracking files accumulate silently, which is exactly the kind of unmanaged drift this skill exists to prevent elsewhere. Handle it explicitly:

- **Explicit abandon:** the user or Algorithm can mark a fork `"status": "abandoned"` directly in its tracking JSON, with an optional one-line `abandoned_reason`. No archival required for abandons — leave the file in place at `_forks/` (not `_forks/.archive/`, which is reserved for the merged-and-archived lifecycle) so an `open`-vs-`abandoned` grep can still distinguish "still active" from "known dead."
- **Passive staleness:** a tracking file with `status: "open"` and a `created` timestamp older than the current session is a candidate for abandonment review — surface this to the user rather than auto-abandoning (a long-lived legitimate investigation and an abandoned one look identical from the timestamp alone).
- **`_forks/` is expected to hold a mix of `open`, `abandoned`, and (briefly, pre-archive) `merged` entries.** Only `merged` entries move to `.archive/`. This is a deliberate difference from ISA `Reconcile`, which has no abandon state because ephemeral feature files are always short-lived by construction.

## Failure modes

- **No `parent_isa_path` and no `parent_session_id`:** abort — `Merge` has no destination without at least one of these. Ask the user which one to use before proceeding.
- **Forking for something Agent dispatch would cover:** if the detour doesn't actually need the parent's accumulated transcript (i.e., a clean prompt could scope it), stop and recommend `Agent()` instead — forking is the more expensive tool and should not be the default.
- **Native fork invocation fails:** see Step 5 — mark `fork_failed`, never leave a phantom `open` fork with no actual forked session behind it.
- **Skipping Step 2's prior-art check:** the fork proceeds on a subject that was already fully answered in `MEMORY/KNOWLEDGE/` or a prior ISA. The resulting Conclude artifact may look structurally valid (passes the Anchor Rule) while being an unnecessary, ungrounded re-derivation of something already known — the Anchor Rule checks that reasoning is anchored, not that the fork needed to happen at all. Step 2 is the only guard against this.
