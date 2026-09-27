---
name: system-prompt-retirement
title: "PAI_SYSTEM_PROMPT.md retired; CLAUDE.md is the single instruction layer"
date: 2026-07-24
status: complete
detected: manual
change: "Deleted PAI/PAI_SYSTEM_PROMPT.md (187 lines). Migrated the `claude --bare` billing prohibition to CLAUDE.md Operational Rules. Instruction hierarchy collapses from two layers to one."
---

## Decision

`PAI/PAI_SYSTEM_PROMPT.md` is deleted. For this installation's launch path (bare `claude`), `CLAUDE.md` is now the only authored top instruction layer. One rule migrated: the `claude --bare` billing prohibition. Everything else was either already covered locally, enforced by a registered hook, judged obsolete for this principal, or left as an explicit downstream question — see Consequences.

## Evidence

The file only reached the model via `--append-system-prompt-file`, added at `PAI/TOOLS/pai.ts:403` when launching through the `pai` wrapper. This principal has always launched bare `claude` — the alias exists (`.bashrc:149`, `.zshrc:129`) but `README.md:63` ("Start a Claude Code session") and `install.sh:215` ("Open Claude Code and run /interview") never direct users to it. Process inspection during the session that found this confirmed bare `claude` with no flag.

So the file **never loaded, on any session, since install** — and the principal's assessment of the system running without it was "honestly its still great." That is an unusually clean natural experiment: ~5.2k tokens of highest-priority instruction absent, blind (not compensated for), across months, with no perceived degradation. It is stronger than a designed benchmark against *subconscious compensation* — there was no opportunity to correct for an absence nobody knew about. It is **weaker on coverage**: it only exercised paths that happened to occur, and cannot speak to rare events (deploys, releases, billing cycles, external-human routing, leaks).

Section-by-section triage against three tests — covered elsewhere? hook-enforced? does the natural experiment apply?

| Section | Disposition |
|---|---|
| Output Format, Mode Architecture | Already in `CLAUDE.md:25-56` (all three templates). Only the enforcement *intensity* was missing, and that is what the experiment covers. |
| Security Protocol, prompt injection, execFile | Hook-enforced: `SecurityPipeline`, `PromptGuard`, `ContentScanner` all registered in `settings.json`. Code beats prose. |
| Verification / Interceptor mandate | Already in `CLAUDE.md:12-23` Critical Rules. |
| `~/.claude` is PRIVATE | Migrated earlier the same session; see [containment-enforcement-consolidation](containment-enforcement-consolidation.md). |
| Hard Prohibitions (no self-rating, don't modify working features, analysis is read-only) | Current-generation default behavior. BPE question 1 → CUT. |
| Self-Healing Infrastructure (the harness-auto-memory routing rule) | **Dropped, with a caveat.** The original rule was narrower than "ignore auto-memory": it routed *rules/preferences/conventions* to infrastructure and allowed *world-state facts* in harness memory. This principal's MEMORY.md is largely world-state, so it never contradicted the rule. Dropped because the routing judgment is now exercised case-by-case, not because the rule was wrong. Note the tension: behavioral feedback notes written to auto-memory are exactly what the old rule said should be a CLAUDE.md/hook patch. |
| What PAI Is, Identity, Context Hierarchy | Framing prose; DA identity loads via `@`-import. |
| Personal Use Boundary / OAuth routing | **Not applicable.** Scope is channels responding to non-principal humans (Telegram/Discord/iMessage bridges, customer agents). Principal runs none. `PULSE.toml` had `[telegram] enabled = true` as an inherited upstream default with no bot token or chat ID — set to `false` in this change. |
| `claude --bare` prohibition | **Migrated.** Sole survivor. |

The `--bare` rule survives because its failure mode is invisible to the natural experiment: a $498 invoice in April 2026 ($354 Sonnet + $72 WebSearch, documented at `PAI/PULSE/pulse.ts:44-50`), surfacing on a monthly bill rather than in output quality. `ANTHROPIC_API_KEY` is set in the principal's shell, and `pulse.ts:50` guards only the daemon path — any newly written tool that shells out to `claude` inherits the risk unguarded.

The file was also factually wrong in three places by the time it was deleted: line 173 claimed "the `ContainmentGuard` hook already blocks hardcoded user-home paths… that hook IS this rule, automated" (never registered, hardcoded to upstream identity), and line 174 referenced `skills/_PAI/TOOLS/ShadowRelease.ts` and `hooks/lib/containment-zones.ts` (neither exists in this tree after the containment consolidation).

## Alternatives Rejected

**Wire `--append-system-prompt-file` into the launch path so the file finally loads.** Rejected: this would newly impose 187 lines of untested instruction on a system already performing well, inverting the evidence. The experiment says the content was not needed for this principal's observed bare-`claude` workflow. It was, by this ADR's own evidence, never delivered here — which is why the experiment cannot speak to whether it would help a deployment that does load it.

**Keep the file, corrected, for downstream secunit users who launch via `pai`.** Rejected — there are no known users on that path. The principal does not use the wrapper, and the wrapper was retired in the follow-on [launcher-retirement](launcher-retirement.md) decision. See Consequences.

**Migrate Permission Boundaries too.** Deferred, not rejected. Most of it ("ask before deleting, deploying, pushing, modifying .env") is harness default. The one PAI-specific clause — "changing GP's written content" — may be worth two lines later if drift is observed.

## Consequences

- In this tree, new behavioral rules route to `CLAUDE.md` Operational Rules, a hook, or a skill. This is a local routing decision, not PAI-wide doctrine — a deployment that loads a system prompt still has that layer available.
- `[telegram] enabled = false` in `PULSE.toml`. It was supervising a poller loop (`pulse.ts:489`) for a bridge that was never configured.
- Remaining `PAI_SYSTEM_PROMPT.md` references are inert: `wiki.ts:525` is guarded by `existsSync` in `indexFile` (returns null, Pulse unaffected); `DocCheck.ts:148` scans a directory; `statusline-command.sh:368` is `[ -f ]`-guarded; `settings.json:1280` and `PAI_CAPABILITIES.md:106` are prose. `PAIUpgrade/Workflows/Upgrade.md` (both `skills/` and `Packs/` copies) was repointed in this same session to route behavioral rules to CLAUDE.md, a hook, or a skill.
- **Secunit risk raised and resolved.** Cross-vendor review (GPT-5.5 via Forge, 2026-07-25) argued the deletion was only clearly safe for *this principal's* bare-`claude` path: PAI is a public fork, the wrapper loaded this file, so for any downstream user launching via `pai` the file WAS load-bearing, and the local experiment does not test them. It also noted the file carried rare-event rules (OAuth routing, token-in-URL leakage, irreversible-operation gates, external-content security, data boundaries) whose absence surfaces only during a deploy, release, billing cycle, or leak — not in ordinary task quality.

  **Resolved on two fronts.** *Scope:* no known principal workflow depended on the wrapper. *Mitigation:* the concrete runtime hazard was first removed by deleting `--append-system-prompt-file` and the `-s/--system-prompt` option, then eliminated entirely when the wrapper was retired; see [launcher-retirement](launcher-retirement.md). Bare `claude` is now the supported interactive launch path.

  The interim parser correction made unknown options and commands fail with exit 1 rather than silently launching with changed semantics. That parser was subsequently removed with the wrapper.

  Residual risk, stated plainly: the rare-event rules the reviewer named are genuinely gone from this tree — one (`never put auth tokens in URLs`) was migrated to `CLAUDE.md`, while the rest are accepted as dropped per the triage table. Any undocumented downstream wrapper user must migrate to bare `claude`; no compatibility shim remains.
