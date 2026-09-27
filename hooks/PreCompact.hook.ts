#!/usr/bin/env bun
/**
 * PreCompact.hook.ts - Preserve Context Before Compaction (PreCompact)
 *
 * PURPOSE:
 * Captures critical session context before Claude Code compresses the
 * conversation. Outputs a structured handover note that survives compaction,
 * ensuring continuity of work-in-progress state, active decisions, and
 * file context across the compression boundary.
 *
 * TRIGGER: PreCompact (both auto and manual)
 *
 * INPUT:
 * - stdin: Hook input JSON (session_id, transcript_path)
 * - Files: MEMORY/STATE/current-work*.json, active plans, task state
 *
 * OUTPUT:
 * - stdout: Structured handover context (preserved through compaction)
 * - stderr: Status messages
 * - exit(0): Always (non-blocking)
 *
 * PERFORMANCE:
 * - Non-blocking: Yes
 * - Typical execution: <100ms
 */

import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { findArtifactPath } from './lib/isa-utils';

const BASE_DIR = process.env.PAI_DIR || join(process.env.HOME!, '.claude', 'PAI');
const MEMORY_DIR = join(BASE_DIR, 'MEMORY');
const STATE_DIR = join(MEMORY_DIR, 'STATE');
const WORK_DIR = join(MEMORY_DIR, 'WORK');
const OBSERVABILITY_DIR = join(MEMORY_DIR, 'OBSERVABILITY');
const CONTEXT_LOG = join(OBSERVABILITY_DIR, 'context-sessions.jsonl');

/**
 * Resolve the active model's context window size for telemetry reporting.
 *
 * Precedence:
 * 1. CLAUDE_CODE_AUTO_COMPACT_WINDOW env var (set by minimax.sh → 512000,
 *    glm.sh → 200000, etc.). This is the authoritative source — CC reads
 *    it for the auto-compact trigger and we mirror it here for telemetry.
 * 2. Walk ANTHROPIC_DEFAULT_*_MODEL env vars for a known slug.
 *    - MiniMax M3 → 512K (PAI shell cap; native 1M but M3 degrades past
 *      ~200K — see PAI/MEMORY/KNOWLEDGE/Research/m3-220k-empirical-ceiling-2026-06-18.md)
 *    - GLM-5.3/5.2 → 200K (5.2 requests auto-route server-side to 5.3 per
 *      Z.ai devpack docs, so both share 5.3's practical serving window;
 *      nominal 1M not yet honored — see PAI/backends/glm.sh); GLM-4.7 → 128K
 *    - Haiku 4.5 → 200K
 *    - Sonnet/Opus 4.6+ → 1M standard (no beta header)
 * 3. Default 1M for unknown Anthropic-native models.
 *
 * NOTE: this slug walk is a fallback only — normal operation always has
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW set by the backend script, so branch 2
 * should rarely fire. Keep it in sync with resolveContextWindow() in
 * SessionStart.hook.ts when adding new model tiers.
 *
 * Also returns a model tier label so the telemetry log can show which
 * sizing branch fired (handy when diagnosing "horns out at 162k" symptoms
 * — the env var or the slug walk is the actual signal).
 */
function resolveContextWindowSize(): { window: number; tier: string } {
  // Highest precedence: explicit compact-window env var
  const envWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  if (envWindow) {
    const parsed = parseInt(envWindow, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      // Don't know which model set this without more work; tag generically
      return { window: parsed, tier: 'env-var' };
    }
  }

  const candidates = [
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    process.env.ANTHROPIC_SMALL_FAST_MODEL,
  ].filter(Boolean) as string[];

  for (const slug of candidates) {
    const lower = slug.toLowerCase();
    if (lower.includes('m3') || lower.includes('minimax')) return { window: 512_000, tier: 'm3' };
    if (lower.includes('glm-5.3') || lower.includes('glm5.3') || lower.includes('glm-5.2') || lower.includes('glm5.2')) return { window: 200_000, tier: 'glm' };
    if (lower.includes('glm-4.7') || lower.includes('glm4.7') || lower.includes('glm')) return { window: 128_000, tier: 'glm' };
    if (lower.includes('haiku')) return { window: 200_000, tier: 'haiku' };
    if (lower.includes('sonnet') || lower.includes('opus')) return { window: 1_000_000, tier: 'sonnet-opus' };
  }
  return { window: 1_000_000, tier: 'unknown' }; // Safe default for current Anthropic-native frontier
}

const { window: CONTEXT_WINDOW_SIZE, tier: CONTEXT_WINDOW_TIER } = resolveContextWindowSize();

/**
 * The handover's max output budget, in characters.
 *
 * Why this matters: M3 has no prompt cache (verified 2026-08-08 — see auto-memory
 * entry `feedback_m3_no_prompt_cache`), so the handover text is re-tokenized every
 * turn. An unbounded handover becomes a constant tax on every response, and right
 * after compaction the handover alone can re-trigger the next compaction before
 * the user has any room to work. That symptom is "horns out at the trigger."
 *
 * Budget policy (model-aware, derived empirically from the empirical-ceiling
 * research doc — the cliff and the trigger math):
 * - m3 (no cache, fast quality degradation): ~16K chars = ~4K tokens
 *   leaves plenty of room for system prompt + memory baseline + skills +
 *   actual conversation in the 512K window before next trigger
 * - sonnet-opus (cache-bearing, 1M window): ~48K chars = ~12K tokens
 *   cache amortizes re-ingestion cost, so we can afford more in the handover
 * - haiku (200K window, small model): ~16K chars = ~4K tokens
 *   matching m3 — small window, no slack for bloat
 * - env-var / unknown: 16K chars default — be conservative when we don't
 *   know what the model can absorb
 *
 * Override at runtime via PAIPRECOMPACT_HANDOVER_CHARS (testing/emergency only).
 */
function resolveHandoverCharBudget(): number {
  const override = process.env.PAIPRECOMPACT_HANDOVER_CHARS;
  if (override) {
    const parsed = parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  switch (CONTEXT_WINDOW_TIER) {
    case 'sonnet-opus': return 48_000;
    case 'm3':
    case 'haiku':
    case 'env-var':
    default: return 16_000;
  }
}

const HANDOVER_CHAR_BUDGET = resolveHandoverCharBudget();

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

function readJSON(path: string): any {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }
}

function getCurrentWork(sessionId?: string): any {
  // Try session-scoped state first
  if (sessionId) {
    const scoped = join(STATE_DIR, `current-work-${sessionId}.json`);
    const data = readJSON(scoped);
    if (data) return data;
  }
  // Fall back to legacy global state
  return readJSON(join(STATE_DIR, 'current-work.json'));
}

/**
 * Read the active session's Ideal State Artifact (ISA.md, or legacy PRD.md).
 * `slug` is the session directory name under MEMORY/WORK/.
 */
function getActiveISA(slug: string): string | null {
  const path = findArtifactPath(slug);
  return path ? readText(path) : null;
}

function getRecentStateFiles(): string[] {
  try {
    if (!existsSync(STATE_DIR)) return [];
    return readdirSync(STATE_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => join(STATE_DIR, f));
  } catch {
    return [];
  }
}

function writePreCompactEntry(sessionId: string | undefined, transcriptPath: string | undefined): void {
  try {
    let contextPct: number | null = null;
    let contextTokensUsed: number | null = null;

    if (transcriptPath && existsSync(transcriptPath)) {
      const bytes = statSync(transcriptPath).size;
      // Rough estimate: JSONL transcript bytes / 4 ≈ tokens (overestimates due to JSON overhead)
      contextTokensUsed = Math.ceil(bytes / 4);
      contextPct = Math.min(99, Math.round((contextTokensUsed / CONTEXT_WINDOW_SIZE) * 100));
    }

    mkdirSync(OBSERVABILITY_DIR, { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(),
      session_id: sessionId ?? null,
      event: 'pre_compact',
      context_pct: contextPct,
      context_tokens_used: contextTokensUsed,
      context_window_size: CONTEXT_WINDOW_SIZE,
      model_tier: CONTEXT_WINDOW_TIER,
      handover_char_budget: HANDOVER_CHAR_BUDGET,
    };
    appendFileSync(CONTEXT_LOG, JSON.stringify(entry) + '\n');
  } catch {
    // Silent fail — never block compaction
  }
}

async function main() {
  // Parse stdin
  let input: HookInput = {};
  try {
    const stdin = await Bun.stdin.text();
    if (stdin.trim()) {
      input = JSON.parse(stdin);
    }
  } catch {
    // Continue with empty input
  }

  // Write context telemetry entry
  writePreCompactEntry(input.session_id, input.transcript_path);

  const sections: string[] = [];

  // Section 1: Current work context
  const work = getCurrentWork(input.session_id);
  if (work) {
    sections.push('## Active Work');
    if (work.description) sections.push(`**Task:** ${work.description}`);
    if (work.directory) sections.push(`**Directory:** ${work.directory}`);
    if (work.status) sections.push(`**Status:** ${work.status}`);
    if (work.started_at) sections.push(`**Started:** ${work.started_at}`);

    // Get ISA if available
    if (work.directory) {
      const dirName = basename(work.directory);
      const isa = getActiveISA(dirName);
      if (isa) {
        // Include first 40 lines of the artifact for context
        const isaLines = isa.split('\n').slice(0, 40);
        sections.push('');
        sections.push('### ISA Summary');
        sections.push(isaLines.join('\n'));
      }
    }

    // Include files changed
    if (work.files_changed && work.files_changed.length > 0) {
      sections.push('');
      sections.push('### Files Modified');
      for (const f of work.files_changed.slice(0, 20)) {
        sections.push(`- ${f}`);
      }
    }

    // Include key decisions
    if (work.decisions && work.decisions.length > 0) {
      sections.push('');
      sections.push('### Key Decisions');
      for (const d of work.decisions) {
        sections.push(`- ${d}`);
      }
    }
  }

  // Section 2: Working directory context
  if (input.cwd) {
    sections.push('');
    sections.push(`## Working Directory`);
    sections.push(`\`${input.cwd}\``);
  }

  // Section 3: Session ID for continuity
  if (input.session_id) {
    sections.push('');
    sections.push(`## Session`);
    sections.push(`ID: ${input.session_id}`);
  }

  // Section 4: Imperatives (ImperativeExtractor state, if present)
  if (input.session_id) {
    const imperativesPath = join(STATE_DIR, `imperatives-${input.session_id}.json`);
    try {
      if (existsSync(imperativesPath)) {
        const impState = JSON.parse(readFileSync(imperativesPath, 'utf-8'));
        if (impState?.imperatives && impState.imperatives.length > 0) {
          sections.push('');
          sections.push('## Imperatives (survive compaction)');
          sections.push('*These instructions were issued earlier in this session and must still be honored:*');
          sections.push('');
          for (const imp of impState.imperatives) {
            const countSuffix = imp.count > 1 ? ` (×${imp.count})` : '';
            sections.push(`- [\`${imp.kind}\`] ${imp.text}${countSuffix}`);
          }
        }
      }
    } catch (err) {
      // Silent fail — imperatives are best-effort, never block compaction
      console.error(`[PreCompact] Imperatives read error: ${err}`);
    }
  }

  // Only output if we have meaningful context
  if (sections.length > 0) {
    let handover = [
      '# Pre-Compaction Handover',
      `*Captured: ${new Date().toISOString()}*`,
      `*Model tier: ${CONTEXT_WINDOW_TIER} | Char budget: ${HANDOVER_CHAR_BUDGET}*`,
      '',
      ...sections,
    ].join('\n');

    // Enforce model-aware budget. This is the durable fix for "horns out
    // at 162K" — M3 has no prompt cache so an oversized handover becomes a
    // constant per-turn re-tokenization tax, immediately re-triggering the
    // next compaction. Truncate the lowest-priority tail (ISA summary is
    // the only truly trimable section; the rest is metadata).
    if (handover.length > HANDOVER_CHAR_BUDGET) {
      const budgetNote =
        `\n\n*Truncated to ${HANDOVER_CHAR_BUDGET} chars for ${CONTEXT_WINDOW_TIER} model — re-read on-demand from MEMORY/WORK/{slug}/ISA.md.*`;
      const maxBody = HANDOVER_CHAR_BUDGET - budgetNote.length - 200; // 200 chars for header
      const body = handover.slice(0, Math.max(0, handover.indexOf('\n\n') + 2));
      const rest = handover.slice(handover.indexOf('\n\n') + 2);
      handover = body + rest.slice(0, maxBody) + budgetNote;
      console.error(`[PreCompact] Handover truncated: tier=${CONTEXT_WINDOW_TIER} budget=${HANDOVER_CHAR_BUDGET} actual=${handover.length}`);
    }

    // stdout: preserved through compaction
    console.log(handover);
    // stderr: status feedback
    console.error(`[PreCompact] Context captured for compaction handover (${handover.length} chars, tier=${CONTEXT_WINDOW_TIER})`);
  } else {
    console.error('[PreCompact] No active work context to preserve');
  }
}

main().catch(err => {
  console.error(`[PreCompact] Error: ${err.message}`);
  process.exit(0); // Non-blocking
});
