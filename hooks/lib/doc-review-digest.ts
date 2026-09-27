/**
 * doc-review-digest.ts — the session-start line for pending semantic doc edits.
 *
 * Lives apart from handlers/DocCrossRefIntegrity.ts so LoadContext doesn't load Inference.ts at
 * session start. The Stop hook blocked once per batch until 2026-09-27; with 0 of ~9 proposals
 * accepted, that forced a review round per batch for nothing. Proposals now wait in the queue
 * (7 days) and this line surfaces them. Review stays the DA's job (GP, 2026-09-26).
 * Acceptance rate: `bun PAI/TOOLS/DocEditReview.ts stats`.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { getPaiDir } from './paths';

/**
 * The trial marker (`[config] ... Check-in YYYY-MM-DD`, the last one in doc-semantic.log) names a
 * decision date. From that date on, every session start says so, until a newer marker replaces it.
 */
function trialCheckInDue(): string | null {
  let log: string;
  try { log = readFileSync(join(getPaiDir(), 'MEMORY', 'STATE', 'doc-semantic.log'), 'utf-8'); } catch { return null; }
  const marker = log.split('\n').filter(l => /^\S+Z \[config\] /.test(l)).pop();
  const due = marker?.match(/Check-in (\d{4}-\d{2}-\d{2})/)?.[1];
  if (!due || new Date().toISOString().slice(0, 10) < due) return null;
  return `⏰ DOC DRIFT TRIAL CHECK-IN (due ${due}): run \`bun ~/.claude/PAI/TOOLS/DocEditReview.ts stats\` and bring GP the ` +
    'keep/kill call (keep if acceptance ≥ 20%, else delete the semantic layer). Close it by appending a new [config] marker ' +
    'to doc-semantic.log recording the decision.';
}

/** Proposals older than this are dropped: past a week the doc has likely moved on. One rule for the digest, `list` and claim. */
export const QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export function isFresh(e: { queuedAt?: string } | null | undefined): boolean {
  return !e?.queuedAt || Date.now() - Date.parse(e.queuedAt) < QUEUE_MAX_AGE_MS;
}

/** A failing worker looks exactly like "no drift found" unless something says so. Shown until an ok run replaces it. */
function workerFailing(): string | null {
  let st: { status?: string; error?: string; finishedAt?: string; failCount?: number };
  try { st = JSON.parse(readFileSync(join(getPaiDir(), 'MEMORY', 'STATE', 'doc-semantic-state.json'), 'utf-8')); } catch { return null; }
  if (st?.status !== 'failed') return null;
  return `⚠️ DOC DRIFT worker failing (${st.failCount ?? 1}× in a row, last ${st.finishedAt?.slice(0, 16) ?? '?'}): ${String(st.error ?? 'unknown').slice(0, 160)}. ` +
    'See PAI/MEMORY/STATE/doc-semantic.log.';
}

export function pendingReviewDigest(): string | null {
  const parts = [trialCheckInDue(), workerFailing(), queueDigest()].filter((p): p is string => !!p);
  return parts.length ? parts.join('\n') : null;
}

function queueDigest(): string | null {
  let queue: { doc?: string; queuedAt?: string }[];
  try {
    queue = JSON.parse(readFileSync(join(getPaiDir(), 'MEMORY', 'STATE', 'doc-semantic-queue.json'), 'utf-8'));
  } catch {
    return null;
  }
  if (!Array.isArray(queue)) return null;
  queue = queue.filter(isFresh); // expired entries are dropped (and logged) at the next claim
  if (queue.length === 0) return null;
  const docs = [...new Set(queue.map(e => e.doc).filter(Boolean))].join(', ');
  const oldest = queue.map(e => e.queuedAt ?? '').filter(Boolean).sort()[0]?.slice(0, 10) ?? '?';
  return `📝 DOC DRIFT: ${queue.length} proposed edit(s) to ${docs} (oldest ${oldest}). At a natural pause, review with ` +
    '`bun ~/.claude/PAI/TOOLS/DocEditReview.ts list`: verify each claim against the source AND deployment facts ' +
    '(does the file or config exist, is it wired?), then apply or reject with --reason, and tell GP the outcome in one line.';
}
