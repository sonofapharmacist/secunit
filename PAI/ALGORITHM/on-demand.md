# Algorithm v8 — On-Demand Procedures

> Moved here from v7.1.1, not deleted. None of these are mandatory. Use one when the task calls for it. Weaker executing models get some of them injected automatically via `model-scaffolds.yaml`. Doctrine lives in `v8.0.0.md`.

## Preflight gates

Use at the start of work that touches the matching area. False positives are cheap; false negatives cause mid-execution failures.

| Gate | Trigger | Goal |
|------|---------|------|
| **A: Diagnostic** | Bug-fix, "X broken", debugging | Confirm system is observable. Reproduce failure before reading code. |
| **B: Deploy/API** | Deploy, API, infrastructure | Confirm all credentials, CLI tools, service access exist. |
| **C: External service** | Cloudflare, Stripe, Telegram, any external API | Load PAI skill context. Check documented gotchas. |
| **D: Research** | Errors, API failures, unfamiliar library behavior | Search external docs before local code archaeology. |

## Premortem

Use before committing to an approach on work that is expensive to redo.

- **Riskiest assumptions:** items the work depends on being true.
- **Premortem:** failure modes the work must withstand. Add an `Anti:` criterion for each.
- **Prerequisites:** blockers, including preflight findings.

Library search, when a reference text might apply:

```bash
bun ~/.claude/PAI/TOOLS/MemoryRetriever.ts "<topic query>" --domains Library --top 3
```

## Deliverable manifest

Use when the request contains several explicit sub-tasks. Enumerate every sub-task the user asked for as a numbered list (D1..DN), quoting distinctive phrasing. Map each to at least one criterion. Before declaring done, check each D against what shipped.

## Root-cause-at-ingestion checkpoint

Before committing to a fix that modifies output-side behavior, answer in `## Decisions`:

1. **Where does this bad state enter the system?** Name the ingestion point.
2. **If I fix it at the ingestion point instead of here, do 3 similar bugs disappear?** If yes → move the fix upstream.
3. **Am I tracing database-up or display-down?** For UI bugs, the Reproduce-First rule forces display-down.

## Delegation and parallelism

- **Delegation gate:** for every agent, ask "Can I do this with Glob + Grep in under 30 seconds?" YES → do it directly. NEVER delegate directed lookups. NO → agent OK. Prefer `run_in_background: true` unless the result gates the next step.
- **Parallelism:** default-on for research, variant generation, multi-URL probes, multi-file edits with independent targets. Default-off for sequential chains and single-file surgical edits.
- **Reads-before-writes** (when ≥3 file edits planned): read all target files before the first Edit. Catches cross-file conflicts before they occur.
- **Async primitive:** one-shot command → `Bash(run_in_background)`. Event stream → `Monitor`. AI work → `Agent(run_in_background)`.
- **Watchdog:** on first background agent spawn in a session, start the agent watchdog if not running.
- **Isolation:** parallel write-agents with overlapping file targets → `isolation: "worktree"`.
- **Coordination:** Agent Teams default; Custom Agents only on "custom agents"; Managed Agents for unattended/overnight.

## Ephemeral feature files

If a feature is worked in an isolated context (Ralph Loop, Maestro, parallel Forge instances), invoke `Skill("ISA", "extract feature <name> as ephemeral file")` to produce `MEMORY/WORK/{slug}/_ephemeral/<feature>.md`. Never hand-edit it as policy. Reconcile back with `Skill("ISA", "reconcile <ephemeral> → <master>")`, keyed on stable ISC IDs.

## Cato cascade details

When codex fails (CLI present but exits non-zero, 120s timeout, or upstream-error stderr), `CrossVendorAudit.ts` auto-routes the same bundle to `ForgeOpenRouter.ts --model openai/gpt-5.4` and stamps `audit_path: "openrouter-fallback"`. `--fallback-model <model>` overrides it. `--no-fallback` keeps fail-closed semantics. A missing codex CLI still short-circuits to `verdict: "unavailable"`. See `PAI/DOCUMENTATION/Decisions/forge-cato-codex-openrouter-cascade.md`.
