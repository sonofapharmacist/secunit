#!/usr/bin/env bun
/**
 * DocSemanticWorker.ts — detached semantic-drift pass for DocCrossRefIntegrity.
 *
 * Spawned (detached; stderr → the log file) by the DocIntegrity Stop hook, so the
 * Stop hook never waits on inference. It runs the inference analysis with a
 * generous budget and QUEUES the validated edits to MEMORY/STATE/doc-semantic-queue.json.
 * It never writes docs. Queued edits are proposals: the Stop hook reports how
 * many await review, and nothing semantic is auto-applied (one of the first 3
 * auto-applied edits was wrong about a security inspector, 2026-09-26).
 *
 * Coordination with the hook (hardened 2026-09-26 after review):
 * - The hook claims the lock before spawning and writes this pid into it. The
 *   worker removes the lock only if it still holds this pid.
 * - The payload file is unique per spawn.
 * - The queue is written temp-then-rename; the hook claims it by rename before reading.
 * - The worker records {fingerprint, status, error} in doc-semantic-state.json.
 *   Only an `ok` run suppresses a respawn for the same fingerprint, so a failed
 *   run is retried and reported at the next Stop.
 *
 * Usage: bun DocSemanticWorker.ts <payload.json>   (payload: {fingerprint, modifiedFiles, docsToCheck})
 * Log:   MEMORY/STATE/doc-semantic.log
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, appendFileSync } from 'fs';
import {
  runInferenceAnalysis, enqueueEdits, SEMANTIC_LOCK, SEMANTIC_LOG, SEMANTIC_STATE, type WorkerState,
} from './DocCrossRefIntegrity';

// Cloud-only since 2026-09-27: a ~73K-char context measured 49-85s on Claude standard.
// Nothing waits on this process.
const TIMEOUT_MS = 120_000;

function log(msg: string): void {
  try { appendFileSync(SEMANTIC_LOG, `${new Date().toISOString()} [pid ${process.pid}] ${msg}\n`); }
  catch (e) { console.error(`[DocSemanticWorker] log write failed: ${e} :: ${msg}`); }
}

function writeState(state: WorkerState): void {
  // failCount = consecutive failures; the spawner backs off on it and the session digest shows it.
  let prev: Partial<WorkerState> = {};
  try { prev = JSON.parse(readFileSync(SEMANTIC_STATE, 'utf-8')); } catch {}
  const failCount = state.status === 'failed' ? (prev.failCount ?? 0) + 1 : 0;
  try { writeFileSync(SEMANTIC_STATE, JSON.stringify({ ...state, failCount })); } catch (e) { log(`state write failed: ${e}`); }
}

function releaseLock(): void {
  try {
    const lock = JSON.parse(readFileSync(SEMANTIC_LOCK, 'utf-8'));
    if (lock.pid === process.pid) unlinkSync(SEMANTIC_LOCK);
  } catch { /* already gone, or replaced by a newer claim: leave it */ }
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath || !existsSync(payloadPath)) { log(`no payload at ${payloadPath}`); releaseLock(); return; }
  const start = Date.now();
  let fingerprint = '';
  try {
    const payload = JSON.parse(readFileSync(payloadPath, 'utf-8'));
    fingerprint = payload.fingerprint;
    const { modifiedFiles, docsToCheck } = payload;
    // Inference.ts and the analysis log to stderr, which the spawner points at the log file.
    const result = await runInferenceAnalysis(new Set<string>(modifiedFiles), docsToCheck, TIMEOUT_MS);
    if (result.edits.length > 0) enqueueEdits(result.edits);
    writeState({ fingerprint, status: result.ok ? 'ok' : 'failed', error: result.error, finishedAt: new Date().toISOString() });
    log(`${result.ok ? 'done' : 'FAILED'} in ${Date.now() - start}ms: ${result.edits.length} edit(s) queued` +
      ` (${modifiedFiles.length} modified files, ${docsToCheck.length} docs)${result.error ? ` :: ${result.error}` : ''}`);
  } catch (error) {
    writeState({ fingerprint, status: 'failed', error: String(error), finishedAt: new Date().toISOString() });
    log(`FAILED after ${Date.now() - start}ms: ${error}`);
  } finally {
    releaseLock();
    try { unlinkSync(payloadPath); } catch {}
  }
}

main().then(() => process.exit(0), (e) => { log(`fatal: ${e}`); releaseLock(); process.exit(0); });
