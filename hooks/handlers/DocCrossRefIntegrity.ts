/**
 * DocCrossRefIntegrity.ts - Hybrid doc integrity checker (deterministic + inference)
 *
 * Two-layer approach:
 * Layer 1 (Deterministic): Grep-based pattern checks for broken refs, counts, timestamps
 * Layer 2 (Inference): AI analysis of semantic drift using TOOLS/Inference.ts standard tier, cloud only
 *
 * The deterministic layer detects WHAT changed. The inference layer understands
 * HOW docs need updating — generating surgical edit pairs, never full rewrites.
 *
 * TRIGGER: Stop hook (via DocIntegrity.hook.ts)
 *
 * PATTERN TYPES CHECKED (deterministic):
 * 1. Hook file references (*.hook.ts) - diff against disk
 * 2. Handler file references (handlers/*.ts) - diff against disk
 * 3. Shared lib references (hooks/lib/*.ts) - diff against disk
 * 4. SYSTEM doc path references - validate files exist
 * 5. Numeric counts (e.g., "21 hooks active") - recount from disk
 * 6. Last Updated timestamps - update on modification
 *
 * INFERENCE ANALYSIS (detached since 2026-09-26):
 * 7. Semantic drift - doc descriptions vs actual file behavior.
 *    Runs in handlers/DocSemanticWorker.ts, a detached process, so Stop never
 *    blocks on inference. Inline it cost ~45s per Stop: a ~5K-token prompt
 *    needs ~17s on the local 80B against a 15s timeout, then the Claude and
 *    local-retry fallbacks each timed out too. The worker queues PROPOSED edits
 *    to MEMORY/STATE/doc-semantic-queue.json. They are not auto-applied: the
 *    first live run's 3 auto-applied edits included one that was wrong about a
 *    security inspector. Since 2026-09-27 the worker calls Claude only (no local
 *    model, no local fallback), and proposals wait up to 7 days for review. The
 *    queue surfaces at session start via LoadContext (lib/doc-review-digest.ts), not as
 *    a Stop block. DocEditReview.ts applies or rejects them and reports the
 *    acceptance rate (`stats`). The worker
 *    is spawned only when the modified-file set has no `ok` run yet and no
 *    worker is running.
 *
 * AUDIT TRAIL: All operations logged to stderr via [DocAutoUpdate] prefix;
 * worker runs log to MEMORY/STATE/doc-semantic.log
 *
 * SIDE EFFECTS:
 * - Updates timestamps, counts (deterministic)
 * - Spawns the detached semantic worker (which only writes the proposal queue)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync, openSync, closeSync, renameSync, appendFileSync } from 'fs';
import { join, basename } from 'path';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { paiPath, getPaiDir, getClaudeDir } from '../lib/paths';
import { isFresh } from '../lib/doc-review-digest';
import { inference } from '../../PAI/TOOLS/Inference';
import type { ParsedTranscript } from '../../PAI/TOOLS/TranscriptParser';


// ============================================================================
// Types
// ============================================================================

interface HookInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
}

interface DriftItem {
  doc: string;
  pattern: string;
  reference: string;
  issue: string;
}

// ============================================================================
// Constants
// ============================================================================

const SYSTEM_DIR = getPaiDir();
const DOCS_DIR = join(SYSTEM_DIR, 'DOCUMENTATION');
const HOOKS_DIR = join(getClaudeDir(), 'hooks');
const HANDLERS_DIR = join(HOOKS_DIR, 'handlers');
const LIB_DIR = join(HOOKS_DIR, 'lib');
const TAG = '[DocAutoUpdate]';
const STATE_DIR = join(SYSTEM_DIR, 'MEMORY', 'STATE');
export const SEMANTIC_QUEUE = join(STATE_DIR, 'doc-semantic-queue.json');
export const SEMANTIC_LOCK = join(STATE_DIR, 'doc-semantic.lock');
export const SEMANTIC_LOG = join(STATE_DIR, 'doc-semantic.log');
export const SEMANTIC_STATE = join(STATE_DIR, 'doc-semantic-state.json');
const WORKER_PATH = join(HANDLERS_DIR, 'DocSemanticWorker.ts');
/** Auto-generated docs (header says "Do not edit manually"); semantic edits to these get overwritten. */
const GENERATED_DOCS = new Set(['ARCHITECTURE_SUMMARY.md']);
const DOC_CONTEXT_BUDGET = 12_000; // chars of doc sections per doc, whole sections only
const TOTAL_DOC_BUDGET = 60_000; // across all docs; a section that would cross either budget is dropped (and logged), never cut
const SOURCE_LINES = 150; // header + enough code to see behavior; cloud context affords more than the old 60

// ============================================================================
// Filesystem Inventory
// ============================================================================

function listFiles(dir: string, suffix: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith(suffix))
      .sort();
  } catch {
    return [];
  }
}

function getHookFilesOnDisk(): string[] {
  return listFiles(HOOKS_DIR, '.hook.ts');
}

function getHandlerFilesOnDisk(): string[] {
  return listFiles(HANDLERS_DIR, '.ts');
}

function getLibFilesOnDisk(): string[] {
  return listFiles(LIB_DIR, '.ts');
}

function getSystemDocsOnDisk(): string[] {
  return listFiles(DOCS_DIR, '.md');
}

// ============================================================================
// Transcript Parsing
// ============================================================================

function getModifiedFiles(transcriptPath: string): Set<string> {
  const modified = new Set<string>();
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Handle both transcript formats
        if (entry.type === 'tool_use' && (entry.name === 'Write' || entry.name === 'Edit')) {
          const path = entry.input?.file_path || '';
          if (path) modified.add(path);
        }
        if (entry.type === 'assistant' && entry.message?.content) {
          const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
          for (const block of blocks) {
            if (block.type === 'tool_use' && (block.name === 'Write' || block.name === 'Edit')) {
              const path = block.input?.file_path || '';
              if (path) modified.add(path);
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch (error) {
    console.error(`${TAG} Failed to parse transcript:`, error);
  }
  return modified;
}

function isSystemDocModified(modifiedFiles: Set<string>): boolean {
  for (const path of modifiedFiles) {
    if (path.includes('PAI/') && path.endsWith('.md')) return true;
  }
  return false;
}

function isHookModified(modifiedFiles: Set<string>): boolean {
  for (const path of modifiedFiles) {
    if (path.includes('/hooks/') && path.endsWith('.ts')) return true;
  }
  return false;
}

/**
 * Check if ANY meaningful PAI system file was modified.
 * PAI spans TWO root directories:
 *   - CLAUDE_DIR (~/.claude) — hooks, skills, settings, agents, CLAUDE.md
 *   - PAI_DIR (~/.claude/PAI) — PAI data, Tools, Components, Workflows, SYSTEM docs
 * Excludes MEMORY/WORK, MEMORY/LEARNING, MEMORY/STATE, and other non-system paths.
 */
function isSystemFileModified(modifiedFiles: Set<string>): boolean {
  const PAI_DIR = getPaiDir();
  const CLAUDE_DIR = getClaudeDir();
  const PAI_EXCLUDED = ['MEMORY/WORK/', 'MEMORY/LEARNING/', 'MEMORY/STATE/', 'Plans/', '.git/', 'node_modules/', 'ShellSnapshots/', 'MEMORY/VOICE/', 'MEMORY/RELATIONSHIP/', 'history.jsonl', '.quote-cache'];
  const CLAUDE_EXCLUDED = ['projects/', '.git/', 'node_modules/', 'history.jsonl'];

  for (const filePath of modifiedFiles) {
    // --- Check ~/.claude/ paths ---
    if (filePath.startsWith(CLAUDE_DIR + '/')) {
      const relPath = filePath.slice(CLAUDE_DIR.length + 1);
      if (CLAUDE_EXCLUDED.some(ex => relPath.includes(ex))) continue;

      if (relPath.startsWith('hooks/') && (relPath.endsWith('.ts') || relPath.endsWith('.sh'))) return true;
      if (relPath.startsWith('skills/') && (relPath.endsWith('.md') || relPath.endsWith('.ts') || relPath.endsWith('.yaml') || relPath.endsWith('.yml'))) return true;
      if (relPath === 'settings.json') return true;
      if (relPath === 'CLAUDE.md') return true;
      if (relPath.startsWith('agents/') && relPath.endsWith('.md')) return true;
      if (relPath.startsWith('custom-agents/') && relPath.endsWith('.md')) return true;
      if (relPath.startsWith('commands/') && relPath.endsWith('.md')) return true;
      continue;
    }

    // --- Check ~/.claude/PAI/ paths ---
    if (filePath.startsWith(PAI_DIR + '/')) {
      const relPath = filePath.slice(PAI_DIR.length + 1);
      if (PAI_EXCLUDED.some(ex => relPath.includes(ex))) continue;

      if ((relPath.startsWith('PAI/') || relPath.includes('skills/')) && (relPath.endsWith('.md') || relPath.endsWith('.ts') || relPath.endsWith('.yaml') || relPath.endsWith('.yml'))) return true;
      if (relPath.includes('/Tools/') && relPath.endsWith('.ts')) return true;
      if (relPath.includes('/Workflows/') && relPath.endsWith('.md')) return true;
      continue;
    }
  }
  return false;
}

// ============================================================================
// Pattern Checkers
// ============================================================================

/**
 * Check Pattern 2: Hook file references in docs vs actual files on disk.
 */
function checkHookFileRefs(docsToCheck: string[], hooksOnDisk: Set<string>): DriftItem[] {
  const drift: DriftItem[] = [];
  const hookRefRegex = /(\w+)\.hook\.ts/g;

  for (const docFile of docsToCheck) {
    const docPath = join(DOCS_DIR, docFile);
    if (!existsSync(docPath)) continue;

    const content = readFileSync(docPath, 'utf-8');
    let match: RegExpExecArray | null;

    while ((match = hookRefRegex.exec(content)) !== null) {
      const hookName = match[0]; // e.g., "LoadContext.hook.ts"
      if (!hooksOnDisk.has(hookName)) {
        drift.push({
          doc: docFile,
          pattern: 'hook_file_ref',
          reference: hookName,
          issue: `References "${hookName}" but file does not exist on disk`,
        });
      }
    }
  }

  return drift;
}

/**
 * Check Pattern 3: Handler file references in docs vs actual files on disk.
 */
function checkHandlerFileRefs(docsToCheck: string[], handlersOnDisk: Set<string>): DriftItem[] {
  const drift: DriftItem[] = [];
  const handlerRefRegex = /handlers\/(\w+)\.ts/g;

  for (const docFile of docsToCheck) {
    const docPath = join(DOCS_DIR, docFile);
    if (!existsSync(docPath)) continue;

    const content = readFileSync(docPath, 'utf-8');
    let match: RegExpExecArray | null;

    while ((match = handlerRefRegex.exec(content)) !== null) {
      const handlerFilename = `${match[1]}.ts`;
      if (!handlersOnDisk.has(handlerFilename)) {
        drift.push({
          doc: docFile,
          pattern: 'handler_file_ref',
          reference: match[0],
          issue: `References "${match[0]}" but "${handlerFilename}" does not exist in handlers/`,
        });
      }
    }
  }

  return drift;
}

/**
 * Check Pattern 4: Shared lib file references in docs vs actual files on disk.
 */
function checkLibFileRefs(docsToCheck: string[], libsOnDisk: Set<string>): DriftItem[] {
  const drift: DriftItem[] = [];
  const libRefRegex = /hooks\/lib\/([\w-]+)\.ts/g;

  for (const docFile of docsToCheck) {
    const docPath = join(DOCS_DIR, docFile);
    if (!existsSync(docPath)) continue;

    const content = readFileSync(docPath, 'utf-8');
    let match: RegExpExecArray | null;

    while ((match = libRefRegex.exec(content)) !== null) {
      const libFilename = `${match[1]}.ts`;
      if (!libsOnDisk.has(libFilename)) {
        drift.push({
          doc: docFile,
          pattern: 'lib_file_ref',
          reference: match[0],
          issue: `References "${match[0]}" but "${libFilename}" does not exist in hooks/lib/`,
        });
      }
    }
  }

  return drift;
}

/**
 * Check Pattern 1: SYSTEM doc cross-references validate target files exist.
 */
function checkSystemDocRefs(docsToCheck: string[], systemDocsOnDisk: Set<string>): DriftItem[] {
  const drift: DriftItem[] = [];
  // Match backtick-wrapped or plain doc references in PAI/ (both old skills/PAI/ and new PAI/ paths)
  const sysDocRefRegex = /(?:`|'|")(?:~\/\.(?:claude|config\/PAI)\/)?(?:skills\/)?PAI\/([\w/]+\.md)(?:`|'|")/g;

  for (const docFile of docsToCheck) {
    const docPath = join(DOCS_DIR, docFile); // was SYSTEM_DIR: the check never read a doc until 2026-09-26
    if (!existsSync(docPath)) continue;

    const content = readFileSync(docPath, 'utf-8');
    let match: RegExpExecArray | null;

    while ((match = sysDocRefRegex.exec(content)) !== null) {
      const refTarget = match[1]; // e.g., "DOCUMENTATION/PAISystemArchitecture.md" or "PAISECURITYSYSTEM/ARCHITECTURE.md"
      const targetBasename = basename(refTarget);
      // Check SYSTEM_DIR first (for nested paths like PAISECURITYSYSTEM/ARCHITECTURE.md),
      // then DOCS_DIR (for bare basenames that refer to files relocated under DOCUMENTATION/).
      const systemPath = join(SYSTEM_DIR, refTarget);
      const docsPath = join(DOCS_DIR, refTarget);
      if (!existsSync(systemPath) && !existsSync(docsPath)) {
        drift.push({
          doc: docFile,
          pattern: 'system_doc_ref',
          reference: `PAI/${refTarget}`,
          issue: `References "PAI/${refTarget}" but file does not exist`,
        });
      }
    }
  }

  return drift;
}

/**
 * Check Pattern 5: Numeric hook counts in docs vs actual count on disk.
 */
function checkHookCounts(docsToCheck: string[], actualCount: number): DriftItem[] {
  const drift: DriftItem[] = [];
  // Match "N hooks active" or "N hooks running" patterns, NOT in example/anti-pattern contexts
  const countRegex = /\*\*Status:\*\*.*?(\d+) hooks? active/g;

  for (const docFile of docsToCheck) {
    const docPath = join(DOCS_DIR, docFile);
    if (!existsSync(docPath)) continue;

    const content = readFileSync(docPath, 'utf-8');
    let match: RegExpExecArray | null;

    while ((match = countRegex.exec(content)) !== null) {
      const docCount = parseInt(match[1], 10);
      if (docCount !== actualCount) {
        drift.push({
          doc: docFile,
          pattern: 'hook_count',
          reference: match[0],
          issue: `States "${docCount} hooks active" but actual count on disk is ${actualCount}`,
        });
      }
    }
  }

  return drift;
}

// ============================================================================
// Desktop Notification (fire-and-forget)
// ============================================================================

async function notifyVoice(message: string): Promise<void> {
  try {
    await fetch('http://localhost:31337/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({ message }),
    });
  } catch {
    // Pulse may not be running — silent fail
  }
}

// ============================================================================
// Inference-Powered Semantic Analysis
// ============================================================================

export interface InferenceEdit {
  doc: string;
  old_text: string;
  new_text: string;
  reason: string;
  queuedAt?: string; // set by the worker; edits failing isFresh (7 days) are dropped at claim
}

export const INFERENCE_SYSTEM_PROMPT = `You are a documentation accuracy checker. You receive:
1. A list of source files that were modified (with their current content)
2. Documentation sections that reference those files

Your job: identify where documentation is now FACTUALLY INCORRECT given the source changes.

OUTPUT FORMAT: Return a JSON array of surgical edits:
[{"doc": "filename.md", "old_text": "exact text to replace", "new_text": "corrected text", "reason": "brief explanation"}]

RULES (CRITICAL):
- Update anything that is NOW FACTUALLY WRONG because of the source changes
- This includes: file names, descriptions of behavior, counts, paths, handler lists, process descriptions
- If a system was fundamentally redesigned, update the doc sections that describe it to match the new reality
- old_text must be an EXACT substring from the doc (copy-paste precision), and the SHORTEST span that is unique in that doc: usually one line or sentence, never over 300 characters. Long spans get the response truncated
- new_text replaces only that span, so keep it the same size unless the fact itself needs more words
- new_text should change ONLY the parts affected by the source change — preserve everything else exactly
- The user's original INTENT and PHILOSOPHY must be preserved — update facts, never change the "why" or design rationale unless it was explicitly invalidated by the change
- Writing style, tone, and voice must stay exactly as-is
- DO NOT "improve" or "clean up" text that wasn't affected by the change
- DO NOT add commentary, opinions, or explanations beyond what was already there
- "doc" must be one of the names under EDITABLE DOCS. Never edit a SOURCE FILE: source is the truth, docs follow it
- Only claim what the SOURCE FILES shown prove. Whether a file, rules list or config exists on disk, or whether something is wired and live, is NOT visible in source: never edit a deployment fact ("inert", "active", "enabled", "not present")
- These docs ship in a PUBLIC release. Never ADD names of private or work-client skills, hosts, IPs, people, companies or customers, even when the source lists them; describe the mechanism generically ("work-client skills are stripped")
- Each doc section is shown whole; a section that ends abruptly ends there in the file. Never "complete" a sentence
- If nothing is factually wrong given the changes, return an empty array: []
- Maximum 5 edits per response, most important first

Return ONLY the JSON array, no other text.`;

/**
 * Build context for inference: what changed and what docs say about it.
 * Keeps context small for fast inference (~500ms target).
 */
export function buildInferenceContext(
  modifiedFiles: Set<string>,
  docsToCheck: string[],
): { context: string; editable: string[] } {
  const parts: string[] = [];

  // Source = code and config whose behavior the docs describe. Not session state
  // (MEMORY/ ISAs, knowledge notes), not CLAUDE.md, not docs themselves: the model
  // can't usefully "fix" those, and before 2026-09-26 it spent every edit trying.
  const relevantFiles = Array.from(modifiedFiles).filter(isDocumentedSource);

  // Docs first: without a doc section that names a changed file there is nothing
  // to check, so don't spend an inference call on source alone.
  const docParts: string[] = [];
  // Collect doc sections that reference modified files
  // For each affected doc, extract the FULL section (## heading to next ## heading)
  // so inference has enough context to make quality corrections
  const referenced = new Set<string>();
  let totalDocChars = 0;
  for (const docFile of docsToCheck) {
    // Generated docs get overwritten by their generator; fix the source doc instead.
    if (GENERATED_DOCS.has(docFile)) continue;
    // docsToCheck are basenames from DOCS_DIR. This joined SYSTEM_DIR until
    // 2026-09-26, so no doc was ever found and the model only saw source files.
    const docPath = join(DOCS_DIR, docFile);
    if (!existsSync(docPath)) continue;

    try {
      const content = readFileSync(docPath, 'utf-8');
      // Check if this doc references any modified file
      const referencesModified = relevantFiles.some(f => mentions(content, f));

      if (referencesModified) {
        // Extract full sections that reference changed files
        const lines = content.split('\n');
        const sections: { text: string; refs: Set<string> }[] = [];
        let currentSection: string[] = [];
        let currentRefs = new Set<string>();
        let inFence = false; // "# comment" lines inside code fences are not headings

        const flush = () => {
          if (currentRefs.size > 0 && currentSection.length > 0) sections.push({ text: currentSection.join('\n'), refs: currentRefs });
        };
        for (let i = 0; i < lines.length; i++) {
          if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
          const isHeading = !inFence && /^#{1,3} /.test(lines[i]);

          if (isHeading && currentSection.length > 0) {
            flush();
            currentSection = [lines[i]];
            currentRefs = new Set<string>();
          } else {
            currentSection.push(lines[i]);
          }

          for (const f of relevantFiles) {
            if (mentions(lines[i], f)) currentRefs.add(f);
          }
        }
        flush();

        if (sections.length > 0) {
          // Budget by whole sections. A character slice cut sections mid-sentence, and on
          // 2026-09-27 the model "completed" a sentence that was only truncated in its context.
          const kept: string[] = [];
          let size = 0;
          for (const s of sections) {
            if (size + s.text.length > DOC_CONTEXT_BUDGET || totalDocChars + s.text.length > TOTAL_DOC_BUDGET) continue;
            kept.push(s.text);
            size += s.text.length;
            totalDocChars += s.text.length;
            s.refs.forEach(f => referenced.add(f)); // only sources whose doc text the model will see
          }
          if (kept.length < sections.length) {
            console.error(`${TAG} [INFERENCE] ${docFile}: dropped ${sections.length - kept.length} of ${sections.length} section(s) over budget`);
          }
          if (kept.length === 0) continue;
          docParts.push(`=== DOC: ${docFile} (affected sections, each shown whole) ===\n${kept.join('\n\n---\n\n')}\n`);
        }
      }
    } catch {
      // Skip unreadable
    }
  }

  if (docParts.length === 0) return { context: '', editable: [] };
  const editable = docParts.map(p => p.match(/^=== DOC: (\S+)/)?.[1]).filter((d): d is string => !!d);

  // Only the source files some doc actually mentions, most recently touched first.
  const sources = relevantFiles.filter(f => referenced.has(f)).reverse().slice(0, 5);
  for (const filePath of sources) {
    try {
      if (!existsSync(filePath)) continue;
      const lines = readFileSync(filePath, 'utf-8').split('\n');
      // Take the doc comment header + enough code to understand behavior
      parts.push(`=== SOURCE FILE: ${basename(filePath)} ===\n${lines.slice(0, SOURCE_LINES).join('\n')}\n`);
    } catch {
      // Skip unreadable
    }
  }

  parts.push(...docParts);
  parts.push(`=== EDITABLE DOCS (the only valid "doc" values) ===\n${editable.join('\n')}\n`);
  return { context: parts.join('\n'), editable };
}

/** Shape + target check, shared by the worker (at queue time) and the hook (at apply time). */
function editProblem(edit: InferenceEdit, editable: Set<string> | null): string | null {
  if (!edit || typeof edit.doc !== 'string' || typeof edit.old_text !== 'string' ||
      typeof edit.new_text !== 'string' || typeof edit.reason !== 'string' || !edit.old_text) {
    return 'malformed edit';
  }
  if (edit.doc !== basename(edit.doc)) return `doc must be a bare filename, got ${edit.doc}`;
  if (GENERATED_DOCS.has(edit.doc)) return `${edit.doc} is generated; edits get overwritten`;
  if (editable && !editable.has(edit.doc)) return `${edit.doc} was not in the EDITABLE DOCS list`;
  if (edit.old_text === edit.new_text) return 'no-op edit';
  return null;
}

/** Code/config whose behavior docs describe. Excludes session state, knowledge notes and markdown. */
function isDocumentedSource(f: string): boolean {
  if (f.includes('/MEMORY/') || f.includes('/USER/') || f.endsWith('.md') || f.endsWith('.jsonl')) return false;
  return f.includes('/hooks/') || f.includes('/PAI/TOOLS/') || f.includes('/PAI/PULSE/') ||
    (f.includes('/skills/') && f.endsWith('.ts')) || f.endsWith('settings.json');
}

/**
 * Whole-word mention of a source file's stem. Stems under 6 chars ("ISA", "paths") match too much prose,
 * so those need the full filename. Deliberate precision-over-recall trade (DeepSeek audit #6, 2026-09-26):
 * a doc saying only "paths" won't be checked when paths.ts changes.
 */
function mentions(text: string, file: string): boolean {
  const stem = basename(file).replace(/\.hook\.ts$|\.ts$|\.json$/, '');
  if (stem.length < 6) return text.includes(basename(file));
  return new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
}

/**
 * Run inference to detect semantic drift and generate surgical edits.
 * Called from the detached DocSemanticWorker, never inline in the Stop hook.
 */
export interface AnalysisResult { ok: boolean; edits: InferenceEdit[]; error?: string }

export async function runInferenceAnalysis(
  modifiedFiles: Set<string>,
  docsToCheck: string[],
  timeoutMs: number,
): Promise<AnalysisResult> {
  const startTime = Date.now();

  const { context, editable } = buildInferenceContext(modifiedFiles, docsToCheck);
  if (!context.trim()) {
    console.error(`${TAG} [INFERENCE] No doc mentions a changed source file, nothing to check`);
    return { ok: true, edits: [] };
  }
  const editableSet = new Set(editable);

  console.error(`${TAG} [INFERENCE] Running semantic analysis (standard tier, cloud only, ${timeoutMs}ms budget)...`);
  console.error(`${TAG} [INFERENCE] Context size: ${context.length} chars`);

  try {
    // Cloud only (2026-09-27). `standard` is in prefer_local_for_levels, which sent this to
    // the local 80B: 0 of ~9 reviewed proposals were accepted. It runs detached, so latency
    // is free. No local fallback: skipping a run beats queueing proposals that get rejected.
    const result = await inference({
      systemPrompt: INFERENCE_SYSTEM_PROMPT,
      userPrompt: `Analyze these source file changes and documentation sections for factual inaccuracies:\n\n${context}`,
      level: 'standard',
      localFirst: false,
      fallbackToOllama: false,
      expectJson: true,
      timeout: timeoutMs,
      maxTokens: 4096, // local-path cap only; kept in case localFirst is ever flipped back
    });

    const elapsed = Date.now() - startTime;
    console.error(`${TAG} [INFERENCE] Completed in ${elapsed}ms (success: ${result.success})`);

    if (!result.success) {
      console.error(`${TAG} [INFERENCE] Failed: ${result.error}`);
      return { ok: false, edits: [], error: result.error ?? 'inference failed' };
    }

    // Parse and validate edits
    // Models often wrap the array ({"edits":[...]}); accept the first array-valued field.
    let rawEdits = result.parsed as unknown;
    if (rawEdits && !Array.isArray(rawEdits) && typeof rawEdits === 'object') {
      rawEdits = Object.values(rawEdits as Record<string, unknown>).find(Array.isArray);
    }
    if (!Array.isArray(rawEdits)) {
      const raw = result.output.slice(0, 300).replace(/\n/g, ' ');
      console.error(`${TAG} [INFERENCE] Response was not a JSON array. Raw: ${raw}`);
      return { ok: false, edits: [], error: `response not a JSON array: ${raw.slice(0, 120)}` };
    }

    // Validate each edit's shape and target, and that old_text exists in the doc
    const validEdits: InferenceEdit[] = [];
    for (const edit of rawEdits.slice(0, 5)) { // Max 5 edits (matches the prompt)
      const problem = editProblem(edit, editableSet);
      if (problem) {
        if (problem !== 'no-op edit') console.error(`${TAG} [INFERENCE] Skipping edit: ${problem}`);
        continue;
      }
      const docPath = join(DOCS_DIR, edit.doc);
      const docContent = existsSync(docPath) ? readFileSync(docPath, 'utf-8') : '';
      const at = docContent.indexOf(edit.old_text);
      if (at < 0) {
        console.error(`${TAG} [INFERENCE] old_text not found in ${edit.doc}, skipping: "${edit.old_text.slice(0, 60)}..."`);
        continue;
      }
      if (at !== docContent.lastIndexOf(edit.old_text)) {
        console.error(`${TAG} [INFERENCE] old_text is not unique in ${edit.doc}, skipping: "${edit.old_text.slice(0, 60)}..."`);
        continue;
      }
      validEdits.push({ ...edit, queuedAt: new Date().toISOString() });
    }

    console.error(`${TAG} [INFERENCE] ${validEdits.length} valid edits from ${rawEdits.length} raw`);
    return { ok: true, edits: validEdits };
  } catch (error) {
    console.error(`${TAG} [INFERENCE] Error: ${error}`);
    return { ok: false, edits: [], error: String(error) };
  }
}

/**
 * Apply inference-generated edits to documentation files.
 * Each edit is a surgical find-and-replace with full audit logging.
 */
export function applyInferenceEdits(edits: InferenceEdit[]): string[] {
  const applied: string[] = [];

  for (const edit of edits) {
    const problem = editProblem(edit, null);
    if (problem) {
      console.error(`${TAG} [INFERENCE-APPLY] Skipping queued edit: ${problem}`);
      continue;
    }
    const docPath = join(DOCS_DIR, edit.doc);
    try {
      const content = readFileSync(docPath, 'utf-8');
      if (!content.includes(edit.old_text)) {
        console.error(`${TAG} [INFERENCE-APPLY] old_text no longer found in ${edit.doc}, skipping`);
        continue;
      }

      if (content.indexOf(edit.old_text) !== content.lastIndexOf(edit.old_text)) {
        console.error(`${TAG} [INFERENCE-APPLY] old_text is not unique in ${edit.doc}, skipping`);
        continue;
      }
      // Function replacement: a string would interpret $1/$&/$` in new_text (shell examples in docs).
      const updated = content.replace(edit.old_text, () => edit.new_text);
      writeFileSync(docPath, updated);

      const summary = `[INFERENCE] ${edit.doc}: ${edit.reason} ("${edit.old_text.slice(0, 40)}..." → "${edit.new_text.slice(0, 40)}...")`;
      console.error(`${TAG} [UPDATED] ${summary}`);
      applied.push(summary);
    } catch (error) {
      console.error(`${TAG} [INFERENCE-APPLY] Failed on ${edit.doc}: ${error}`);
    }
  }

  return applied;
}

// ============================================================================
// Deterministic Updates (safe auto-fixes)
// ============================================================================

/**
 * Update Pattern 6: Last Updated timestamps in modified docs.
 */
function updateLastUpdatedTimestamp(docFile: string): string | null {
  const docPath = join(DOCS_DIR, docFile);
  if (!existsSync(docPath)) return null;

  const content = readFileSync(docPath, 'utf-8');
  const today = new Date().toISOString().split('T')[0];
  const timestampRegex = /(\*\*Last Updated:\*\* )\d{4}-\d{2}-\d{2}/;

  const match = content.match(timestampRegex);
  if (match && !content.includes(`**Last Updated:** ${today}`)) {
    const updated = content.replace(timestampRegex, `$1${today}`);
    writeFileSync(docPath, updated);
    return `Updated "Last Updated" in ${docFile}: ${match[0]} -> **Last Updated:** ${today}`;
  }

  return null;
}

/**
 * Update Pattern 5: Hook count in DOCUMENTATION/Hooks/HookSystem.md.
 */
function updateHookCount(actualCount: number): string | null {
  const docPath = join(DOCS_DIR, 'THEHOOKSYSTEM.md');
  if (!existsSync(docPath)) return null;

  const content = readFileSync(docPath, 'utf-8');
  const countRegex = /(\*\*Status:\*\* Production - )\d+( hooks? active)/;

  const match = content.match(countRegex);
  if (match) {
    const oldCount = parseInt(content.match(/\*\*Status:\*\* Production - (\d+)/)?.[1] || '0', 10);
    if (oldCount !== actualCount) {
      const updated = content.replace(countRegex, `$1${actualCount}$2`);
      writeFileSync(docPath, updated);
      return `Updated hook count in THEHOOKSYSTEM.md: ${oldCount} -> ${actualCount}`;
    }
  }

  return null;
}

// ============================================================================
// Detached semantic worker: queue + spawn
// ============================================================================

// Proposals wait for a session-start review now, not the same turn's Stop, so they must
// survive across sessions. The age rule (isFresh, 7 days) lives in lib/doc-review-digest.ts;
// expiry is logged here for stats.
const LOCK_STALE_MS = 10 * 60 * 1000;          // a worker older than this is hung or its pid was reused

/**
 * Claim and clear the edits the last worker queued. Rename-to-claim first, so a
 * worker writing a new queue concurrently can't be half-read or have its output
 * deleted. Edits are re-validated at apply time by applyInferenceEdits.
 */
export function takeQueuedEdits(): InferenceEdit[] {
  if (!existsSync(SEMANTIC_QUEUE)) return [];
  const claim = `${SEMANTIC_QUEUE}.claimed-${process.pid}`;
  try {
    renameSync(SEMANTIC_QUEUE, claim);
  } catch {
    return []; // another Stop claimed it first
  }
  try {
    const raw = readFileSync(claim, 'utf-8');
    const edits = JSON.parse(raw);
    if (!Array.isArray(edits)) {
      console.error(`${TAG} [INFERENCE] Queue was not an array, dropping ${raw.length} bytes`);
      try { appendFileSync(SEMANTIC_LOG, `${new Date().toISOString()} [review] dropped 0 (queue not an array, ${raw.length} bytes)\n`); } catch {}
      return [];
    }
    const fresh = edits.filter((e: InferenceEdit) => isFresh(e));
    if (fresh.length < edits.length) {
      const n = edits.length - fresh.length;
      console.error(`${TAG} [INFERENCE] Dropped ${n} queued edit(s) older than 7 days`);
      try { appendFileSync(SEMANTIC_LOG, `${new Date().toISOString()} [review] expired ${n}\n`); } catch {}
    }
    if (fresh.length) console.error(`${TAG} [INFERENCE] Claimed ${fresh.length} queued edit(s) for review`);
    return fresh as InferenceEdit[];
  } catch (error) {
    console.error(`${TAG} [INFERENCE] Unreadable queue, dropping it: ${error}`);
    try { appendFileSync(SEMANTIC_LOG, `${new Date().toISOString()} [review] dropped 0 (unreadable queue: ${error})\n`); } catch {}
    return [];
  } finally {
    try { unlinkSync(claim); } catch {}
  }
}

/** Stable short id for a queued edit, so review ids survive the worker appending mid-review. */
export function editId(edit: InferenceEdit): string {
  return createHash('sha256').update(`${edit.doc}\0${edit.old_text}\0${edit.new_text}`).digest('hex').slice(0, 8);
}

/** Merge edits into the queue (dedup by id) and publish atomically (temp + rename). */
export function enqueueEdits(edits: InferenceEdit[]): void {
  let prior: InferenceEdit[] = [];
  if (existsSync(SEMANTIC_QUEUE)) {
    try {
      const parsed = JSON.parse(readFileSync(SEMANTIC_QUEUE, 'utf-8'));
      if (Array.isArray(parsed)) prior = parsed;
      else console.error(`${TAG} [INFERENCE] prior queue was not an array, replacing it`);
    } catch (e) {
      console.error(`${TAG} [INFERENCE] prior queue unreadable, replacing it: ${e}`);
    }
  }
  const seen = new Set(prior.map(editId));
  const merged = [...prior, ...edits.filter(e => !seen.has(editId(e)))];
  const tmp = `${SEMANTIC_QUEUE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2));
  renameSync(tmp, SEMANTIC_QUEUE);
}

function countQueuedEdits(): number {
  try { const q = JSON.parse(readFileSync(SEMANTIC_QUEUE, 'utf-8')); return Array.isArray(q) ? q.length : 0; } catch { return 0; }
}

interface LockInfo { pid: number | null; startedAt: string }

/** Live = a lock that is younger than LOCK_STALE_MS and whose pid (once known) still exists. */
function workerAlive(): boolean {
  if (!existsSync(SEMANTIC_LOCK)) return false;
  try {
    const lock = JSON.parse(readFileSync(SEMANTIC_LOCK, 'utf-8')) as LockInfo;
    const age = Date.now() - Date.parse(lock.startedAt);
    if (!(age < LOCK_STALE_MS)) {
      console.error(`${TAG} [INFERENCE] Worker lock is stale (${Math.round(age / 1000)}s old, pid ${lock.pid}), clearing it`);
      unlinkSync(SEMANTIC_LOCK);
      return false;
    }
    if (lock.pid) process.kill(lock.pid, 0); // throws if the process is gone
    return true;
  } catch {
    try { unlinkSync(SEMANTIC_LOCK); } catch {}
    return false; // unreadable lock, or the worker died without cleaning up
  }
}

/** Fingerprint = sorted modified paths + mtimes, so a turn that changed nothing new doesn't respawn. */
function fingerprint(modifiedFiles: Set<string>): string {
  const h = createHash('sha256');
  for (const p of Array.from(modifiedFiles).sort()) {
    let mtime = 0;
    try { mtime = statSync(p).mtimeMs; } catch {}
    h.update(`${p}\0${mtime}\n`);
  }
  return h.digest('hex');
}

/** Written by the worker when it finishes. Only an `ok` run for the same fingerprint suppresses a respawn. */
export interface WorkerState { fingerprint: string; status: 'ok' | 'failed'; error?: string; finishedAt: string; reported?: boolean; failCount?: number }

/** After this many consecutive failures, wait FAIL_BACKOFF_MS between attempts: each retry is a ~73K-char cloud call. */
const FAIL_BACKOFF_AFTER = 3;
const FAIL_BACKOFF_MS = 60 * 60 * 1000;

function readWorkerState(): WorkerState | null {
  try { return existsSync(SEMANTIC_STATE) ? JSON.parse(readFileSync(SEMANTIC_STATE, 'utf-8')) : null; } catch { return null; }
}

function maybeSpawnSemanticWorker(modifiedFiles: Set<string>, docsToCheck: string[]): void {
  const fp = fingerprint(modifiedFiles);
  const state = readWorkerState();

  // Surface a failed run once, so it isn't only visible in doc-semantic.log.
  if (state?.status === 'failed' && !state.reported) {
    console.error(`${TAG} [INFERENCE] Last semantic worker run FAILED (${state.finishedAt}): ${state.error}. Retrying.`);
    try { writeFileSync(SEMANTIC_STATE, JSON.stringify({ ...state, reported: true })); } catch {}
  }
  if (state?.status === 'failed' && (state.failCount ?? 0) >= FAIL_BACKOFF_AFTER &&
      Date.now() - Date.parse(state.finishedAt) < FAIL_BACKOFF_MS) {
    console.error(`${TAG} [INFERENCE] ${state.failCount} consecutive worker failures, backing off until an hour after the last`);
    return;
  }
  if (state?.status === 'ok' && state.fingerprint === fp) {
    console.error(`${TAG} [INFERENCE] Modified-file set already checked, not respawning`);
    return;
  }
  if (workerAlive()) {
    console.error(`${TAG} [INFERENCE] Semantic worker still running, not spawning another`);
    return;
  }

  // Claim the lock atomically BEFORE spawning ('wx' fails if it exists), so a
  // concurrent Stop can't slip a second worker into the child's startup window.
  try {
    writeFileSync(SEMANTIC_LOCK, JSON.stringify({ pid: null, startedAt: new Date().toISOString() } satisfies LockInfo), { flag: 'wx' });
  } catch {
    console.error(`${TAG} [INFERENCE] Another Stop just claimed the worker lock, not spawning`);
    return;
  }

  try {
    const payloadPath = join(STATE_DIR, `doc-semantic-payload-${Date.now()}-${process.pid}.json`);
    writeFileSync(payloadPath, JSON.stringify({ fingerprint: fp, modifiedFiles: Array.from(modifiedFiles), docsToCheck }));
    // stderr → the log file, so "0 edits" can be told apart from a failed inference call.
    const logFd = openSync(SEMANTIC_LOG, 'a');
    const child = spawn(process.execPath, [WORKER_PATH, payloadPath], { detached: true, stdio: ['ignore', 'ignore', logFd] });
    closeSync(logFd);
    // ENOENT/EACCES arrive as an async 'error' event, not a throw. Without a listener they crash the hook.
    child.on('error', (e) => {
      try { appendFileSync(SEMANTIC_LOG, `${new Date().toISOString()} spawn failed: ${e}\n`); } catch {}
      try { unlinkSync(SEMANTIC_LOCK); } catch {}
    });
    child.unref();
    if (child.pid) {
      writeFileSync(SEMANTIC_LOCK, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() } satisfies LockInfo));
    }
    console.error(`${TAG} [INFERENCE] Semantic worker spawned detached (pid ${child.pid}); proposals queue for review`);
  } catch (error) {
    console.error(`${TAG} [INFERENCE] Could not spawn semantic worker: ${error}`);
    try { unlinkSync(SEMANTIC_LOCK); } catch {}
  }
}

// ============================================================================
// Main Handler
// ============================================================================

export async function handleDocCrossRefIntegrity(
  parsed: ParsedTranscript,
  hookInput: HookInput
): Promise<void> {
  const handlerStart = Date.now();
  console.error(`${TAG} === Starting hybrid doc integrity check (deterministic + inference) ===`);

  // Step 1: Parse transcript for modified files
  const modifiedFiles = getModifiedFiles(hookInput.transcript_path);
  console.error(`${TAG} Modified files in session: ${modifiedFiles.size}`);

  // Run if ANY meaningful PAI system file was modified (skills, hooks, tools, config, components, workflows, SYSTEM docs)
  const hasDocChanges = isSystemDocModified(modifiedFiles);
  const hasHookChanges = isHookModified(modifiedFiles);
  const hasAnySystemChange = isSystemFileModified(modifiedFiles);

  if (!hasAnySystemChange) {
    console.error(`${TAG} No meaningful system files modified, skipping`);
    return;
  }

  console.error(`${TAG} System docs modified: ${hasDocChanges}`);
  console.error(`${TAG} Hook files modified: ${hasHookChanges}`);
  console.error(`${TAG} System file change detected: ${hasAnySystemChange}`);

  // Step 2: Build filesystem inventory
  const hooksOnDisk = new Set(getHookFilesOnDisk());
  const handlersOnDisk = new Set(getHandlerFilesOnDisk());
  const libsOnDisk = new Set(getLibFilesOnDisk());
  const systemDocsOnDisk = new Set(getSystemDocsOnDisk());

  console.error(`${TAG} Inventory: ${hooksOnDisk.size} hooks, ${handlersOnDisk.size} handlers, ${libsOnDisk.size} libs, ${systemDocsOnDisk.size} system docs`);

  // Step 3: Determine which docs to check
  // Check all SYSTEM docs that reference hooks/handlers/libs
  const docsToCheck = Array.from(systemDocsOnDisk);
  console.error(`${TAG} Checking ${docsToCheck.length} SYSTEM docs for cross-reference drift`);

  // Step 4: Run all pattern checks
  const allDrift: DriftItem[] = [];

  // Pattern 2: Hook file references
  const hookDrift = checkHookFileRefs(docsToCheck, hooksOnDisk);
  if (hookDrift.length > 0) {
    console.error(`${TAG} [DRIFT] Hook file references: ${hookDrift.length} broken refs found`);
    for (const item of hookDrift) {
      console.error(`${TAG}   - ${item.doc}: ${item.issue}`);
    }
    allDrift.push(...hookDrift);
  } else {
    console.error(`${TAG} [OK] Hook file references: all valid`);
  }

  // Pattern 3: Handler file references
  const handlerDrift = checkHandlerFileRefs(docsToCheck, handlersOnDisk);
  if (handlerDrift.length > 0) {
    console.error(`${TAG} [DRIFT] Handler file references: ${handlerDrift.length} broken refs found`);
    for (const item of handlerDrift) {
      console.error(`${TAG}   - ${item.doc}: ${item.issue}`);
    }
    allDrift.push(...handlerDrift);
  } else {
    console.error(`${TAG} [OK] Handler file references: all valid`);
  }

  // Pattern 4: Lib file references
  const libDrift = checkLibFileRefs(docsToCheck, libsOnDisk);
  if (libDrift.length > 0) {
    console.error(`${TAG} [DRIFT] Lib file references: ${libDrift.length} broken refs found`);
    for (const item of libDrift) {
      console.error(`${TAG}   - ${item.doc}: ${item.issue}`);
    }
    allDrift.push(...libDrift);
  } else {
    console.error(`${TAG} [OK] Lib file references: all valid`);
  }

  // Pattern 1: System doc cross-references
  const sysDocDrift = checkSystemDocRefs(docsToCheck, systemDocsOnDisk);
  if (sysDocDrift.length > 0) {
    console.error(`${TAG} [DRIFT] System doc references: ${sysDocDrift.length} broken refs found`);
    for (const item of sysDocDrift) {
      console.error(`${TAG}   - ${item.doc}: ${item.issue}`);
    }
    allDrift.push(...sysDocDrift);
  } else {
    console.error(`${TAG} [OK] System doc references: all valid`);
  }

  // Pattern 5: Hook counts
  const hookCountDrift = checkHookCounts(docsToCheck, hooksOnDisk.size);
  if (hookCountDrift.length > 0) {
    console.error(`${TAG} [DRIFT] Hook counts: ${hookCountDrift.length} mismatches found`);
    for (const item of hookCountDrift) {
      console.error(`${TAG}   - ${item.doc}: ${item.issue}`);
    }
    allDrift.push(...hookCountDrift);
  } else {
    console.error(`${TAG} [OK] Hook counts: accurate`);
  }

  // Step 5: Apply safe deterministic updates
  const updatesApplied: string[] = [];

  // Update Last Updated timestamps for modified SYSTEM docs
  for (const path of modifiedFiles) {
    if (path.includes('PAI/') && path.endsWith('.md')) {
      const docFile = basename(path);
      const result = updateLastUpdatedTimestamp(docFile);
      if (result) {
        console.error(`${TAG} [UPDATED] ${result}`);
        updatesApplied.push(result);
      }
    }
  }

  // Auto-fix hook count if drifted
  if (hasHookChanges) {
    const countResult = updateHookCount(hooksOnDisk.size);
    if (countResult) {
      console.error(`${TAG} [UPDATED] ${countResult}`);
      updatesApplied.push(countResult);
    }
  }

  // Step 6: Semantic drift, detached. Apply what the last worker queued, then
  // start a new worker if this turn changed the modified-file set. Nothing here
  // waits on inference.
  // PROPOSE-ONLY since 2026-09-26: the first live run auto-applied 3 edits and one
  // was substantively wrong (it called the RulesInspector "not inert" and put
  // PromptInspector in the PreToolUse chain; it read code paths, not deployment
  // facts). Queued edits now wait for review; nothing semantic is auto-applied.
  // takeQueuedEdits + applyInferenceEdits stay for an explicit review/apply step.
  const pending = countQueuedEdits();
  if (pending > 0) {
    console.error(`${TAG} [INFERENCE] ${pending} proposed doc edit(s) awaiting review: ${SEMANTIC_QUEUE}`);
  }
  maybeSpawnSemanticWorker(modifiedFiles, docsToCheck);

  // Step 7: Summary
  const totalElapsed = Date.now() - handlerStart;
  console.error(`${TAG} === Summary (${totalElapsed}ms) ===`);
  console.error(`${TAG} Docs checked: ${docsToCheck.length}`);
  console.error(`${TAG} Drift items found: ${allDrift.length}`);
  console.error(`${TAG} Updates applied: ${updatesApplied.length}`);
  if (allDrift.length > 0) {
    console.error(`${TAG} WARNING: ${allDrift.length} cross-reference drift items need manual attention`);
  } else {
    console.error(`${TAG} All cross-references valid`);
  }
  console.error(`${TAG} Wall time: ${totalElapsed}ms`);
  console.error(`${TAG} === Check complete ===`);

  // Step 10: Voice notification — ONLY when actual documentation edits were applied
  // No voice for "queued for review" or "in sync" — that's noise
  if (updatesApplied.length > 0) {
    // Delay 3s so the main 🗣️ {{DA_NAME}} voice line plays first
    await new Promise(resolve => setTimeout(resolve, 3000));

    const affectedDocs = new Set<string>();
    for (const update of updatesApplied) {
      const docMatch = update.match(/(?:in |] )(\w+\.md)/);
      if (docMatch) affectedDocs.add(docMatch[1].replace('.md', ''));
    }

    const docNames = Array.from(affectedDocs).slice(0, 3).join(', ') || 'system';
    const reason = hasHookChanges ? 'hook system changes' : hasDocChanges ? 'system documentation changes' : 'system file changes';
    await notifyVoice(`Updated ${docNames} documentation after detecting ${reason}.`);
  }
}
