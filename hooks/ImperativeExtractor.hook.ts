#!/usr/bin/env bun
/**
 * ImperativeExtractor.hook.ts — Extract imperative instructions from assistant turns
 *
 * PURPOSE:
 * Incrementally builds a per-session list of "do X" instructions issued during
 * the session. The list survives compaction so the model can be reminded of
 * imperatives it might have lost when context was compressed.
 *
 * TRIGGER: PostToolUse
 *
 * INPUT (stdin JSON):
 *   { session_id, transcript_path, tool_name, tool_input, tool_response, ... }
 *
 * OUTPUT:
 *   - File: ${PAI_DIR}/MEMORY/STATE/imperatives-${sessionId}.json
 *   - stderr: status messages
 *   - exit(0): always (non-blocking)
 *
 * PATTERNS (regex with word boundaries to avoid over-matching natural prose):
 *   write   → "write to X" (file/path target)
 *   update  → "update X" or "update the X"
 *   format  → "follow/use Algorithm|NATIVE|MINIMAL format|mode"
 *   voice   → "include 🗣️ Munro:"
 *   verify  → "check/verify X before Y"
 *
 * PERFORMANCE:
 *   - Non-blocking: Yes
 *   - Typical execution: <50ms (regex over latest assistant turn only)
 *   - Atomic write: tmp + rename (no partial state on crash)
 *
 * REFINED FROM FORGE DRAFT (2026-06-17):
 *   - Removed broken fs.flock stub (Node has no native flock; PostToolUse fires serially anyway)
 *   - Fixed transcript parsing: content is array of blocks, not string
 *   - Switched to Bun.stdin.text() for consistency with sibling hooks
 *   - Added session_id validation (skip if undefined)
 *   - Added schema_version check on read (skip file if mismatched)
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';

const PAI_DIR = process.env.PAI_DIR || join(process.env.HOME || '', '.claude', 'PAI');
const STATE_DIR = join(PAI_DIR, 'MEMORY', 'STATE');
const SCHEMA_VERSION = 1;
const MAX_IMPERATIVES = 50;

type ImperativeKind = 'write' | 'update' | 'format' | 'voice' | 'verify';

interface Imperative {
  kind: ImperativeKind;
  text: string;
  count: number;
  first_seen: string;
  last_seen: string;
}

interface ImperativeState {
  schema_version: number;
  session_id: string;
  created_at: string;
  updated_at: string;
  imperatives: Imperative[];
}

interface Pattern {
  kind: ImperativeKind;
  regex: RegExp;
}

const PATTERNS: Pattern[] = [
  { kind: 'write',  regex: /\bwrite\s+to\s+([A-Z][\w./-]+)/gi },
  { kind: 'update', regex: /\bupdate\s+(?:the\s+)?([A-Z][\w./-]+)/gi },
  // Format pattern allows optional tier specifier between mode name and format keyword
  // (e.g., "Algorithm E3 format", "Algorithm format", "NATIVE mode").
  { kind: 'format', regex: /\b(?:follow|use)\s+(?:the\s+)?(Algorithm|NATIVE|MINIMAL|ALGORITHM)\b[\w\s]*?(?:format|mode)/gi },
  { kind: 'voice',  regex: /\binclude\s+(?:the\s+)?🗣️\s+Munro:/giu },
  { kind: 'verify', regex: /\b(?:check|verify)\s+([\w\s]+?)\s+before\s+([\w\s]+)/gi },
];

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  [key: string]: unknown;
}

/**
 * Read the latest assistant turn text from a Claude Code transcript.jsonl.
 * Content is an array of content blocks; we extract only type==='text' blocks.
 */
function getLatestAssistantTurn(transcriptPath: string): string | null {
  if (!existsSync(transcriptPath)) return null;
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    // Walk backwards — most recent assistant message
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: any;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      // Anthropic transcript shape: { type: "assistant", message: { content: [...] } }
      // OR legacy: { role: "assistant", content: ... }
      const isAssistant =
        entry?.type === 'assistant' ||
        entry?.role === 'assistant' ||
        entry?.message?.role === 'assistant';
      if (!isAssistant) continue;

      const content = entry?.message?.content ?? entry?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const textBlocks = content
          .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text);
        if (textBlocks.length > 0) return textBlocks.join('\n');
      }
      return null;
    }
    return null;
  } catch (err) {
    console.error(`[ImperativeExtractor] Transcript read error: ${err}`);
    return null;
  }
}

/**
 * Extract imperative matches from a text string. Returns deduplicated list
 * with per-imperative count for this turn.
 */
function extractImperativesFromTurn(text: string): Imperative[] {
  const now = new Date().toISOString();
  const found: Imperative[] = [];

  for (const { kind, regex } of PATTERNS) {
    // Reset regex state for global flag
    regex.lastIndex = 0;
    const matches = [...text.matchAll(regex)];
    for (const match of matches) {
      // Use capture group if present, else full match (for patterns without capture)
      const extracted = (match[1] ?? match[0]).trim();
      const existing = found.find(i => i.kind === kind && i.text === extracted);
      if (existing) {
        existing.count++;
      } else {
        found.push({
          kind,
          text: extracted,
          count: 1,
          first_seen: now,
          last_seen: now,
        });
      }
    }
  }

  return found;
}

function readState(filePath: string): ImperativeState | null {
  try {
    if (!existsSync(filePath)) return null;
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    // Schema version gate: skip mismatched files (future migrations)
    if (data?.schema_version !== SCHEMA_VERSION) {
      console.error(`[ImperativeExtractor] Schema mismatch (${data?.schema_version} vs ${SCHEMA_VERSION}); skipping`);
      return null;
    }
    return data as ImperativeState;
  } catch (err) {
    console.error(`[ImperativeExtractor] State read error: ${err}`);
    return null;
  }
}

function writeStateAtomic(filePath: string, state: ImperativeState): void {
  const tmpPath = `${filePath}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    renameSync(tmpPath, filePath);
  } catch (err) {
    console.error(`[ImperativeExtractor] State write error: ${err}`);
  }
}

async function main() {
  // Parse stdin — matches sibling hook pattern
  let input: HookInput = {};
  try {
    const stdin = await Bun.stdin.text();
    if (stdin.trim()) {
      input = JSON.parse(stdin);
    }
  } catch (err) {
    console.error(`[ImperativeExtractor] stdin parse error: ${err}`);
    process.exit(0);
  }

  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;

  if (!sessionId || !transcriptPath) {
    process.exit(0);
  }

  const assistantText = getLatestAssistantTurn(transcriptPath);
  if (!assistantText) {
    process.exit(0);
  }

  const newImperatives = extractImperativesFromTurn(assistantText);
  if (newImperatives.length === 0) {
    process.exit(0);
  }

  // Merge into existing state
  const stateFile = join(STATE_DIR, `imperatives-${sessionId}.json`);
  const now = new Date().toISOString();

  let state = readState(stateFile);
  if (!state) {
    state = {
      schema_version: SCHEMA_VERSION,
      session_id: sessionId,
      created_at: now,
      updated_at: now,
      imperatives: [],
    };
  }

  for (const newImp of newImperatives) {
    const existing = state.imperatives.find(
      i => i.kind === newImp.kind && i.text === newImp.text
    );
    if (existing) {
      existing.count += newImp.count;
      existing.last_seen = now;
    } else {
      state.imperatives.push(newImp);
    }
  }

  // FIFO prune to MAX_IMPERATIVES (keep most recent)
  if (state.imperatives.length > MAX_IMPERATIVES) {
    state.imperatives = state.imperatives.slice(-MAX_IMPERATIVES);
  }

  state.updated_at = now;

  // Ensure STATE_DIR exists
  if (!existsSync(STATE_DIR)) {
    try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* ignore */ }
  }

  writeStateAtomic(stateFile, state);
  console.error(`[ImperativeExtractor] Captured ${newImperatives.length} imperatives (total: ${state.imperatives.length})`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[ImperativeExtractor] Unhandled error: ${err}`);
  process.exit(0);
});