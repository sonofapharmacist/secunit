---
name: Verify
description: Runs deterministic, project-specific rule checks against the actual OUTPUT of completed work (a file, a diff, a deliverable) and reports pass/fail with tool-call evidence — never "looks fine." Distinct from any Packs/*/VERIFY.md file, which checks that a skill INSTALLED correctly (directory exists, frontmatter valid); Verify checks that a finished piece of work is CORRECT. Can chain after code-review or simplify so a check-and-fix loop runs with no human in between. USE WHEN verify this output, check this against the rule, deterministic check, does this pass the rule, run verification loop, chain code-review into verify, check-and-fix loop, task-output verification, verify the deliverable. NOT FOR checking whether a skill/pack installed correctly (that's the skill's own VERIFY.md) and NOT FOR fuzzy subjective code review (use code-review for that; Verify is for mechanical, binary-outcome rules only).
---

# Verify

Verification loops turn a manual "let me double check that" step into an automated check-and-fix cycle: the agent runs a deterministic rule against real output, reports pass/fail with evidence, and (optionally) chains into other skills so the whole loop runs unattended.

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| "check this against rule X", "does this pass", "verify this output" | `Workflows/CheckRules.md` |
| "chain verify after code-review", "check-and-fix loop", "run the pipeline" | `Workflows/Chain.md` |

## Quick Reference

- Probe-ability requirement is in Gotchas below — read that before writing a rule.
- Every run reports a verdict backed by the literal command/output, not a summary of what "should" be true.
- Standalone use is the default. Chaining (`Workflows/Chain.md`) is for when the same target should go through multiple skills back-to-back with no human approving each stage.

## Gotchas

- **This is not `Packs/*/VERIFY.md`.** Every Pack ships its own `VERIFY.md` that checks the pack *installed* correctly — directory exists, `SKILL.md` frontmatter is valid, the skill triggers. That's an installation check and runs once, at install time. This skill checks whether a *piece of finished work* — a file someone just wrote, a diff someone just produced — actually satisfies a rule. Don't confuse the two; don't route installation questions here, and don't route work-output questions to a Pack's VERIFY.md.
- **A rule with no nameable tool probe doesn't belong here.** "Check that the code is clean" is not a Verify rule. "Check that no `console.log` remains in `src/`" is (`Grep -rn "console.log" src/`). If you can't say which single command decides pass/fail, redirect to `code-review` or `simplify` instead — this skill is for mechanical checks only.
- **Never report a verdict without quoting the actual command output.** "This looks correct" or "should pass" is not a Verify result — it's exactly the failure mode this skill exists to prevent. Every pass/fail line must show the command and its real stdout.
- **Chaining does not mean narrating the next skill — it means invoking it.** `Workflows/Chain.md` requires literal `Skill(...)` tool calls in sequence, not a description of what the chain would do.
