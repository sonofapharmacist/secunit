---
name: model-routing-policy
title: "Model routing: harness defaults at subagent spawns, classifier routing fields removed"
date: 2026-09-23
status: accepted
detected: hook-behavior-changed
change: "agent-guard (Pulse) sets haiku by default on supporting subagents. Agent frontmatter is retiered. PromptProcessing drops MODEL / COST_TIER / CONFIDENCE and the /e1-/e5 overrides. Supersedes the classifier-field clause of algorithm-v8-harness-first."
---

## Context

v8 had the prompt classifier emit `MODEL`, `COST_TIER`, and `CONFIDENCE`, but nothing read them. A hook can't switch the main session's model, and GP picks that model by hand, using Claude models only. The one real cost lever was the prose rule "pass `model: haiku` to supporting subagents". Nothing enforced it, and it contradicted `agents/ClaudeResearcher.md` (`model: opus`).

## Decision

- The existing PreToolUse `Agent` hook (`PULSE/modules/hooks.ts` `handleAgentGuard`) returns `updatedInput.model: "haiku"` for Explore, general-purpose, claude-code-guide, and calls with no subagent type (the hook treats those as general-purpose), whenever the call passes no `model:`. An explicit model always wins.
- ClaudeResearcher moves to haiku. The Forge, Cato, and Anvil wrappers move to sonnet, because their real work runs in codex or OpenRouter.
- The routing line becomes `REASON | SOURCE | EXECUTOR | SHELL_MODE` plus executor scaffolds. `/e1`–`/e5`, the NATIVE prompt-length heuristic, ratings/acks→MINIMAL, and Forge auto-include at E3+ are all dropped. Forge now runs only when GP names it.
- There is one routing table: `DOCUMENTATION/Routing/ModelRouting.md`.

## Evidence

- A curl smoke test against `/hooks/agent-guard` returned the right result in 5/5 cases.
- A live Explore spawn with no model ran on `claude-haiku-4-5-20251001`, taken from its transcript.
- Feeding synthetic stdin to `PromptProcessing.hook.ts` produced the new line format.

## Consequences

Any tooling that parsed `COST_TIER` or `CONFIDENCE` from the routing line breaks. A grep of `hooks/`, `PAI/TOOLS/`, and `PAI/PULSE/` found no such parsers. Telemetry in `prompt-processing.jsonl` still records `model_selected`. Work ISA: `MEMORY/WORK/20260923-model-routing-policy/ISA.md`.
