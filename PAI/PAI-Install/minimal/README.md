# PAI minimal install

A second, lighter entry point alongside the full CLI/GUI wizard
(`../main.ts`). Where the full installer walks through identity, DA
naming, and voice configuration before landing anywhere useful, this path
skips straight to a working, secured Claude Code session: the security
pipeline (`hooks/SecurityPipeline.hook.ts` + inspectors + content
scanning) and a flat `MEMORY.md`, nothing else.

**Why this exists:** onboarding a team of first-time Claude Code users
onto the full PAI doctrine (the Algorithm, twelve-section ISAs, effort
tiers, a named assistant identity) front-loads more ceremony than a first
session should require. This gives them a real, secured session in under
a minute, with an explicit, documented path to add the rest later if they
want it — see `UPGRADE.md`.

**Two hooks ship, on two different lifecycle events, and that split is
easy to misread from the manifest alone:**
- `hooks/SecurityPipeline.hook.ts` (installed from
  `SecurityPipeline.minimal.hook.ts` — see `hook_renames` in
  `manifest.json`) fires on **PreToolUse** (Bash/Write/Edit/MultiEdit). It
  builds its inspector chain from Canary + Pattern + Egress only —
  `RulesInspector` is deliberately dropped (see the file's own header
  comment for why).
- `hooks/ContentScanner.hook.ts` fires on **PostToolUse**
  (WebFetch/WebSearch) and uses `InjectionInspector` on its own. It was
  never part of the PreToolUse pipeline being trimmed, so the
  RulesInspector cut doesn't touch it — it ships unmodified.

`InjectionInspector.ts` appears in `manifest.json` because
`ContentScanner.hook.ts` needs it, not because the PreToolUse hook does.
Read in isolation, the manifest looks like it lists an inspector nothing
uses — it's used, just by the other hook.

## Files

| File | Purpose |
|------|---------|
| `install-minimal.sh` | The installer. Copies manifest-listed files, renders templates, prints a summary of what was and wasn't installed. |
| `manifest.json` | The exact file list this path installs. Extend deliberately — anything added here becomes part of every minimal install. |
| `templates/CLAUDE.md.template` | Minimal operating rules: security posture, memory pointer, reset instructions, upgrade pointer. No mode routing, no Algorithm references. |
| `templates/MEMORY.md.template` | A flat, single-file memory starting point — no WORK/LEARNING/KNOWLEDGE tiering. |
| `templates/settings.json.template` | Hook registration for the security pipeline only. |
| `UPGRADE.md` | What a minimal install doesn't have and how to add it without redoing the install. |

## Usage

```bash
# From an existing project directory
bash /path/to/PAI-Install/minimal/install-minimal.sh

# Non-interactive (scripted rollout)
bash install-minimal.sh --target ./my-project --team-name "Platform Team" --yes
```

## Design constraints

- **No identity, no DA, no voice, no Algorithm/ISA.** If a change to this
  path adds a prompt or a doctrine file, it no longer belongs here — put it
  in the full wizard instead.
- **Every step is additive and reversible.** Nothing this script writes
  should require the full installer to run first, and nothing it writes
  should block the full installer from running later on the same
  directory.
- **No jq dependency.** `bun` is already required to run the security
  hooks, so JSON parsing in the installer goes through `bun -e` rather
  than assuming `jq` is on the host.
