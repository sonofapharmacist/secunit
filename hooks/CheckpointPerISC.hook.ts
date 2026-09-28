#!/usr/bin/env bun
/**
 * CheckpointPerISC.hook.ts — whole-tree git snapshot on every ISC `[ ]`->`[x]` transition
 *
 * TRIGGER: PostToolUse (Write, Edit) on ISA.md (or legacy PRD.md) under
 * MEMORY/WORK/<slug>/.
 *
 * For each newly-checked ISC, iterates through the allowlist of opted-in repos
 * (~/.claude/checkpoint-repos.txt per spec) and records one snapshot commit
 * per repo at refs/checkpoints/<slug>/<isc-id>. Snapshots never touch the
 * branch, HEAD, or the real index. Commit subject:
 *   "<ISC-id> (<slug>): <sanitized description>"
 *
 * Idempotent via sidecar state file: MEMORY/WORK/<slug>/.checkpoint-state.json.
 * Allowlist is empty by default; repos must be opted in explicitly by {{PRINCIPAL_NAME}}.
 *
 * Fails closed: any error path logs to stderr and emits `{continue:true}` with
 * exit 0 — never crashes the session, never commits without an allowlist,
 * never executes any destructive git op (no reset/revert/checkout/branch -D/
 * clean -fd/push --force).
 */

import { readFileSync, existsSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { parseFrontmatter, parseCriteriaList, ARTIFACT_FILENAME, LEGACY_ARTIFACT_FILENAME } from './lib/isa-utils';

// Allowlist path: top of ~/.claude per spec. This file is read-only here
// (never written). One absolute repo path per line; '#' comments and blank
// lines are ignored. Tilde and $HOME prefixes are expanded as a quality-of-
// life feature so users can write `~/Projects/foo` instead of the long form.
const ALLOWLIST_PATH = join(homedir(), '.claude', 'checkpoint-repos.txt');
const GIT_TIMEOUT_MS = 5000;

interface CheckpointState {
  committed_iscs: string[];
  last_commit_sha: Record<string, string>;
}

function expandPath(p: string): string {
  let s = p.trim();
  if (!s) return s;
  if (s.startsWith('~/')) s = join(homedir(), s.slice(2));
  else if (s === '~') s = homedir();
  s = s.replace(/^\$HOME(\/|$)/, homedir() + '$1');
  return s;
}

function loadAllowlist(): string[] {
  if (!existsSync(ALLOWLIST_PATH)) return [];
  try {
    return readFileSync(ALLOWLIST_PATH, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#'))
      .map(expandPath);
  } catch (err) {
    console.error('[CheckpointPerISC] failed to read allowlist:', err);
    return [];
  }
}

function loadState(stateFile: string): CheckpointState {
  if (!existsSync(stateFile)) return { committed_iscs: [], last_commit_sha: {} };
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'));
    return {
      committed_iscs: Array.isArray(parsed.committed_iscs) ? parsed.committed_iscs : [],
      last_commit_sha: parsed.last_commit_sha && typeof parsed.last_commit_sha === 'object' ? parsed.last_commit_sha : {},
    };
  } catch (err) {
    console.error('[CheckpointPerISC] malformed state file, resetting:', err);
    return { committed_iscs: [], last_commit_sha: {} };
  }
}

function saveState(stateFile: string, state: CheckpointState): void {
  try {
    writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.error('[CheckpointPerISC] failed to write state:', err);
  }
}

function gitRun(repo: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env ?? process.env,
  });
}

function isGitRepo(repo: string): boolean {
  try {
    gitRun(repo, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

function sanitizeMessage(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/[`$]/g, '').trim().slice(0, 200);
}

function refComponent(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+|\.+$/g, '').replace(/\.\.+/g, '.') || '_';
}

/**
 * Snapshot the whole working tree (tracked + untracked, .gitignore honored)
 * as a commit that lives only under refs/checkpoints/<slug>/<isc-id>.
 *
 * Uses a throwaway index seeded from the real one, so the repo's own index,
 * HEAD, and branch are never touched: no staged work gets swept in, no commit
 * lands on the branch, and concurrent sessions' edits never appear in branch
 * history under this ISC's name. Until 2026-09-27 this was `git add -A` +
 * `git commit` on the current branch, which did all three.
 */
function snapshotInRepo(repo: string, iscId: string, slug: string, description: string): string | null {
  const tmpIndex = join(tmpdir(), `pai-checkpoint-${process.pid}-${Date.now()}.index`);
  try {
    const gitIndexRel = gitRun(repo, ['rev-parse', '--git-path', 'index']).trim();
    const realIndex = isAbsolute(gitIndexRel) ? gitIndexRel : join(repo, gitIndexRel);
    // Seeding from the real index keeps stat info, so `add -A` only rehashes changed files
    if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };

    gitRun(repo, ['add', '-A'], env);
    const tree = gitRun(repo, ['write-tree'], env).trim();
    let parent: string | null = null;
    try { parent = gitRun(repo, ['rev-parse', '--verify', 'HEAD']).trim(); } catch { /* unborn branch */ }

    // iscId already has the canonical "ISC-<N>" form (or "ISC-<N>-A-<M>" for
    // anti-criteria) per parseCriteriaList — use it verbatim, do not re-prefix.
    // Checkpoint.ts finds snapshots by this subject via `git log --all --grep`.
    const subject = `${iscId} (${slug}): ${sanitizeMessage(description)}`;
    // commit-tree runs no hooks; --no-gpg-sign avoids passphrase prompts that would hang.
    const commitArgs = ['commit-tree', tree, '-m', subject, '--no-gpg-sign'];
    if (parent) commitArgs.push('-p', parent);
    const sha = gitRun(repo, commitArgs).trim();

    const ref = `refs/checkpoints/${refComponent(slug)}/${refComponent(iscId)}`;
    gitRun(repo, ['update-ref', '-m', `checkpoint ${iscId} (${slug})`, ref, sha]);
    return sha;
  } catch (err: unknown) {
    const e = err as { stderr?: { toString?: () => string }; message?: string };
    const detail = e?.stderr?.toString?.() || e?.message || String(err);
    console.error(`[CheckpointPerISC] snapshot failed in ${repo} for ${iscId}: ${detail}`);
    return null;
  } finally {
    try { if (existsSync(tmpIndex)) unlinkSync(tmpIndex); } catch { /* best-effort */ }
  }
}

let input: any;
try {
  input = JSON.parse(readFileSync(0, 'utf-8'));
} catch {
  process.exit(0);
}

function emitContinueAndExit(): never {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}

async function main() {
  const filePath: string = input?.tool_input?.file_path || '';
  if (!filePath.includes('MEMORY/WORK/')) return;
  const isISA = filePath.endsWith('/' + ARTIFACT_FILENAME) || filePath.endsWith(ARTIFACT_FILENAME);
  const isLegacyPRD = filePath.endsWith('/' + LEGACY_ARTIFACT_FILENAME) || filePath.endsWith(LEGACY_ARTIFACT_FILENAME);
  if (!isISA && !isLegacyPRD) return;
  if (!existsSync(filePath)) return;

  const slugDir = dirname(filePath);
  const slug = basename(slugDir);
  const stateFile = join(slugDir, '.checkpoint-state.json');

  const content = readFileSync(filePath, 'utf-8');
  const fm = parseFrontmatter(content);
  if (!fm) return;
  const criteria = parseCriteriaList(content);
  if (criteria.length === 0) return;

  const state = loadState(stateFile);
  const alreadyCommitted = new Set(state.committed_iscs);
  const newlyChecked = criteria.filter(c => c.status === 'completed' && !alreadyCommitted.has(c.id));
  if (newlyChecked.length === 0) return;

  const allowlist = loadAllowlist();
  if (allowlist.length === 0) {
    console.error('[CheckpointPerISC] no repos configured, skipping');
    return;
  }

  for (const isc of newlyChecked) {
    for (const repo of allowlist) {
      if (!existsSync(repo)) {
        console.error(`[CheckpointPerISC] repo not found: ${repo}`);
        continue;
      }
      if (!isGitRepo(repo)) {
        console.error(`[CheckpointPerISC] not a git repo: ${repo}`);
        continue;
      }
      // Snapshot even when the tree is clean: the ref still marks "state at this ISC"
      const sha = snapshotInRepo(repo, isc.id, slug, isc.description);
      if (sha) state.last_commit_sha[repo] = sha;
    }
    state.committed_iscs.push(isc.id);
  }

  saveState(stateFile, state);
}

main().catch(err => {
  console.error('[CheckpointPerISC] uncaught error:', err);
}).finally(() => {
  emitContinueAndExit();
});
