---
name: forge-cato-codex-openrouter-cascade
title: "Forge and Cato cascade codex failures to OpenRouter with explicit path flag"
date: 2026-08-08
status: accepted
detected: cross-vendor-fallback
change: "ForgeProgress.ts and CrossVendorAudit.ts auto-route to ForgeOpenRouter.ts on codex failure; final output surfaces the path taken (`path` for Forge, `audit_path` for Cato). New --no-fallback escape hatch preserves fail-closed semantics."
---

## Decision

When `codex exec` returns a non-zero exit code, hits the wall-clock timeout, or emits an upstream-error stderr pattern (HTTP 5xx, model_not_found, upstream_error, manifest), `ForgeProgress.ts` and `CrossVendorAudit.ts` now auto-cascade to `bun ~/.claude/PAI/TOOLS/ForgeOpenRouter.ts` instead of returning `verdict: "error"` / `verdict: "skipped"` and stopping. The path taken is surfaced in the final output and JSONL row so downstream consumers can detect degraded runs.

Defaults:
- Forge fallback model: `openai/gpt-5.4-codex` (OpenAI-family lineage preserved)
- Cato fallback model: `openai/gpt-5.4` (matches the 2026-08-08 manual one-off)
- Both overridable via `--fallback-model <model>`

The preflight short-circuit (`codex CLI not found at ~/.bun/bin/codex` → `verdict: "unavailable"`) is preserved verbatim — when the binary is genuinely missing, no fallback fires. The fallback is only for "codex is present but failed" cases.

`--no-fallback` is the fail-closed escape hatch. It short-circuits BEFORE the codex call so users who explicitly want fail-closed semantics get raw codex errors surfaced directly, with `path: "codex"` and no `fallback_reason`.

## Field naming

| Tool | Final-stdout field | JSONL field |
|------|--------------------|-------------|
| Forge | `path: "codex" \| "openrouter-fallback"` | (no JSONL row — Forge writes events only) |
| Cato  | `audit_path: "codex" \| "openrouter-fallback"` | `audit_path`, `openrouter_model_requested`, `fallback_reason` (additive to the existing 12 fields) |

The Cato field name `audit_path` matches the 2026-08-08 in-the-wild JSONL row (`MEMORY/VERIFICATION/cato-findings.jsonl:5`) and the ADR `nightly-review-chunking-design-review.md:54`. Forge uses `path` (no `audit_` prefix because Forge is not an audit). Downstream greps must accept both spellings.

## Cross-vendor guarantee

Cato's Rule 2a bias-mitigation purpose is preserved. The cascade routes to OpenAI-family models (`openai/gpt-5.4`) via a different billing/quota path (OpenRouter rather than ChatGPT Plus), satisfying the "different vendor / different cognitive lineage" requirement at the cost of an explicit, flagged degradation. When the cascade fires, the JSONL row carries `audit_path: "openrouter-fallback"` and the model itself surfaces `model_used: "OpenAI GPT-5"` (or similar) — downstream consumers can verify the actual model ran.

The model's own self-reported `model_used` is NOT trusted as verification of cross-vendor execution, per the precedent in `nightly-review-chunking-design-review.md:39`. The verifiable field is `openrouter_model_requested` (what we asked for). This ADR does NOT add `model_used` to the JSONL row.

## Exit criteria

| State | Verdict | Path / audit_path | fallback_reason |
|-------|---------|--------------------|------------------|
| codex OK | success | codex | (absent) |
| codex failed, OR fallback OK | inherits OR verdict | openrouter-fallback | OR-side `reason` if OR itself failed; otherwise absent |
| codex failed, OR fallback also failed | error / skipped | openrouter-fallback | populated |
| codex binary missing (preflight) | unavailable | codex | "codex CLI not found at ~/.bun/bin/codex" |
| `--no-fallback` set, codex OK | success | codex | (absent) |
| `--no-fallback` set, codex failed | error / skipped | codex | (absent — raw codex error surfaced) |

## Why one retry, not three

Three failures observed in the wild:

1. **2026-05-12T15:20:48** Cato skip — codex exit 1, `--skip-git-repo-check` not specified. Fixed in v7.1.1 by always passing the flag. Not a retry case; a config bug.
2. **2026-08-08T04:09:53** Cato skip — codex exit 1, upstream model-manifest glitch (`unknown variant \`max\``). Same day, three minutes later, manually re-ran through `ForgeOpenRouter.ts` and got a genuine audit. This is the trigger.
3. **2026-08-08 (Forge, observed but not in JSONL)** — Forge codex call returned empty/error; no automatic fallback existed; partial work reported.

Pattern: failures are upstream-model-glitch class, not transient network class. A retry at the codex layer would just hit the same broken upstream. Routing the same prompt through OpenRouter is a true alternative path, not a duplicate attempt.

## Alternatives Rejected

**Retry codex with backoff before falling back.** Adds latency, doesn't help against upstream-manifest errors (which are not transient). Rejected.

**Parallel: codex + OR, take whichever finishes first.** Doubles cost on the happy path. Code path is meaningfully more complex (winner-dedupe, race ordering). Latency benefit marginal since OR is also network-bound. Rejected.

**Strict fail-closed: never auto-fallback.** Honors Forge's "no silent fallbacks" doctrine literally. But that doctrine is about silently switching models without telling the user — the cascade is explicitly flagged with `path`/`audit_path`, which is the opposite of silent. Strict fail-closed would mean losing the work whenever codex blips, which is the exact "mossing" failure mode this ADR is solving. Rejected.

**Auto-fallback with no flag.** Removes the `--no-fallback` escape hatch. Some audits (Cato on adversarial code review) treat the cross-vendor guarantee as load-bearing; users need a way to say "I want to know if codex failed, not silently get a different model." Rejected.

## Consequences

`MEMORY/VERIFICATION/cato-findings.jsonl` is now append-only with a guaranteed `audit_path` field on every row. Downstream consumers (none found in `PAI/TOOLS/` or `PAI/hooks/` at the time of this ADR) must tolerate the field's presence.

Forge's existing event log shape (`forge-events.jsonl`, `forge-final.txt`) is unchanged; the cascade writes `forge-or-events.jsonl` and `forge-or-final.txt` as separate files. No file collisions. The `test-forge-or/` slug directory is preserved (different slug, untouched by any cascade call).

`CLAUDE.md`, `PAI/ALGORITHM/v7.1.1.md` Rule 2a section, `skills/Agents/ForgeContext.md`, `skills/Agents/CatoContext.md`, `agents/Forge.md`, and `agents/Cato.md` each receive a one-line note documenting the new flag and behavior. The stale "retries once after 5s backoff" claim in `skills/Agents/CatoContext.md:73` is replaced — that retry logic never existed in the source.

`ForgeOpenRouter.ts` is unchanged. Its `readPrompt` already handles bun-spawned no-TTY-pipe stdin (the same shape `AnvilProgress.ts:178-188` uses for Moonshot routing).

Rolling back: revert the diff against `ForgeProgress.ts` and `CrossVendorAudit.ts`; the JSONL field additions remain readable but unused.