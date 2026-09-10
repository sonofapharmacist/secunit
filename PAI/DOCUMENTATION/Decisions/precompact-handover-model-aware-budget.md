# PreCompact handover — model-aware character budget

**Status:** accepted (2026-08-08)
**Trigger:** user report "autockmpact for m3 sessions horns out at 162k ctx"
**Deciders:** GP + Munro

## Context

M3 sessions on the minimax.sh backend were hitting the auto-compact ceiling and immediately re-triggering compaction before any work could happen — the "horns out" symptom. Investigation showed:

1. `CLAUDE_CODE_AUTO_COMPACT_WINDOW=512000` is correctly set by `minimax.sh` so the auto-compact trigger fires well before M3's empirical quality cliff (~200K).
2. The PreCompact hook's output to stdout was **unbounded** — first 40 lines of ISA, up to 20 files modified, every key decision, all imperatives.
3. M3 has **no prompt cache** (verified 2026-08-08, see auto-memory `feedback_m3_no_prompt_cache`). Every turn re-tokenizes the full conversation including the handover.
4. Therefore: post-compact handover (~80 lines, several K tokens) + new turn immediately re-triggered the next compaction. The user had no room to work between compactions.
5. Bonus defect: SessionStart's `context_budget_pct` used a hardcoded `200000` denominator, which was wrong for M3 (512K cap) and Sonnet/Opus (1M).

The trigger threshold itself was fine. The handover was the tax.

## Decision

Bound the handover output to a model-aware character budget, scaled inversely with the model's ability to absorb re-tokenized context:

| Model tier | Char budget | Approx tokens | Rationale |
|------------|-------------|---------------|-----------|
| `m3` | 16,000 | ~4K | No cache, small effective window after trigger — be tight |
| `haiku` | 16,000 | ~4K | 200K window, no slack for bloat |
| `sonnet-opus` | 48,000 | ~12K | Cache amortizes re-ingestion cost |
| `env-var` | 16,000 | ~4K | Don't trust unknown source — be conservative |
| `unknown` | 16,000 | ~4K | Default to conservative |

**Detection precedence** (mirrored in both PreCompact and SessionStart hooks):
1. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var — authoritative for telemetry and budget math
2. `ANTHROPIC_DEFAULT_*_MODEL` slug walk — labels the tier for the log
3. 1M default for unknown Anthropic-native models

**Truncation strategy:** when the handover exceeds budget, drop the lowest-priority tail (ISA excerpt is the only truly trimable section) and append a re-read pointer to `MEMORY/WORK/{slug}/ISA.md`. The model can always pull the full artifact on-demand via Read — ILCP principle.

**Override:** `PAIPRECOMPACT_HANDOVER_CHARS` env var for testing and emergency loosening.

**Side effect (good):** the telemetry log now carries `model_tier` and `handover_char_budget` so we can graph "did the budget actually fire for M3?" — the diagnostic for this class of bug is now first-class observability.

## Exit criteria

- M3 sessions no longer re-trigger compaction within the first turn post-compaction (observable: consecutive `pre_compact` events in `context-sessions.jsonl` should be >2 turns apart)
- Handover stdout ≤ 16K chars when `model_tier: m3`
- Handover stdout ≤ 48K chars when `model_tier: sonnet-opus`
- SessionStart `context_window_size` field reflects the env var or model walk (not 200K hardcode)

## Consequences

- Pro: durable fix — the symptom was a feedback loop, the fix breaks it
- Pro: now self-documenting (the budget + tier are in every log line)
- Pro: reusable — same `resolveContextWindow` helper lives in both hooks; if a third hook needs it, extract to `hooks/lib/context-window.ts`
- Con: the ISA summary in the handover is now truncated for M3 sessions; rely on the model to Read the file on-demand instead. Acceptable — the ISA path is stable and the model has direct file access.
- Con: a third copy of `resolveContextWindow` will eventually drift. Mitigation: when extracting to `lib/`, do it in one PR not three.

## Alternatives rejected

- **Lower the trigger threshold further (e.g. 256K cap).** Doesn't fix the symptom — same handover bloat, smaller window.
- **Skip the handover entirely for M3.** Loses continuity that the model genuinely needs post-compaction (work context, decisions, imperatives).
- **Always-emit 4K regardless of model.** Conservative but wastes the cache advantage on Sonnet/Opus.
- **Per-section budgets (ISA = 2K, decisions = 1K, etc.).** More precise but rigid — section priorities shift between Algorithm phases. Single total budget is simpler and the truncation heuristic is good enough.

## Cross-references

- `~/.claude/hooks/PreCompact.hook.ts` — primary change
- `~/.claude/hooks/SessionStart.hook.ts` — hardcode fix
- `~/.claude/minimax.sh` — sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=512000`
- `PAI/MEMORY/KNOWLEDGE/Research/m3-220k-empirical-ceiling-2026-06-18.md` — M3 empirical ceiling rationale
- Auto-memory: `feedback_m3_no_prompt_cache` — why the handover is a per-turn tax on M3