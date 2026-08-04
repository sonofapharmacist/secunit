# Audit Workflow

Full audit of all force-loaded AI instructions for over-prompting.

## Steps

### 1. Discover what's loaded

Read `settings.json` to find:
- `loadAtStartup.files` — force-loaded every session
- `postCompactRestore.fullFiles` — re-loaded after compaction
- `dynamicContext` sections — relationship, learning, work summaries
- CLAUDE.md — native instruction file

Also check for project-level CLAUDE.md files if working in a specific project.

### 2. Read every instruction file

Read each discovered file completely. Count total lines and rules.

### 3. Evaluate each rule against the Six Questions

For every rule found, apply the six questions from SKILL.md. Cross-reference with the model's built-in default behavior:

**Already default (common false adds):**
- Read files before editing them
- Ask before destructive operations (rm, reset --hard, force push)
- Make minimal changes, don't add unrequested features
- Don't modify quoted/user text
- Check safer alternatives before destructive git ops
- Use structured choices when asking questions

Defaults expand with each model generation. A rule that earned its place against an older model may be dead weight now — which is the whole premise of the audit, and the reason to re-run it after a model change rather than treating a past pass as settled.

### 4. Check for cross-file conflicts and layering

Compare rules across all files for:
- Same concept stated differently in two places
- Rules that contradict each other
- Outdated references (skill names, file paths, tool names)
- Rules stated at the wrong altitude, or at several altitudes at once — tool guidance living in CLAUDE.md rather than the tool's own description, product-level context living in a skill. Classify these LAYER, not MERGE: the fix is deleting the copy at the wrong level, not reconciling two equals.

### 5. Evaluate context-to-value ratio

For each force-loaded file, estimate:
- How many tokens it consumes
- How often its content actually affects output quality
- Whether it could be on-demand (via CONTEXT_ROUTING) instead of always-loaded

### 6. Flag release-affecting cuts

Before reporting, check which touched files ship in a public release — templates, user-scaffold files, public docs and READMEs. List those cuts separately (see the release gotcha in SKILL.md). They are decided on different grounds than private config and shouldn't ride along in the same approval.

### 7. Produce the report

Use the output format from SKILL.md. Include estimated token savings.

### 8. Offer trimmed versions

If the user approves, produce cleaned versions of the files with dead weight removed. Approval of the report is not approval to edit — confirm before writing, and keep release-affecting changes as a separate decision.
