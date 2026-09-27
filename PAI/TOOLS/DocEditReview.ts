#!/usr/bin/env bun
/**
 * DocEditReview.ts — review the semantic-drift worker's proposed doc edits.
 *
 * The DocIntegrity Stop hook's detached worker (hooks/handlers/DocSemanticWorker.ts)
 * only PROPOSES edits to PAI/DOCUMENTATION/*.md; nothing semantic is auto-applied.
 * Pending proposals surface at session start (hooks/lib/doc-review-digest.ts via LoadContext);
 * until 2026-09-27 the Stop hook blocked once per batch instead.
 * Verify each edit against the source AND deployment facts before applying: the
 * model reads code paths and has been wrong about what is actually live.
 *
 * Usage:
 *   bun DocEditReview.ts list                         # id, doc, reason, full old → new
 *   bun DocEditReview.ts apply <id...>                # apply these, drop them from the queue
 *   bun DocEditReview.ts reject <id...> --reason "…"  # drop these, logged with the reason
 *   bun DocEditReview.ts reject all --reason "…"
 *   bun DocEditReview.ts stats [--since YYYY-MM-DD]   # acceptance rate; default window = since last [config] marker
 *
 * Log: PAI/MEMORY/STATE/doc-semantic.log   Exit: 0 ok · 1 usage / unknown id
 */

import { appendFileSync, readFileSync } from 'fs';
import {
  takeQueuedEdits, enqueueEdits, applyInferenceEdits, editId, SEMANTIC_LOG, SEMANTIC_QUEUE, type InferenceEdit,
} from '../../hooks/handlers/DocCrossRefIntegrity';
import { isFresh } from '../../hooks/lib/doc-review-digest';

const [cmd, ...rest] = process.argv.slice(2);
const reasonIdx = rest.indexOf('--reason');
const reason = reasonIdx >= 0 ? rest[reasonIdx + 1] : undefined;
const ids = (reasonIdx >= 0 ? rest.slice(0, reasonIdx) : rest).filter(Boolean);

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error('usage: DocEditReview.ts list | apply <id...> | reject <id...|all> --reason "..." | stats [--since YYYY-MM-DD]');
  process.exit(1);
}

function log(msg: string): void {
  try { appendFileSync(SEMANTIC_LOG, `${new Date().toISOString()} [review] ${msg}\n`); } catch {}
}

function peek(): InferenceEdit[] {
  try { const q = JSON.parse(readFileSync(SEMANTIC_QUEUE, 'utf-8')); return Array.isArray(q) ? q.filter(isFresh) : []; } catch { return []; }
}

if (!cmd || cmd === '--help' || cmd === '-h') usage();

if (cmd === 'list') {
  const q = peek();
  if (q.length === 0) { console.log('No proposed doc edits.'); process.exit(0); }
  for (const e of q) {
    console.log(`## ${editId(e)}  ${e.doc}${e.queuedAt ? `  (queued ${e.queuedAt})` : ''}`);
    console.log(`reason: ${e.reason}`);
    console.log(`- old: ${e.old_text}`);
    console.log(`+ new: ${e.new_text}\n`);
  }
  process.exit(0);
}

if (cmd === 'stats') {
  // Acceptance rate since --since (default: the last `[config]` marker, i.e. the current trial).
  let lines: string[] = [];
  try { lines = readFileSync(SEMANTIC_LOG, 'utf-8').split('\n'); } catch {}
  const markerIdx = lines.map((l, i) => (/^\S+Z \[config\] /.test(l) ? i : -1)).filter(i => i >= 0).pop() ?? -1;
  // A marker may carry `since=<ISO>` when the trial began before the marker was written.
  const trialStart = markerIdx >= 0 ? (lines[markerIdx].match(/ since=(\S+)/)?.[1] ?? lines[markerIdx].slice(0, 24)) : undefined;
  const sinceIdx = rest.indexOf('--since');
  const since = sinceIdx >= 0 ? rest[sinceIdx + 1] : undefined;
  if (sinceIdx >= 0 && !/^\d{4}-\d{2}-\d{2}$/.test(since ?? '')) usage('--since needs YYYY-MM-DD');
  const window = (since ? lines.filter(l => l.slice(0, 10) >= since) : trialStart ? lines.filter(l => l.slice(0, 24) >= trialStart && !/^\S+Z \[config\] /.test(l)) : lines).filter(l => /^\d{4}-\d{2}-\d{2}T/.test(l));
  let queued = 0, applied = 0, rejected = 0, expired = 0, runs = 0, failed = 0;
  for (const l of window) {
    const q = l.match(/\] (done|FAILED) in \d+ms: (\d+) edit\(s\) queued/); if (q) { runs++; queued += +q[2]; if (q[1] === 'FAILED') failed++; }
    if (/\] (FAILED after \d+ms|fatal:|no payload at)| spawn failed:/.test(l)) { runs++; failed++; }
    const dq = l.match(/\[review\] dropped (\d+)/); if (dq) expired += +dq[1];
    // Trial window: count a reviewed edit only if it was QUEUED after the marker, so proposals
    // from an earlier config (or reviewed late) never score the current trial.
    const inTrial = (qa: string | undefined, n: number) =>
      since || !trialStart ? n : (qa ?? '').split(',').filter(t => t !== '?' && t >= trialStart).length;
    const a = l.match(/\[review\] applied \S+ \((\d+) written\)(?: queuedAt=(\S+))?/);
    if (a) applied += inTrial(a[2], +a[1]);
    const r = l.match(/\[review\] rejected (\S+)(?: queuedAt=(\S+))? ::/);
    if (r) rejected += inTrial(r[2], r[1].split(',').length);
    const x = l.match(/\[review\] expired (\d+)/); if (x) expired += +x[1];
  }
  const reviewed = applied + rejected;
  const marker = markerIdx >= 0 && !since ? lines[markerIdx] : `since ${since ?? 'start of log'}`;
  console.log(`window: ${marker}`);
  console.log(`worker runs ${runs} (failed ${failed}) · proposals queued ${queued} · applied ${applied} · rejected ${rejected} · expired ${expired}`);
  console.log(`acceptance: ${reviewed ? `${Math.round((applied / reviewed) * 100)}% (${applied}/${reviewed})` : 'n/a (nothing reviewed yet)'}`);
  process.exit(0);
}

if (cmd !== 'apply' && cmd !== 'reject') usage(`unknown command: ${cmd}`);
if (ids.length === 0) usage('no ids given');
if (cmd === 'reject' && !reason) usage('reject needs --reason "..." (it is the audit trail)');

// Claim the whole queue, act on the selected ids, put the rest back (merging with
// anything the worker queued meanwhile).
const all = takeQueuedEdits();
const wanted = ids[0] === 'all' && cmd === 'reject' ? new Set(all.map(editId)) : new Set(ids);
const unknown = [...wanted].filter(id => !all.some(e => editId(e) === id));
const selected = all.filter(e => wanted.has(editId(e)));
const remaining = all.filter(e => !wanted.has(editId(e)));
if (remaining.length) enqueueEdits(remaining);

if (cmd === 'apply') {
  const applied = applyInferenceEdits(selected);
  console.log(`applied ${applied.length}/${selected.length}`);
  for (const a of applied) console.log(`  ${a}`);
  log(`applied ${selected.map(editId).join(',')} (${applied.length} written) queuedAt=${selected.map(e => e.queuedAt ?? '?').join(',')}`);
} else {
  console.log(`rejected ${selected.length}: ${reason}`);
  log(`rejected ${selected.map(e => `${editId(e)}:${e.doc}`).join(',')} queuedAt=${selected.map(e => e.queuedAt ?? '?').join(',')} :: ${reason}`);
}
console.log(`${remaining.length} still queued`);
if (unknown.length) { console.error(`unknown id(s): ${unknown.join(', ')}`); process.exit(1); }
