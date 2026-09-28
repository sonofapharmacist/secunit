#!/usr/bin/env bun
/**
 * Checkpoint.ts — inspection and PREVIEW-ONLY rollback CLI for ISC checkpoints
 *
 * Subcommands:
 *   list <slug>                — show committed ISCs and their last SHAs per repo
 *   show <slug> <isc-id>       — show commit(s) for a specific ISC across allowlist repos
 *   rollback <slug> <isc-id>   — PREVIEW: print diff + path-scoped `git restore` per repo
 *   prune [--days N] [--apply] — delete old checkpoint refs of finished ISAs (dry run default)
 *
 * Rollback is preview-only by design (per feedback_no_worktree_isolation_without_consent).
 * {{PRINCIPAL_NAME}} runs the destructive op himself if he wants the rollback.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseCriteriaList } from '../../hooks/lib/isa-utils';

// Allowlist path: top of ~/.claude per spec. Read-only here (never written).
// Parser must match
// the hook's parser exactly: skip blanks and '#' lines, expand tilde / $HOME
// prefixes, treat the rest as absolute repo paths.
const ALLOWLIST_PATH = join(homedir(), '.claude', 'checkpoint-repos.txt');
const WORK_DIR = join(homedir(), '.claude', 'PAI', 'MEMORY', 'WORK');

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
  return readFileSync(ALLOWLIST_PATH, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'))
    .map(expandPath);
}

function gitRun(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Must match refComponent() in hooks/CheckpointPerISC.hook.ts
function refComponent(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+|\.+$/g, '').replace(/\.\.+/g, '.') || '_';
}

function checkpointRef(slug: string, iscId: string): string {
  return `refs/checkpoints/${refComponent(slug)}/${refComponent(iscId)}`;
}

/**
 * Snapshots since 2026-09-27 live at refs/checkpoints/<slug>/<isc-id>.
 * Older checkpoints are ordinary commits on the branch, found by subject.
 */
function findCommit(repo: string, slug: string, iscId: string): { sha: string; date: string; subject: string } | null {
  try {
    const fmt = '--pretty=format:%H\t%ci\t%s';
    let out = '';
    try {
      out = gitRun(repo, ['log', '-n', '1', fmt, checkpointRef(slug, iscId), '--']);
    } catch {
      const grepPattern = `${iscId} (${slug}):`;
      out = gitRun(repo, ['log', '--all', '-F', '--grep', grepPattern, fmt, '-n', '1']);
    }
    const line = out.split('\n')[0]?.trim();
    if (!line) return null;
    const [sha, date, ...rest] = line.split('\t');
    return { sha, date, subject: rest.join('\t') };
  } catch {
    return null;
  }
}

function slugPaths(slug: string): { slugDir: string; isaPath: string; statePath: string } {
  const slugDir = join(WORK_DIR, slug);
  return {
    slugDir,
    isaPath: join(slugDir, 'ISA.md'),
    statePath: join(slugDir, '.checkpoint-state.json'),
  };
}

// ISA-derived ISC descriptions are best-effort: `list` needs them only as a
// human label and the spec explicitly requires `list` to keep working when the
// ISA is gone (the sidecar state remains authoritative for what was committed).
function loadIscDescriptions(isaPath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(isaPath)) return map;
  try {
    const content = readFileSync(isaPath, 'utf-8');
    for (const c of parseCriteriaList(content)) map.set(c.id, c.description);
  } catch {
    // Unreadable / unparseable ISA — descriptions just won't render.
  }
  return map;
}

function loadState(statePath: string): { committed_iscs: string[]; last_commit_sha: Record<string, string> } | null {
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
    return {
      committed_iscs: Array.isArray(parsed.committed_iscs) ? parsed.committed_iscs : [],
      last_commit_sha: parsed.last_commit_sha && typeof parsed.last_commit_sha === 'object' ? parsed.last_commit_sha : {},
    };
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function cmdList(slug: string) {
  const { isaPath, statePath } = slugPaths(slug);
  if (!existsSync(statePath)) {
    console.log(`no checkpoints recorded for ${slug}`);
    return;
  }
  const state = loadState(statePath);
  if (!state) {
    console.error(`error: malformed state at ${statePath}`);
    process.exit(1);
  }
  if (state.committed_iscs.length === 0) {
    console.log(`no checkpoints recorded for ${slug}`);
    return;
  }
  const descriptions = loadIscDescriptions(isaPath);

  console.log(`Checkpoints for ${slug}`);
  console.log('─'.repeat(80));
  for (const id of state.committed_iscs) {
    const desc = descriptions.get(id) || '(description not in ISA.md)';
    console.log(`${id.padEnd(12)}  ${truncate(desc, 60)}`);
  }
  console.log('');
  console.log('Last committed SHA per repo:');
  const repos = Object.keys(state.last_commit_sha);
  if (repos.length === 0) {
    console.log('  (none)');
  } else {
    for (const repo of repos) console.log(`  ${repo}: ${state.last_commit_sha[repo]}`);
  }
}

function cmdShow(slug: string, iscId: string) {
  const allowlist = loadAllowlist();
  if (allowlist.length === 0) {
    console.error(`no allowlist at ${ALLOWLIST_PATH}`);
    process.exit(1);
  }
  // Spec output format: one line per matching repo, "<repo>: <sha> <date> <subject>".
  let any = false;
  for (const repo of allowlist) {
    if (!existsSync(repo)) continue;
    const hit = findCommit(repo, slug, iscId);
    if (!hit) continue;
    any = true;
    console.log(`${repo}: ${hit.sha} ${hit.date} ${hit.subject}`);
  }
  if (!any) console.log(`no commit found for ${iscId} in ${slug}`);
}

function cmdRollback(slug: string, iscId: string) {
  const allowlist = loadAllowlist();
  if (allowlist.length === 0) {
    console.error(`no allowlist at ${ALLOWLIST_PATH}`);
    process.exit(1);
  }
  // PREVIEW ONLY. Every git verb on the next lines is a printed STRING — there
  // is no execFile call to any destructive subcommand anywhere in this function.
  let any = false;
  for (const repo of allowlist) {
    if (!existsSync(repo)) continue;
    const hit = findCommit(repo, slug, iscId);
    if (!hit) continue;
    any = true;
    // Restore specific paths, not the whole repo: a shared repo like ~/.claude
    // also holds other sessions' work, memory, and service state that a
    // repo-wide reset would silently rewind.
    console.log(`REPO: ${repo}`);
    console.log(`TARGET: ${hit.sha} (${hit.subject})`);
    console.log('');
    console.log('1. See what differs between the checkpoint and now:');
    console.log(`  git -C ${repo} diff --stat ${hit.sha}`);
    console.log('');
    console.log('2. Restore just the paths you want back:');
    console.log(`  git -C ${repo} restore --source=${hit.sha} -- <path> [<path>...]`);
    console.log('');
    console.log(`Files created after the checkpoint are not removed by restore; delete them by hand if needed.`);
    console.log('');
  }
  if (!any) {
    console.log(`no commit found for ${iscId} in ${slug}`);
    return;
  }
  console.log('(no destructive operation performed — review and run the commands above manually)');
}

const TERMINAL_PHASES = new Set(['complete', 'abandoned', 'superseded']);

function isaPhase(slug: string): string | null {
  const { isaPath } = slugPaths(slug);
  if (!existsSync(isaPath)) return null;
  const m = readFileSync(isaPath, 'utf-8').match(/^phase:\s*"?([\w-]+)"?\s*$/m);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Delete checkpoint refs for ISAs in a terminal phase whose snapshot is older
 * than `days`. Dry run unless --apply. Only refs/checkpoints/* is touched —
 * branch history and the working tree are never modified.
 */
function cmdPrune(days: number, apply: boolean) {
  const cutoff = Date.now() / 1000 - days * 86400;
  let count = 0;
  for (const repo of loadAllowlist()) {
    if (!existsSync(repo)) continue;
    let out = '';
    try {
      out = gitRun(repo, ['for-each-ref', '--format=%(refname)\t%(committerdate:unix)', 'refs/checkpoints/']);
    } catch { continue; }
    for (const line of out.split('\n').filter(Boolean)) {
      const [ref, ts] = line.split('\t');
      const slug = ref.split('/')[2];
      const phase = isaPhase(slug);
      // Missing ISA counts as finished; unknown/active phases are kept
      const finished = phase === null || TERMINAL_PHASES.has(phase);
      if (!finished || Number(ts) > cutoff) continue;
      count++;
      if (apply) gitRun(repo, ['update-ref', '-d', ref]);
      console.log(`${apply ? 'deleted' : 'would delete'}  ${repo}  ${ref}  (${phase ?? 'no ISA'})`);
    }
  }
  console.log(count === 0 ? 'nothing to prune' : apply ? `pruned ${count} refs` : `${count} refs — re-run with --apply to delete`);
}

function usage() {
  console.log(`Usage:
  bun ~/.claude/PAI/TOOLS/Checkpoint.ts list <slug>
  bun ~/.claude/PAI/TOOLS/Checkpoint.ts show <slug> <isc-id>
  bun ~/.claude/PAI/TOOLS/Checkpoint.ts rollback <slug> <isc-id>
  bun ~/.claude/PAI/TOOLS/Checkpoint.ts prune [--days N] [--apply]

Allowlist: ${ALLOWLIST_PATH}
Work dir:  ${WORK_DIR}
Snapshots: refs/checkpoints/<slug>/<isc-id> in each allowlisted repo

Rollback is PREVIEW ONLY — prints diff + path-scoped restore commands and
exits. No destructive git operation is ever executed by this CLI.
Prune (default 30 days, dry run) deletes only checkpoint refs of finished ISAs.`);
}

const [, , sub, slug, iscId] = process.argv;
if (!sub) {
  usage();
  process.exit(0);
}
switch (sub) {
  case 'list':
    if (!slug) { usage(); process.exit(1); }
    cmdList(slug);
    break;
  case 'show':
    if (!slug || !iscId) { usage(); process.exit(1); }
    cmdShow(slug, iscId);
    break;
  case 'rollback':
    if (!slug || !iscId) { usage(); process.exit(1); }
    cmdRollback(slug, iscId);
    break;
  case 'prune': {
    const args = process.argv.slice(3);
    const di = args.indexOf('--days');
    const days = di >= 0 ? Number(args[di + 1]) : 30;
    if (!Number.isFinite(days) || days < 0) { usage(); process.exit(1); }
    cmdPrune(days, args.includes('--apply'));
    break;
  }
  default:
    usage();
    process.exit(1);
}
