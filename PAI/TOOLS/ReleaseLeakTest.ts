#!/usr/bin/env bun
/**
 * ReleaseLeakTest.ts — regression harness for the secunit release gates.
 *
 * release.ts is the only sanctioned path out of ~/.claude. This harness runs the
 * REAL release.ts (`--scan-only`, never a push) against a disposable copy of the
 * tree seeded with canaries, then checks three things:
 *
 *   1. Strip: every canary planted in a private zone is absent from the staged output.
 *   2. Gates: each deterministic gate fires on its planted leak and names the file.
 *   3. Isolation: nothing wrote through to the real tree.
 *
 * The copy is a hardlink farm (`cp -al`), so it costs inodes, not gigabytes. Canaries
 * are always NEW files, and any fixture file this harness rewrites is unlinked first,
 * so no write ever lands on an inode the real tree shares. settings.json (the one file
 * release.ts writes outside its stage, and only after a push) is a real copy.
 *
 * No private values live here (this file ships publicly): identifier plants use the
 * built-in public patterns, the secret plant is a throwaway key generated at runtime,
 * and the private-by-name skill is read from the fixture's own release-private.ts.
 *
 * Usage:
 *   bun PAI/TOOLS/ReleaseLeakTest.ts                      # full check
 *   bun PAI/TOOLS/ReleaseLeakTest.ts --mutate-keep-memory # self-test: disable MEMORY strip; must FAIL ISC-2
 *   bun PAI/TOOLS/ReleaseLeakTest.ts --keep               # keep fixture + stage for inspection
 *
 * Exit: 0 all checks pass · 1 a check failed · 2 inconclusive (release.ts died before its gates)
 */
import { spawnSync } from 'child_process'
import { generateKeyPairSync, randomBytes } from 'crypto'
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const argv = process.argv.slice(2)
const MUTATE = argv.includes('--mutate-keep-memory')
const KEEP = argv.includes('--keep')
// --notify: POST a summary to Pulse /notify when the run fails or is inconclusive.
// Pulse only logs a failed script job (and circuit-breaks it after 3), so a scheduled
// run has to raise its own alarm.
const NOTIFY = argv.includes('--notify')
const PULSE_NOTIFY = 'http://localhost:31337/notify'

const REAL_HOME = homedir()
const REAL_CLAUDE = join(REAL_HOME, '.claude')
const WORK = join(process.env.RELEASE_LEAKTEST_DIR ?? join(REAL_HOME, '.cache', 'release-leaktest'), `run-${Date.now()}`)
const FIX_HOME = join(WORK, 'home')
const FIX_CLAUDE = join(FIX_HOME, '.claude')
const STAGE_BASE = join(WORK, 'stage')
const RUN_ID = randomBytes(6).toString('hex')
const token = (zone: string) => `LEAKTEST_CANARY_${zone}_${RUN_ID}`

// Paths live writers in the REAL tree rewrite in place during any run, so a fresh
// mtime on a shared inode there is churn, not this harness. release.ts never writes
// into its source tree before a push (it copies into its stage first).
//   MEMORY/, PULSE/, PAI dotfiles — daemons
//   ARCHITECTURE_SUMMARY.md, Decisions/_arch-state.json — DocIntegrity Stop hook, every turn end
//   skills/synced/ — Claude Code's own skill sync
const CHURN = [
  /^PAI\/MEMORY\//, /^PAI\/PULSE\//, /^PAI\/Pulse\//, /^PAI\/\.[^/]+$/,
  /^PAI\/DOCUMENTATION\/ARCHITECTURE_SUMMARY\.md$/, /^PAI\/DOCUMENTATION\/Decisions\/_arch-state\.json$/,
  /^skills\/synced\//,
]

const log = (s: string) => process.stdout.write(s + '\n')

interface Result { isc: string; pass: boolean; detail: string }
const results: Result[] = []
const record = (isc: string, pass: boolean, detail: string) => results.push({ isc, pass, detail })

/** Write a file in the fixture without ever touching an inode shared with the real tree. */
function writeFresh(rel: string, content: string) {
  const p = join(FIX_CLAUDE, rel)
  mkdirSync(dirname(p), { recursive: true })
  if (existsSync(p)) unlinkSync(p)
  writeFileSync(p, content)
}

function buildFixture() {
  mkdirSync(FIX_CLAUDE, { recursive: true })
  mkdirSync(STAGE_BASE, { recursive: true })
  for (const d of ['PAI', 'skills', 'hooks']) {
    const r = spawnSync('cp', ['-al', join(REAL_CLAUDE, d), join(FIX_CLAUDE, d)], { stdio: 'pipe', encoding: 'utf-8' })
    if (r.status !== 0) throw new Error(`cp -al ${d} failed: ${r.stderr}`)
  }
  writeFileSync(join(FIX_CLAUDE, 'settings.json'), readFileSync(join(REAL_CLAUDE, 'settings.json')))
  // bunx (cdxgen for the SBOM) caches under $HOME/.bun; point it at the real cache
  // instead of re-downloading into the fixture.
  if (existsSync(join(REAL_HOME, '.bun'))) symlinkSync(join(REAL_HOME, '.bun'), join(FIX_HOME, '.bun'))
}

interface Plant { isc: string; rel: string; tok: string }

async function plant(): Promise<{ stripPlants: Plant[]; identRel: string; secretRel: string; unlistedSkill: string }> {
  const stripPlants: Plant[] = []
  const add = (isc: string, rel: string, zone: string) => {
    const tok = token(zone)
    writeFresh(rel, `# leak test canary\n${tok}\n`)
    stripPlants.push({ isc, rel, tok })
  }
  add('ISC-1', 'PAI/USER/_leaktest.md', 'USER')
  add('ISC-2', 'PAI/MEMORY/_leaktest.md', 'MEMORY')
  add('ISC-3', 'PAI/PLANS/_leaktest.md', 'PLANS')
  add('ISC-3', 'PAI/TOOLS/LiteLLM/_leaktest.yaml', 'LITELLM')
  add('ISC-3', 'PAI/PULSE/state/_leaktest.json', 'PULSESTATE')
  add('ISC-4', 'skills/_LeakTestPrivate/SKILL.md', 'UNDERSCORESKILL')

  // A private-by-name skill (TitleCase, excluded only because it's listed in release-private.ts).
  const privCfg = join(FIX_CLAUDE, 'PAI', 'USER', 'Config', 'release-private.ts')
  if (existsSync(privCfg)) {
    const priv = await import(privCfg)
    const named = [...(priv.PRIVATE_SKILL_DIRS ?? [])].find((d: string) => existsSync(join(FIX_CLAUDE, 'skills', d)))
    if (named) add('ISC-4', `skills/${named}/_leaktest.md`, 'NAMEDPRIVATESKILL')
  }

  // node_modules nested inside a public skill: strip() must remove it everywhere.
  const publicSkill = readdirSync(join(FIX_CLAUDE, 'skills'))
    .find((d) => !d.startsWith('_') && lstatSync(join(FIX_CLAUDE, 'skills', d)).isDirectory())
  if (publicSkill) add('ISC-4', `skills/${publicSkill}/node_modules/leaktest/index.js`, 'NODEMODULES')

  // Gate plants: these are meant to be staged; the gate must stop them.
  const identRel = 'PAI/DOCUMENTATION/_leaktest-identifier.md'
  // Assembled at runtime so this source file carries no address the gate would flag.
  const tailnet = [100, 101, 102, 103].join('.')
  const lan = [192, 168, 77, 77].join('.')
  writeFresh(identRel, `# leak test\nTailnet host ${tailnet} and LAN host ${lan}.\n`)

  const secretRel = 'PAI/DOCUMENTATION/_leaktest-secret.pem'
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  writeFresh(secretRel, privateKey.export({ type: 'pkcs1', format: 'pem' }).toString())

  const unlistedSkill = 'LeakTestUnlisted'
  writeFresh(`skills/${unlistedSkill}/SKILL.md`, `---\nname: ${unlistedSkill}\ndescription: leak test skill that is not on the public allow-list\n---\n\n# ${unlistedSkill}\n`)

  return { stripPlants, identRel, secretRel, unlistedSkill }
}

function mutateReleaseKeepMemory() {
  const rel = 'PAI/TOOLS/release.ts'
  const src = readFileSync(join(FIX_CLAUDE, rel), 'utf-8')
  const target = "rm(join(pai, 'MEMORY'))"
  if (!src.includes(target)) throw new Error(`mutation target not found in release.ts: ${target}`)
  writeFresh(rel, src.replace(target, '/* LEAKTEST MUTATION: MEMORY strip disabled */ void 0'))
  log(`  mutation applied to fixture copy of ${rel} (real file untouched)`)
}

function runRelease(): { status: number | null; out: string; ms: number } {
  const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: FIX_HOME, TMPDIR: STAGE_BASE }
  // Belt and braces: --scan-only never pushes, and even if it did, these remotes go nowhere.
  env.SECUNIT_REMOTE = 'file:///nonexistent/release-leaktest-no-push'
  delete env.SECUNIT_GITHUB_REMOTE
  const args = [join(FIX_CLAUDE, 'PAI', 'TOOLS', 'release.ts'), '--scan-only']
  if (!args.includes('--scan-only') || args.includes('--push')) throw new Error('refusing to run release.ts without --scan-only')
  const t0 = Date.now()
  const r = spawnSync('bun', args, {
    env, cwd: FIX_CLAUDE, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 45 * 60_000, maxBuffer: 256 * 1024 * 1024,
  })
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, ms: Date.now() - t0 }
}

function findStage(out: string): string | null {
  const m = out.match(/Staged output (?:preserved for inspection|at): (\S+)/)
  if (m && existsSync(m[1])) return m[1]
  const dirs = existsSync(STAGE_BASE) ? readdirSync(STAGE_BASE).filter((d) => d.startsWith('secunit-release-')) : []
  return dirs.length ? join(STAGE_BASE, dirs.sort().at(-1)!) : null
}

/** Files under the stage that contain `needle` (grep -F, binary-safe). */
function grepStage(stage: string, needle: string): string[] {
  const r = spawnSync('grep', ['-rlF', '--binary-files=text', needle, stage], { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })
  return (r.stdout ?? '').split('\n').filter(Boolean).map((f) => f.slice(stage.length + 1))
}

/** Fixture files still sharing an inode with the real tree whose mtime moved during the run. */
function sharedInodeWrites(sinceMs: number): string[] {
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e)
      let st
      try { st = lstatSync(full) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) { walk(full); continue }
      const rel = full.slice(FIX_CLAUDE.length + 1)
      if (st.nlink > 1 && st.mtimeMs > sinceMs && !CHURN.some((re) => re.test(rel))) hits.push(rel)
    }
  }
  for (const d of ['PAI', 'skills', 'hooks']) walk(join(FIX_CLAUDE, d))
  return hits
}

function cleanup() {
  if (KEEP) { log(`\n(kept) fixture + stage: ${WORK}`); return }
  const bunLink = join(FIX_HOME, '.bun')
  try { if (lstatSync(bunLink).isSymbolicLink()) unlinkSync(bunLink) } catch {}
  rmSync(WORK, { recursive: true, force: true })
}

async function main(): Promise<number> {
  log(`════ ReleaseLeakTest ${RUN_ID}${MUTATE ? ' (MUTATION: MEMORY strip disabled)' : ''} ════`)
  log(`  work dir: ${WORK}`)
  const startMs = Date.now()
  buildFixture()
  const { stripPlants, identRel, secretRel, unlistedSkill } = await plant()
  log(`  planted ${stripPlants.length} private-zone canaries + 3 gate plants`)
  if (MUTATE) mutateReleaseKeepMemory()

  log('  running release.ts --scan-only against the fixture (this takes a few minutes)…')
  const run = runRelease()
  log(`  release.ts exited ${run.status} after ${(run.ms / 1000).toFixed(0)}s`)
  writeFileSync(join(WORK, 'release-output.log'), run.out)

  if (!/Release gate FAILED|All deterministic gates passed/.test(run.out)) {
    log('\nINCONCLUSIVE: release.ts ended before its deterministic gates ran. Tail of output:')
    log(run.out.trim().split('\n').slice(-15).map((l) => '  | ' + l).join('\n'))
    return 2
  }

  const stage = findStage(run.out)
  if (!stage) { log('\nINCONCLUSIVE: could not locate the staged output'); return 2 }

  // 1. Strip
  for (const p of stripPlants) {
    const leaked = grepStage(stage, p.tok)
    record(p.isc, leaked.length === 0,
      leaked.length === 0 ? `${p.rel} stripped` : `${p.rel} LEAKED into stage: ${leaked.join(', ')}`)
  }

  // 2. Gates
  const identHit = run.out.includes(`] ${identRel}:`)
  record('ISC-5', identHit, identHit ? `identifier gate named ${identRel}` : `identifier gate did NOT name ${identRel}`)

  const secretBlocked = run.out.includes('SecretScan found issues')
  const secretSeen = run.out.includes('_leaktest-secret.pem')
  record('ISC-6', secretBlocked,
    secretBlocked ? 'SecretScan failed the release on the planted private key'
      : secretSeen ? 'SecretScan SAW the planted private key but PASSED the release (it only fails on verified secrets)'
        : 'SecretScan neither reported nor blocked the planted private key')

  const zoneHit = run.out.includes('Private-zone gate:') && new RegExp(`\\b${unlistedSkill} —`).test(run.out)
  record('ISC-7', zoneHit, zoneHit ? `private-zone gate named ${unlistedSkill}` : `private-zone gate did NOT name ${unlistedSkill}`)

  // Real findings the plants didn't cause: the live tree would fail release on these today.
  const otherIdent = [...run.out.matchAll(/^\s+\[([\w-]+)\] (\S+):\d+$/gm)]
    .map((m) => `${m[2]} [${m[1]}]`).filter((s) => !s.startsWith(identRel))
  const otherZone = [...run.out.matchAll(/^\s{4}(\S+) — (?:⚠ LIKELY PRIVATE|⚠ COULD NOT CLASSIFY|looks public)/gm)]
    .map((m) => m[1]).filter((d) => d !== unlistedSkill)

  // 3. Isolation
  const writes = sharedInodeWrites(startMs)
  record('ISC-9', writes.length === 0,
    writes.length === 0 ? 'no writes through shared inodes into the real tree' : `WROTE THROUGH to real tree: ${writes.slice(0, 10).join(', ')}`)

  log('\n── Results ──')
  for (const r of results) log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.isc.padEnd(6)} ${r.detail}`)
  if (otherIdent.length) log(`\n  note: ${otherIdent.length} identifier hit(s) NOT planted by this harness (real tree): ${[...new Set(otherIdent)].slice(0, 8).join('; ')}`)
  if (otherZone.length) log(`  note: unlisted skill(s) NOT planted by this harness: ${otherZone.join(', ')}`)
  log(`\n  full release output: ${join(WORK, 'release-output.log')}${KEEP ? '' : ' (deleted with the work dir; rerun with --keep)'}`)

  const failed = results.filter((r) => !r.pass)
  log(failed.length === 0 ? `\nReleaseLeakTest: all ${results.length} checks passed.` : `\nReleaseLeakTest: ${failed.length}/${results.length} checks FAILED.`)
  return failed.length === 0 ? 0 : 1
}

async function notifyPulse(code: number) {
  const failed = results.filter((r) => !r.pass).map((r) => `${r.isc}: ${r.detail}`)
  const message = code === 2
    ? 'ReleaseLeakTest INCONCLUSIVE: release.ts died before its gates ran. Rerun with --keep and read release-output.log.'
    : `ReleaseLeakTest FAILED ${failed.length}/${results.length}: ${failed.join(' | ').slice(0, 900)}`
  try {
    const res = await fetch(PULSE_NOTIFY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }), signal: AbortSignal.timeout(5000),
    })
    log(res.ok ? `Pulse notified (HTTP ${res.status})` : `Pulse notify failed: HTTP ${res.status}`)
  } catch (e) { log(`Pulse notify failed: ${e}`) }
}

let code = 1
try { code = await main() } catch (e) { log(`ERROR: ${e}`); code = 2 } finally { cleanup() }
if (NOTIFY && code !== 0) await notifyPulse(code)
process.exit(code)
