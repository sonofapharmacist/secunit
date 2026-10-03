#!/usr/bin/env bun
/**
 * DiskPrune.ts — weekly age-based prune of regenerable caches and logs.
 *
 * Every target is a cache or log that rebuilds itself. Data (backups, git
 * history, session transcripts, worktrees) is reported, never deleted.
 * Freed space is measured with statfs, not du: bun hardlinks installs out of
 * its cache, so a deleted cache entry frees nothing while node_modules links it.
 *
 * Usage:
 *   bun DiskPrune.ts                 # prune
 *   bun DiskPrune.ts --dry-run       # list candidates, delete nothing
 *   bun DiskPrune.ts --notify        # Pulse /notify if still >= --alert-pct after prune, or on error
 *   bun DiskPrune.ts --alert-pct 85  # alert threshold (default 85)
 *
 * ISA: MEMORY/WORK/20260928-152000_ubupai-disk-resize-and-prune
 */
import { existsSync, lstatSync, readdirSync, rmSync, statfsSync } from 'fs'
import { homedir } from 'os'
import { join, relative, isAbsolute } from 'path'
import { spawnSync } from 'child_process'

const DAY_MS = 86_400_000
const PULSE_NOTIFY = 'http://localhost:31337/notify'

export interface Target {
  name: string
  root: string
  /** 'entries' = top-level children of root; 'files' = every file under root, recursively */
  scope: 'entries' | 'files'
  maxAgeDays: number
  /** Optional filter on the entry/file basename */
  match?: RegExp
}

export interface Candidate { path: string; bytes: number }

export function targets(home: string): Target[] {
  return [
    // bun re-downloads on the next install; 30d keeps active projects warm.
    { name: 'bun-cache', root: join(home, '.bun/install/cache'), scope: 'entries', maxAgeDays: 30 },
    // npm is banned here (bun only), so anything in its cache is dead weight.
    { name: 'npm-cache', root: join(home, '.npm'), scope: 'entries', maxAgeDays: 0, match: /^(_cacache|_logs|_npx)$/ },
    { name: 'agy-logs', root: join(home, '.gemini/antigravity-cli/log'), scope: 'files', maxAgeDays: 14 },
    { name: 'mcp-logs', root: join(home, '.cache/claude-cli-nodejs'), scope: 'files', maxAgeDays: 14 },
    // A release in flight writes its stage within minutes; 3d never races one.
    { name: 'secunit-stage', root: join(home, '.cache/secunit-stage'), scope: 'entries', maxAgeDays: 3 },
    // Self-updaters (agy) leave the previous binary behind as *.old.
    { name: 'old-binaries', root: join(home, '.local/bin'), scope: 'entries', maxAgeDays: 7, match: /\.old$/ },
  ]
}

function sizeOf(path: string): number {
  const st = lstatSync(path)
  if (!st.isDirectory()) return st.size
  let total = 0
  for (const e of readdirSync(path)) {
    try { total += sizeOf(join(path, e)) } catch { /* vanished mid-walk */ }
  }
  return total
}

/** Is `path` strictly inside `root`? Guards every deletion. */
export function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Entries/files under the target's root older than its cutoff. Never follows symlinks. */
export function selectOld(t: Target, now = Date.now()): Candidate[] {
  if (!existsSync(t.root)) return []
  const cutoff = now - t.maxAgeDays * DAY_MS
  const out: Candidate[] = []
  const consider = (p: string, name: string) => {
    if (t.match && !t.match.test(name)) return false
    const st = lstatSync(p)
    return st.mtimeMs <= cutoff
  }
  if (t.scope === 'entries') {
    for (const name of readdirSync(t.root)) {
      const p = join(t.root, name)
      try { if (consider(p, name)) out.push({ path: p, bytes: sizeOf(p) }) } catch { /* vanished */ }
    }
  } else {
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        try {
          const st = lstatSync(p)
          if (st.isDirectory()) walk(p)
          else if (consider(p, name)) out.push({ path: p, bytes: st.size })
        } catch { /* vanished */ }
      }
    }
    walk(t.root)
  }
  return out.filter((c) => within(t.root, c.path))
}

function disk() {
  const s = statfsSync('/')
  const used = (s.blocks - s.bfree) * s.bsize
  const avail = s.bavail * s.bsize
  // df rounds the percentage up; match it so alerts agree with what GP sees.
  return { used, avail, pct: Math.ceil((used / (used + avail)) * 100) }
}

const gb = (b: number) => `${(b / 1e9).toFixed(2)}G`

function dirBytes(path: string): number {
  try { return existsSync(path) ? sizeOf(path) : 0 } catch { return 0 }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const notify = args.includes('--notify')
  const ai = args.indexOf('--alert-pct')
  const alertPct = ai >= 0 ? Number(args[ai + 1]) : 85
  const home = homedir()
  const errors: string[] = []
  const before = disk()

  console.log(`DiskPrune ${dryRun ? '(dry run) ' : ''}— / at ${before.pct}%, ${gb(before.avail)} free`)
  for (const t of targets(home)) {
    let cands: Candidate[] = []
    try { cands = selectOld(t) } catch (e) { errors.push(`${t.name}: ${e}`); continue }
    const bytes = cands.reduce((s, c) => s + c.bytes, 0)
    if (!dryRun) {
      for (const c of cands) {
        try { rmSync(c.path, { recursive: true, force: true }) } catch (e) { errors.push(`${t.name}: ${c.path}: ${e}`) }
      }
    }
    console.log(`  ${t.name.padEnd(14)} ${String(cands.length).padStart(6)} items  ≤${gb(bytes)}  (>${t.maxAgeDays}d)`)
  }

  // uv owns its cache layout; `uv cache prune` drops only unreferenced entries.
  const uv = join(home, '.local/bin/uv')
  if (existsSync(uv) && dryRun) {
    console.log(`  ${'uv-cache'.padEnd(14)} would run \`uv cache prune\` (no dry-run mode); cache is ${gb(dirBytes(join(home, '.cache/uv')))}`)
  } else if (existsSync(uv)) {
    const r = spawnSync(uv, ['cache', 'prune'], { encoding: 'utf-8', stdio: 'pipe' })
    const line = `${r.stderr}${r.stdout}`.trim().split('\n').pop() ?? ''
    if (r.status !== 0) errors.push(`uv-cache: exit ${r.status}: ${line}`)
    console.log(`  ${'uv-cache'.padEnd(14)} ${line}`)
  }

  console.log('Report only (data, never pruned):')
  for (const [label, p] of [
    ['~/backups', join(home, 'backups')],
    ['~/.claude/projects', join(home, '.claude/projects')],
    ['~/.claude/.git', join(home, '.claude/.git')],
  ] as const) console.log(`  ${label.padEnd(20)} ${gb(dirBytes(p))}`)
  const wt = spawnSync('git', ['-C', join(home, '.claude'), 'worktree', 'list'], { encoding: 'utf-8', stdio: 'pipe' })
  const extra = (wt.stdout ?? '').trim().split('\n').filter(Boolean).length - 1
  if (extra > 0) console.log(`  git worktrees: ${extra} besides main — review with \`git worktree list\``)

  const after = disk()
  console.log(`Freed ${gb(Math.max(0, before.used - after.used))} (df) — / at ${after.pct}%, ${gb(after.avail)} free`)
  for (const e of errors) console.log(`  ERROR ${e}`)

  if (notify && (after.pct >= alertPct || errors.length)) {
    const message = errors.length
      ? `DiskPrune: ${errors.length} error(s); / at ${after.pct}%. ${errors.join(' | ').slice(0, 600)}`
      : `DiskPrune: / still at ${after.pct}% (${gb(after.avail)} free) after pruning. Time to grow the disk or clear data.`
    try {
      const res = await fetch(PULSE_NOTIFY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }), signal: AbortSignal.timeout(5000),
      })
      console.log(res.ok ? `Pulse notified (HTTP ${res.status})` : `Pulse notify failed: HTTP ${res.status}`)
    } catch (e) { console.log(`Pulse notify failed: ${e}`) }
  }
  return errors.length ? 1 : 0
}

if (import.meta.main) process.exit(await main())
