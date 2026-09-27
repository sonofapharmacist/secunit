# Model Routing

The single source for which model runs what in PAI. CLAUDE.md points here and doesn't restate these rules.

A hook can't switch the main session's model. GP picks that model by hand. Automatic routing happens only at subagent spawns and tool calls.

## Subagents (`Agent` calls)

| Agent | Model | Set by |
|-------|-------|--------|
| Explore, general-purpose, claude-code-guide (a call with no `subagent_type` counts as general-purpose) | haiku, unless the call passes `model:` | `agent-guard` in `PULSE/modules/hooks.ts` (PreToolUse `updatedInput`) |
| ClaudeResearcher, ProofReader, Arthur (credential-policy narrator) | haiku | agent frontmatter |
| Forge, Cato, Anvil | sonnet (the wrapper only; the real work runs in codex or OpenRouter) | agent frontmatter |
| GrokResearcher, GeminiResearcher, CodexResearcher | sonnet (the wrapper only; WebSearch is disallowed, so the research comes from the backend) | agent frontmatter |
| Engineer, Architect, Algorithm, Silas, Designer, M3Researcher | opus | agent frontmatter. Don't pass `model:` to these. |

PerplexityResearcher is deprecated (2026-09-26): nothing dispatches it, and it has no Perplexity backend.

## Research backends (family diversity)

Each researcher runs on a different vendor lineage, so when they agree, the agreement means something. ADR: `Decisions/family-diverse-routing-2026-09-26.md`.

| Researcher | Backend | Path | Cost per call |
|------------|---------|------|---------------|
| ClaudeResearcher | Claude WebSearch | native | subscription |
| GrokResearcher | `x-ai/grok-4.7` | `PAI/TOOLS/OrWebResearch.ts` (OpenRouter web plugin, Exa) | ~$0.014 |
| CodexResearcher | `openai/gpt-6-luna` | `OrWebResearch.ts --model openai/gpt-6-luna` | ~$0.007 |
| GeminiResearcher | Gemini via Antigravity (agy) | `PAI/TOOLS/AgyJail.ts` research mode (jailed) | subscription |
| M3Researcher | MiniMax M3 | direct API, no live web (recall only) | paid quota |

## Threat-model (sec-planner) slots

Opus 4.8 is primary. The Tier-0 alternates are Kimi K2.6, LongCat 2.0 and `x-ai/grok-4.7` (fastest and cheapest, ~26s and ~$0.04). A slot needs 3 bench runs reported as mean and min, because one run gives a band, not a rank. Slot table and evidence: ADR `Decisions/threat-model-tier-0-routing.md`. Per-model role notes: `PAI/USER/Config/inference-routing.yaml`.

An explicit `model:` on an `Agent` call always overrides the default.

## Cross-vendor tools

| Tool | When | Default model |
|------|------|---------------|
| Forge (`ForgeProgress.ts`) | Only when GP names it | OpenRouter `openai/gpt-5.4` directly (`path: "openrouter"`). `--codex` switches to codex first, with OpenRouter as the fallback (`path: "openrouter-fallback"`). Running `ForgeOpenRouter.ts` by itself defaults to `mistralai/devstral-2512`. |
| Cato (`CrossVendorAudit.ts`) | v8 high-stakes work, run through Bash, never `Agent()` | codex, falling back to OpenRouter `openai/gpt-5.4` (ADR `Decisions/forge-cato-codex-openrouter-cascade.md`) |
| Anvil (`AnvilProgress.ts`) | Only when GP names it | `meituan/longcat-2.0`; adversarial audits use `deepseek/deepseek-v4-pro-0813` |
| `Inference.ts fast\|standard\|smart` | Called from inside tools and hooks | `PAI/USER/Config/PAI_CONFIG.yaml`. Local model swaps follow `Tools/ProdModelChangeProcedure.md`. |

## Prompt hook

`PromptProcessing.hook.ts` emits `REASON | SOURCE | EXECUTOR | SHELL_MODE`, plus the scaffolds from `PAI/ALGORITHM/model-scaffolds.yaml` for weaker executors. It doesn't make routing decisions. Its Haiku call exists for the tab title and session name.

Removed 2026-09-23: `MODEL`, `COST_TIER`, `CONFIDENCE`, the `/e1`–`/e5` overrides, the NATIVE prompt-length heuristic, and Forge auto-include at E3+. Nothing consumed them. See ADR `Decisions/model-routing-policy.md`.
