#!/usr/bin/env bun
/**
 * ImperativeExtractor.hook.ts — Extract imperative instructions from user prompts
 *
 * PURPOSE:
 * Incrementally builds a per-session list of "do X" instructions the user
 * issued during the session. The list survives compaction so the model can be
 * reminded of imperatives it might have lost when context was compressed.
 *
 * TRIGGER: UserPromptSubmit (was PostToolUse over assistant turns until
 * 2026-09-27 — that scanned the model's own narration and captured one word)
 *
 * INPUT (stdin JSON):
 *   { session_id, prompt, ... }
 *
 * OUTPUT:
 *   - File: ${PAI_DIR}/MEMORY/STATE/imperatives-${sessionId}.json
 *   - stdout: nothing (UserPromptSubmit stdout would be injected as context)
 *   - stderr: status messages
 *   - exit(0): always (non-blocking)
 *
 * PATTERNS (sentence-level triggers; the whole sentence is stored):
 *   write   → "write to X"
 *   update  → "update X" or "update the X"
 *   format  → "follow/use Algorithm|NATIVE|MINIMAL format|mode"
 *   voice   → "include 🗣️ Munro:"
 *   verify  → "check/verify X before Y"
 *   rule    → sentence opening with always/never/don't/do not/stop
 *
 * PERFORMANCE:
 *   - Non-blocking: Yes
 *   - Typical execution: <50ms (regex over one prompt)
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
const SCHEMA_VERSION = 2; // v2 = sentence-level text; v1 files held single-word captures
const MAX_IMPERATIVES = 50;

type ImperativeKind = 'write' | 'update' | 'format' | 'voice' | 'verify' | 'rule';

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

// Each pattern is a sentence-level trigger. The stored text is the whole
// sentence it fires in — a single captured word ("update to" → "to") carried
// no meaning, which is what the pre-2026-09-27 capture-group design produced.
const PATTERNS: Pattern[] = [
  { kind: 'write',  regex: /\bwrite\s+(?:it\s+|this\s+|that\s+)?to\s+\S/i },
  { kind: 'update', regex: /\bupdate\s+(?:the\s+)?\S/i },
  // Optional tier specifier between mode name and format keyword ("Algorithm E3 format").
  { kind: 'format', regex: /\b(?:follow|use)\s+(?:the\s+)?(?:Algorithm|NATIVE|MINIMAL)\b[\w\s]*?\b(?:format|mode)\b/i },
  { kind: 'voice',  regex: /\binclude\s+(?:the\s+)?🗣️\s*Munro:/iu },
  { kind: 'verify', regex: /\b(?:check|verify)\s+.+?\s+before\s+\S/i },
  // Standing rules must open the sentence — "I don't know why" is not a rule.
  { kind: 'rule',   regex: /^(?:please\s+|and\s+|also\s+)?(?:always|never|don'?t|do\s+not|stop)\b\s+\S/i },
];

const MAX_SENTENCE_CHARS = 240;

interface HookInput {
  session_id?: string;
  prompt?: string;
  [key: string]: unknown;
}

/**
 * Split a user prompt into candidate sentences. Skips fenced code, XML-ish
 * tag lines (pasted content, command expansions), and quoted lines — those
 * aren't the user speaking.
 */
function splitSentences(prompt: string): string[] {
  const withoutFences = prompt.replace(/```[\s\S]*?```/g, '\n');
  const sentences: string[] = [];
  for (const rawLine of withoutFences.split('\n')) {
    const line = rawLine.trim().replace(/^[-*]\s+/, '');
    if (!line || line.startsWith('<') || line.startsWith('>')) continue;
    for (const s of line.split(/(?<=[.!?;])\s+/)) {
      const t = s.trim();
      if (t) sentences.push(t);
    }
  }
  return sentences;
}

/**
 * Extract imperative sentences from one user prompt. Returns deduplicated
 * list with per-imperative count for this prompt.
 */
function extractImperativesFromPrompt(prompt: string): Imperative[] {
  const now = new Date().toISOString();
  const found: Imperative[] = [];

  for (const sentence of splitSentences(prompt)) {
    const kind = PATTERNS.find(p => p.regex.test(sentence))?.kind;
    if (!kind) continue;
    const extracted = sentence.length > MAX_SENTENCE_CHARS
      ? sentence.slice(0, MAX_SENTENCE_CHARS - 1) + '…'
      : sentence;
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
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';

  if (!sessionId || !prompt.trim()) {
    process.exit(0);
  }

  const newImperatives = extractImperativesFromPrompt(prompt);
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