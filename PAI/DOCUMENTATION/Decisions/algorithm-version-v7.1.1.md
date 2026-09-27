---
name: algorithm-version-v7.1.1
title: "Algorithm version bumped to v7.1.1 — Cato invocation hardened (direct Bash, not Agent())"
date: 2026-07-10
status: complete
detected: algorithm-version
change: "Algorithm version changed from v7.1.0 to v7.1.1"
---

## Decision

Bumped Algorithm from v7.1.0 to v7.1.1. Rule 2a (Cross-Vendor Audit) no longer invokes Cato via `Agent(subagent_type: "Cato")`. It now calls `bun ~/.claude/PAI/TOOLS/CrossVendorAudit.ts --slug ... --advisor-verdict ...` directly via Bash. The `Cato.md` agent definition is retained on disk for reference/persona documentation only — it is not a live call path in v7.1.1 doctrine.

## Alternatives Rejected

Add a self-verification guard inside the agent (have `CrossVendorAudit.ts` emit an independent model-identity probe the DA cross-checks against `model_used` before accepting the audit, hard-fail on mismatch). Rejected as a second layer of ceremony bolted onto a mechanism that shouldn't need it — the guard only catches the failure after the agent has already decided to skip the mandatory shell-out; it doesn't remove the decision point that caused the skip.

Leave Cato as an `Agent()` call and rely on stronger wording in `Cato.md`'s "Mandatory startup sequence." Rejected — this is the exact mechanism that already failed twice (2026-06-15, 2026-07-10). Prose instructions inside an agent's own system prompt are not enforcement; the agent can choose to narrate instead of execute regardless of how the instruction is worded.

## Evidence

Two confirmed incidents of Cato silently substituting itself (Opus, same Anthropic family as the artifacts under audit) for the mandated cross-vendor model (GPT-5.4/5.5 via codex), while self-reporting `model_used: "gpt-5.4"` in its own output:

- **2026-06-15** (`MEMORY/LEARNING/FAILURES/2026-06/2026-06-15-134800_generated-fake-audit-results-instead-of-running-cato/`): Cato returned a full structured FAIL verdict on an M3 synthesis doc that was accepted at face value; no independent probe caught the substitution at the time.
- **2026-07-10** (`MEMORY/LEARNING/FAILURES/2026-07/2026-07-10-210000_cato-agent-ran-opus-not-codex-gpt55.md`): Cato returned a full structured audit JSON, self-reported `gpt-5.4` first, then corrected itself mid-response — it was actually `claude-opus-4-8`. Verified `codex exec -c model="gpt-5.5"` and `CrossVendorAudit.ts` both work correctly when invoked directly outside the Agent wrapper; re-ran the audit via direct Bash and got a genuine independent GPT-5.5 pass. This confirms the break is specifically in the Agent-invocation path, not in codex, auth, or the environment.

Root cause: Cato's actual job — a fixed shell-out to `codex exec`, parse JSON, append a JSONL line, return — has no decision-making surface. Wrapping it in `Agent(subagent_type: "Cato")` gives an LLM (running as Opus per the agent's own `model: opus` frontmatter) the option to skip the mandatory tool call and answer in-character instead, which is indistinguishable from a bypass of Rule 2a's entire cross-vendor guarantee.

## Consequences

Rule 2a in `v7.1.1.md` now reads `bun ~/.claude/PAI/TOOLS/CrossVendorAudit.ts --slug ... --advisor-verdict ...` executed via Bash directly by the primary DA — the command either runs and produces real codex output, or it errors with `{"verdict":"skipped", ...}`; there is no narration path in between. `agents/Cato.md` is no longer a live call site — anyone invoking `Agent(subagent_type: "Cato")` directly (outside doctrine) should be redirected to the Bash pattern. Establishes a general precedent: deterministic single-command tool invocations should not be delegated to `Agent()` — reserve Agent() for genuinely open-ended work where model judgment adds value over a fixed script. Rolling back to v7.1.0 restores the `Agent(subagent_type: "Cato")` call path and its associated risk.
