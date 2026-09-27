# SpawnBranch.ts

Turn one `## Branches` entry of a parent ISA into its own ISA, and do the bookkeeping on both sides.

## Usage

```bash
bun ~/.claude/skills/ISA/Tools/SpawnBranch.ts --parent <path/to/ISA.md> --branch B<n> [--desc <kebab>] [--dry-run]
```

| Flag | Meaning |
|------|---------|
| `--parent` | Path to the parent ISA.md (required) |
| `--branch` | Branch label, e.g. `B2` (required) |
| `--desc` | Slug description. Default: kebab-case of the branch name, 48 chars max |
| `--dry-run` | Print the child ISA and the parent edits without writing anything |

## What it does

1. Finds `B<n>` under the parent's `## Branches`, using the same parser as the v8.1 close gate (`hooks/lib/algorithm-v8.ts` `branchEntries`), so the tool and the gate agree on what a branch is.
2. Refuses if the entry is missing, already resolved (`spawned:`/`filed:`/`dropped:`), or lacks any of the four scope answers `(1)`–`(4)`.
3. Writes `MEMORY/WORK/<YYYYMMDD-HHMMSS>_<desc>/ISA.md` next to the parent's directory:
   - `parent:` is set.
   - Problem and Goal come from answer (1), Out of Scope from (3), `ISC-1` from (4), and `ISC-2: Anti:` from (2).
   - The original entry is quoted in Decisions.
4. Appends `**spawned: \`<slug>\`**` to the parent entry, and adds the slug to the parent's `branches:` frontmatter, creating the field if needed.

The seed ISA is E2 with 2 criteria. Split them into atomic probes at OBSERVE before building.

## Exit codes

`0` spawned, or dry-run printed · `1` usage, branch missing, already resolved, or missing scope answers · `2` write failed
