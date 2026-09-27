# CheckRules Workflow

Runs a named deterministic rule against a real target (file, directory, or diff) and reports a pass/fail verdict backed by literal tool output.

## When to invoke

- User names a specific rule and a target: "check that `src/` has no leftover `console.log`."
- As the last stage of a chain (see `Chain.md`), after `code-review` or `simplify` has run.

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| rule | yes | The deterministic check, phrased so it maps to one tool probe |
| target | yes | File, directory, or diff to check |

## Procedure

### Step 1 — Confirm the rule is probe-able

Before running anything, state the rule as a single tool call that returns yes/no. If you cannot, the rule is not a Verify rule — stop and say so rather than improvising a fuzzy judgment.

### Step 2 — Run the probe

Execute the actual `Bash`/`Grep`/`Read` call against the real target. Never simulate or predict the output — run it.

### Step 3 — Report the verdict

```
✅ CHECKRULES: [rule] on [target]
  PROBE: [literal command]
  OUTPUT: [literal output, or "no output" if empty]
  VERDICT: PASS | FAIL
```

A FAIL verdict names exactly what was found and where (line numbers / matched paths), so the caller (or the next skill in a chain) can act on it directly.

### Step 4 — Fix (optional, only if asked)

If the invocation asked for fix-not-just-check, edit the target to satisfy the rule, then re-run Step 2 to confirm the fix landed — a fix without a re-run is not verified.

## Example rules (concrete, runnable)

| Rule | Probe |
|------|-------|
| No leftover debug logging in a directory | `grep -rn "console\.log\|debugger" <dir>` — pass if zero matches |
| A skill's `SKILL.md` has valid frontmatter | `head -1 <file> \| grep -q "^---"` plus `grep -q "^name:"` / `^description:"` |
| No TODO/FIXME markers left in a shipped file | `grep -n "TODO\|FIXME" <file>` — pass if zero matches |
| A migration that drops a column also has a backfill step | `grep -q "DROP COLUMN" <file> && grep -q "backfill" <file>` — pass only if both conditions align (drop without backfill = FAIL) |
| No unintended files changed outside an expected path set | `git diff --stat` — pass if every changed path is in the expected set |

## Failure modes

- **Rule has no nameable probe.** Reject the request — name the closest tool-verifiable proxy, or redirect to a fuzzy-review skill.
- **Target doesn't exist.** Fail loudly with the exact path checked — never report PASS on a missing target.
- **Probe output is ambiguous (neither clearly zero nor clearly non-zero).** Show the raw output and let the caller decide; don't guess a verdict.
- **A naive grep-for-pattern rule can hit legitimate matches that aren't the violation.** `grep "console\.log"` also matches intentional CLI-output logging, not just debug leftovers. When a probe returns non-zero matches, read the surrounding code before reporting FAIL — if every match is a deliberate print/output call rather than debug residue, say so explicitly rather than reporting a blanket FAIL. Design the probe to discriminate (e.g., exclude a designated output function) when the target is expected to have legitimate matches.
