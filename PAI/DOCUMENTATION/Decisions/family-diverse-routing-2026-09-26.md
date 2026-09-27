---
name: family-diverse-routing-2026-09-26
title: "Adopted: route each cross-checking role to a distinct model family, with a real backend behind every named agent"
date: 2026-09-26
status: complete
detected: manual
change: "Mapped PAI's cross-checking roles (threat planning, research, code review, audit, cheap cloud default) to distinct model families. Found that three 'multi-vendor' researcher agents (Grok, Gemini, Perplexity) were Claude personas with no vendor backend; gave Grok and Gemini real backends (OrWebResearch.ts, AgyJail --research) and dropped Perplexity. DualCheck's second leg moved from MiniMax M3 to Solar Pro 4; Grok 4.7 added as Tier-0 threat alternate and optional third commit reviewer."
---

## Decision

PAI uses several agents and tools *because* they disagree: research fan-out, dual review, and Tier-0 threat quorums. That's only worth anything if the participants come from **different training pipelines** and each one **actually runs on the model it claims to**. From 2026-09-26, every cross-checking role is assigned by family, and an agent that names a vendor must call that vendor.

## Role map (2026-09-26)

| Role | Families in use | Backends |
|---|---|---|
| Threat-model Tier-0 | Anthropic, Moonshot, Meituan, **xAI** | Opus 4.8 (primary), Kimi K2.6, LongCat 2.0, **Grok 4.7** (new; see `threat-model-tier-0-routing.md`) |
| Research fan-out | Anthropic, **Google**, **xAI**, DeepSeek | ClaudeResearcher (WebSearch), **GeminiResearcher → `AgyJail.ts --research`**, **GrokResearcher → `OrWebResearch.ts`** (Grok 4.7 + Exa), DeepSeek leg via hermes |
| Dual code review | Mistral, **Upstage** | DualCheck: Devstral Medium (Mistral direct) + **Solar Pro 4** (OpenRouter; was MiniMax M3) |
| Commit review | Anthropic + optional **xAI** | `_COMMITREVIEW`, with Grok 4.7 as an optional third reviewer |
| Code production | OpenAI, Meituan, Anthropic | Forge (GPT-5.4 via OR), Anvil (LongCat 2.0), Engineer (Claude) |
| Adversarial code audit | DeepSeek | DeepSeek V4 Pro 0813 via AnvilProgress, kept off Anvil's own lineage |
| Cheap cloud default (`openrouter.model`) | **Upstage** (pending) | Solar Pro 4, 51/53 and 50/53 at $0.09/$0.36. The switch is gated on the Solar-vs-Sonnet workload bench showing no LOSE |
| Local | Alibaba (Qwen) | prod `qwen3_next_80b_a3b`, fast tier jackrong 9B |

## The phantom-researcher finding

GrokResearcher, GeminiResearcher and PerplexityResearcher were all `model: opus` personas with WebSearch. Their prompts described xAI, Gemini and Perplexity Sonar access, but no code path ever called those vendors. Every "cross-vendor" Research run was therefore Claude checking Claude with a costume change. The agreement those runs reported between sources was not independent evidence.

Fixes:
- **GrokResearcher** runs on `model: sonnet` with **WebSearch disallowed**, and its research comes from `PAI/TOOLS/OrWebResearch.ts`: Grok 4.7 through OpenRouter's web plugin with the Exa engine, 3 results, about $0.014-0.03 per call. It exits 0 with citations, 3 with none, and 2 on error. xAI's native search reaches X posts, but it ignores result caps and cost 6-17× more when measured, so it's opt-in (`--engine native`).
- **GeminiResearcher** runs on `model: sonnet` with **WebSearch disallowed**, and its research comes from `AgyJail.ts --research`: Antigravity in a bwrap jail, subscription-backed. The evidence it reports is agy's own `search_web` step outputs (`brain/<session>/.system_generated/steps/N/output.txt`), not agy's narration. Non-search tool attempts trip the jail's tripwires.
- **PerplexityResearcher** is dropped, not rebuilt: Sonar pricing wasn't worth it for one leg of a fan-out. The agent file is kept and marked DEPRECATED. No Research workflow dispatches it.

**Rule going forward:** an agent whose description names a vendor must (a) call that vendor through a tool, (b) have `WebSearch` disallowed so it can't quietly fall back to Claude, and (c) say plainly when the backend fails rather than substituting its own knowledge.

## Alternatives rejected

- **Rebuild Perplexity on the Sonar API.** Too expensive for one leg; Grok + Exa and jailed Gemini cover the non-Anthropic search families.
- **xAI native search as the Grok default.** It ignores `max_results` and bills per source: $0.078-0.24 per call measured, against $0.014 with Exa.
- **Keep MiniMax M3 as DualCheck's second leg.** Solar Pro 4 scores 51/53 and 50/53 on unified at $0.09/$0.36, and it's an Upstage lineage that nothing else in PAI uses. The cost is latency: Solar reasons, so DualCheck's default timeout is now 300s.

## Consequences

- Agent definitions load at session start, so the live-dispatch checks for GeminiResearcher and GrokResearcher (ISA ISC-53/54) run in the next session.
- Research runs cost slightly more in cash (Grok calls), and the agreement they report now means something.
- **Follow-up, not done here:** CodexResearcher has the same problem in a different form. It does shell out to `codex exec`, but it asks for `o3`, `gpt-5-codex` and `gpt-4`, which ChatGPT auth likely rejects (gpt-5.4 already is). It also omits `< /dev/null`, the known way to make `codex exec` hang forever. It keeps WebSearch, so a failure would silently become Claude research. No Research workflow dispatches it today. Fix or deprecate it before anything does.
- **Resolved 2026-09-26 (same day):** GP chose fix-and-reroute. CodexResearcher now runs its research on OpenAI GPT-6 Luna through `OrWebResearch.ts --model openai/gpt-6-luna` (the Grok pattern, OpenAI family). The Sonnet wrapper has WebSearch disallowed. Live dispatch: `openai/gpt-6-luna via OpenAI (OpenRouter web) — 3 citations, $0.0074518`, EXIT=0. Luna: 44/53 unified, 9.04 threat (single run), $0.10/$0.50 per MTok. GPT-6 Sol remains an on-request depth option.

## Evidence

- ISA: `PAI/MEMORY/WORK/20260926-002150_model-sweep-unified-plus-threat/ISA.md` (ISC-52..61)
- Bench data: `PAI/MEMORY/KNOWLEDGE/Research/model-sweep-unified-threat-2026-09-26.md`
- Tools: `PAI/TOOLS/OrWebResearch.ts`, `PAI/TOOLS/AgyJail.ts` (`runJailedResearch`, tests in `__tests__/agy-jail.test.ts`), `skills/DualCheck/Tools/DualDirectReview.ts`
- DualCheck live run on 2026-09-26: both legs returned results and independently found the NaN `--max-results` bug in `OrWebResearch.ts` (fixed)
