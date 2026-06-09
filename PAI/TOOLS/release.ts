#!/usr/bin/env bun
/**
 * release.ts — Stage and push a sanitized secunit release to Forgejo.
 *
 * Stages to ~/.cache/secunit-stage → strips private zones → sanitizes personal identifiers →
 * runs SecretScan + identifier gate → confirms → pushes to Forgejo.
 * Never modifies the live PAI tree.
 *
 * Usage:
 *   bun PAI/TOOLS/release.ts [--push] [--dry-run] [--verbose] [--version X.Y.Z]
 *                            [--bump patch|minor|major] [--bump-algo patch|minor|major]
 *
 *   --scan-only              Stage + scan only, skip push (default: push after confirmation)
 *   --push                   No-op alias kept for backwards compatibility
 *   --dry-run                Stage only, skip all scans and push (fastest check)
 *   --verbose                Log every file operation
 *   --version X.Y.Z          Override version tag in commit (default: reads from settings.json)
 *   --bump patch|minor|major Increment pai.version in settings.json before release
 *   --bump-algo patch|minor|major  Increment algorithmVersion in settings.json before release
 */

import { mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, lstatSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { spawnSync } from 'child_process'
import { tmpdir, homedir } from 'os'
import { createInterface } from 'readline'
import { parse as parseYaml, stringify as yamlStringify } from 'yaml'

// ── Config ────────────────────────────────────────────────────────────────────

const HOME = homedir()
const CLAUDE_DIR = join(HOME, '.claude')
const PAI_SRC = join(CLAUDE_DIR, 'PAI')
const TEMPLATES_USER = join(PAI_SRC, 'TEMPLATES', 'User')
const SECRET_SCAN = join(PAI_SRC, 'TOOLS', 'SecretScan.ts')
// Forgejo remote — override via SECUNIT_REMOTE env var for self-hosted setups
const FORGEJO_REMOTE = process.env.SECUNIT_REMOTE ?? 'ssh://git@YOUR_FORGEJO_HOST:2222/YOUR_USER/secunit.git'
// GitHub remote — set SECUNIT_GITHUB_REMOTE to also push to GitHub after Forgejo
const GITHUB_REMOTE = process.env.SECUNIT_GITHUB_REMOTE ?? null

// Stage under $HOME to avoid /tmp size constraints on VMs; $TMPDIR overrides both
const _stageBase = process.env.TMPDIR ?? join(homedir(), '.cache', 'secunit-stage')
const STAGE_ROOT = join(_stageBase, `secunit-release-${Date.now()}`)

// Work-client skill names stripped from public skill-routing.yaml
const WORK_CLIENT_SKILLS = new Set(['asa', 'tabletop-exercise', 'aurascape'])

// Skill directories to exclude from the public release
const PRIVATE_SKILL_DIRS = new Set([
  'Recon', 'TabletopExercise', '_ARCHIVE',
  'app-security-assessment', 'app_best_practice', 'esi-branded-docx',
  '_ES_SOLUTIONS_PLACEMENT',
])

// Algorithm version — read from ALGORITHM/LATEST (authoritative; settings.json can drift)
const ALGO_VERSION_LATEST = (() => {
  try { return readFileSync(join(PAI_SRC, 'ALGORITHM', 'LATEST'), 'utf-8').trim() } catch { return '7.0.0' }
})()

// Skill count set during stage(), used in tip strings
let stagedSkillCount = 0

// Text file extensions to include in identifier scan
const TEXT_EXTS = new Set(['.ts', '.js', '.mts', '.mjs', '.md', '.yaml', '.yml', '.json', '.sh', '.toml', '.txt', '.env', '.example', '.log'])

// ── CLI args ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const argSet = new Set(argv)
const PUSH = !argSet.has('--scan-only')  // default: push after confirmation; --scan-only to skip
const DRY_RUN = argSet.has('--dry-run')
const VERBOSE = argSet.has('--verbose')
const YES = argSet.has('--yes')  // skip interactive confirmation
const FORCE_SNAPSHOT = argSet.has('--force-snapshot')  // revert to single-commit history wipe
const _versionIdx = argv.indexOf('--version')
const VERSION_ARG = _versionIdx >= 0 ? argv[_versionIdx + 1] : undefined
const _bumpIdx = argv.indexOf('--bump')
const BUMP_ARG = _bumpIdx >= 0 ? argv[_bumpIdx + 1] : undefined
const _bumpAlgoIdx = argv.indexOf('--bump-algo')
const BUMP_ALGO_ARG = _bumpAlgoIdx >= 0 ? argv[_bumpAlgoIdx + 1] : undefined

type BumpLevel = 'patch' | 'minor' | 'major'

function bumpSemver(v: string, level: BumpLevel): string {
  const [maj, min, pat] = v.split('.').map(Number)
  if (level === 'major') return `${maj + 1}.0.0`
  if (level === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

function applyBumps(): void {
  if (!BUMP_ARG && !BUMP_ALGO_ARG) return
  const settingsPath = join(CLAUDE_DIR, 'settings.json')
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  if (BUMP_ARG) {
    if (!['patch', 'minor', 'major'].includes(BUMP_ARG)) {
      fail(`--bump must be patch, minor, or major (got: ${BUMP_ARG})`); process.exit(1)
    }
    const prev = settings?.pai?.version ?? '0.1.0'
    settings.pai.version = bumpSemver(prev, BUMP_ARG as BumpLevel)
    log(`  ✓ pai.version: ${prev} → ${settings.pai.version}`)
  }
  if (BUMP_ALGO_ARG) {
    if (!['patch', 'minor', 'major'].includes(BUMP_ALGO_ARG)) {
      fail(`--bump-algo must be patch, minor, or major (got: ${BUMP_ALGO_ARG})`); process.exit(1)
    }
    const prev = settings?.pai?.algorithmVersion ?? '7.0.0'
    settings.pai.algorithmVersion = bumpSemver(prev, BUMP_ALGO_ARG as BumpLevel)
    log(`  ✓ algorithmVersion: ${prev} → ${settings.pai.algorithmVersion}`)
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
}

function resolveVersion(): string {
  if (VERSION_ARG) return VERSION_ARG
  try {
    const settings = JSON.parse(readFileSync(join(CLAUDE_DIR, 'settings.json'), 'utf-8'))
    return settings?.pai?.version ?? '0.1.0'
  } catch {
    return '0.1.0'
  }
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg: string) { process.stdout.write(msg + '\n') }
function verbose(msg: string) { if (VERBOSE) log(`  [v] ${msg}`) }
function fail(msg: string) { process.stderr.write(`[FAIL] ${msg}\n`) }

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir(p: string) { mkdirSync(p, { recursive: true }) }

function rm(p: string) {
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true })
    verbose(`rm ${p}`)
  }
}

function writeText(p: string, content: string) {
  ensureDir(dirname(p))
  writeFileSync(p, content, 'utf-8')
}

function sanitizeFile(p: string, replacements: Array<[RegExp, string]>): boolean {
  if (!existsSync(p)) return false
  let content = readFileSync(p, 'utf-8')
  let changed = false
  for (const [re, rep] of replacements) {
    const next = content.replace(re, rep)
    if (next !== content) { content = next; changed = true }
  }
  if (changed) writeFileSync(p, content, 'utf-8')
  return changed
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(res => rl.question(`${question} [y/N] `, a => { rl.close(); res(a.trim().toLowerCase() === 'y') }))
}

// ── Stage: copy source trees ──────────────────────────────────────────────────

function stage() {
  log(`\n📦 Staging to ${STAGE_ROOT}`)
  ensureDir(STAGE_ROOT)

  cpSync(PAI_SRC, join(STAGE_ROOT, 'PAI'), { recursive: true })
  log('  ✓ PAI/')

  const SKILLS_SRC = join(CLAUDE_DIR, 'skills')
  const SKILLS_DEST = join(STAGE_ROOT, 'skills')
  ensureDir(SKILLS_DEST)
  stagedSkillCount = 0
  for (const entry of readdirSync(SKILLS_SRC)) {
    if (PRIVATE_SKILL_DIRS.has(entry)) continue
    const src = join(SKILLS_SRC, entry)
    if (!statSync(src).isDirectory()) continue
    cpSync(src, join(SKILLS_DEST, entry), { recursive: true })
    stagedSkillCount++
  }
  log(`  ✓ skills/ — ${stagedSkillCount} public skills`)

  const HOOKS_SRC = join(CLAUDE_DIR, 'hooks')
  if (existsSync(HOOKS_SRC)) {
    cpSync(HOOKS_SRC, join(STAGE_ROOT, 'hooks'), { recursive: true })
    log('  ✓ hooks/')
  } else {
    log('  ⚠ hooks/ not found — skipping')
  }
}

// ── Strip: remove private zones ───────────────────────────────────────────────

function strip() {
  log('\n🔥 Stripping private zones')
  const pai = join(STAGE_ROOT, 'PAI')
  const skills = join(STAGE_ROOT, 'skills')

  // --- USER/ → scaffold -----------------------------------------
  // Read config files before deleting USER/
  const skillRoutingSrc = join(PAI_SRC, 'USER', 'Config', 'skill-routing.yaml')

  rm(join(pai, 'USER'))
  if (existsSync(TEMPLATES_USER)) {
    cpSync(TEMPLATES_USER, join(pai, 'USER'), { recursive: true })
    log('  ✓ USER/ → TEMPLATES/User/ scaffold')
  } else {
    ensureDir(join(pai, 'USER'))
    writeText(join(pai, 'USER', 'README.md'),
      '# USER/\n\nPersonal configuration. Run `/interview` to populate.\nSee `PAI/DOCUMENTATION/LifeOs/LifeOsSchema.md` for the schema.\n')
    log('  ✓ USER/ → minimal scaffold (TEMPLATES/User/ not found)')
  }

  // Add example config files to USER/Config/
  ensureDir(join(pai, 'USER', 'Config'))
  writeText(join(pai, 'USER', 'Config', 'PAI_CONFIG.example.yaml'), PAI_CONFIG_EXAMPLE)
  writeText(join(pai, 'USER', 'Config', 'inference-routing.yaml'), INFERENCE_ROUTING_EXAMPLE)
  writeText(join(pai, 'USER', 'Config', 'skill-routing.yaml'),
    buildSkillRouting(skillRoutingSrc))
  log('  ✓ USER/Config/ → example configs + filtered skill-routing.yaml')

  // --- MEMORY/ → empty scaffold ---------------------------------
  rm(join(pai, 'MEMORY'))
  ensureDir(join(pai, 'MEMORY'))
  writeText(join(pai, 'MEMORY', '.gitkeep'), '')
  writeText(join(pai, 'MEMORY', 'README.md'),
    '# MEMORY/\n\nRuntime memory — generated by PAI. Not committed.\nSee `PAI/DOCUMENTATION/Memory/MemorySystem.md`.\n')
  log('  ✓ MEMORY/ → empty scaffold')

  // --- PLANS/ → strip ------------------------------------------
  rm(join(pai, 'PLANS'))
  log('  ✓ PLANS/ stripped')

  // --- node_modules/ → strip everywhere -----------------------
  rm(join(pai, 'TOOLS', 'node_modules'))
  rm(join(pai, 'TOOLS', 'pipeline-monitor-ui', 'node_modules'))
  rm(join(pai, 'PULSE', 'Observability', 'node_modules'))
  log('  ✓ node_modules/ stripped (TOOLS, pipeline-monitor-ui, PULSE/Observability)')

  rm(join(STAGE_ROOT, 'hooks', 'node_modules'))
  log('  ✓ hooks/node_modules/ stripped')

  // --- PULSE/state/ → strip (runtime data with personal info) --
  rm(join(pai, 'PULSE', 'state'))
  rm(join(pai, 'Pulse', 'state'))  // lowercase alias
  log('  ✓ PULSE/state/ stripped')

  // --- PULSE/logs/ → strip (runtime logs contain local file paths) --
  rm(join(pai, 'PULSE', 'logs'))
  rm(join(pai, 'Pulse', 'logs'))
  log('  ✓ PULSE/logs/ stripped')

  // --- PULSE/Observability/src/app/telos/ → strip (personal goals) -
  rm(join(pai, 'PULSE', 'Observability', 'src', 'app', 'telos'))
  log('  ✓ PULSE/Observability/src/app/telos/ stripped')

  // --- PULSE/Observability build artifacts → strip (contain baked-in personal data) -
  rm(join(pai, 'PULSE', 'Observability', '.next'))
  rm(join(pai, 'PULSE', 'Observability', 'out'))
  log('  ✓ PULSE/Observability/.next/ + out/ stripped')

  // --- .quote-cache → strip (runtime state, regenerated on first load) -
  rm(join(pai, '.quote-cache'))
  log('  ✓ .quote-cache stripped (regenerates from Aphorisms DB on first run)')

  // --- secunit README → promote to repo root -------------------
  const readmeSrc = join(pai, 'DOCUMENTATION', 'secunit-README.md')
  if (existsSync(readmeSrc)) {
    writeFileSync(join(STAGE_ROOT, 'README.md'), readFileSync(readmeSrc, 'utf-8'), 'utf-8')
    log('  ✓ DOCUMENTATION/secunit-README.md → README.md (repo root)')
  } else {
    log('  ⚠ secunit-README.md not found — no root README.md')
  }

  // --- CHANGELOG → promote to repo root ------------------------
  const changelogSrc = join(pai, 'DOCUMENTATION', 'secunit-CHANGELOG.md')
  if (existsSync(changelogSrc)) {
    writeFileSync(join(STAGE_ROOT, 'CHANGELOG.md'), readFileSync(changelogSrc, 'utf-8'), 'utf-8')
    log('  ✓ DOCUMENTATION/secunit-CHANGELOG.md → CHANGELOG.md (repo root)')
  } else {
    log('  ⚠ secunit-CHANGELOG.md not found — no root CHANGELOG.md')
  }

  // --- LICENSE → promote to repo root --------------------------
  const licenseSrc = join(pai, 'LICENSE')
  if (existsSync(licenseSrc)) {
    writeFileSync(join(STAGE_ROOT, 'LICENSE'), readFileSync(licenseSrc, 'utf-8'), 'utf-8')
    log('  ✓ LICENSE → repo root')
  } else {
    log('  ⚠ LICENSE not found — no root LICENSE')
  }

  // --- install.sh → promote to repo root -----------------------
  const installSrc = join(pai, 'install.sh')
  if (existsSync(installSrc)) {
    const installDest = join(STAGE_ROOT, 'install.sh')
    writeFileSync(installDest, readFileSync(installSrc, 'utf-8'), 'utf-8')
    chmodSync(installDest, 0o755)
    log('  ✓ PAI/install.sh → install.sh (repo root, +x)')
  } else {
    log('  ⚠ PAI/install.sh not found — no root installer')
  }

  // --- GitHub/ → .github/ at repo root -------------------------
  const githubSrc = join(pai, 'GitHub')
  if (existsSync(githubSrc)) {
    const githubDest = join(STAGE_ROOT, '.github')
    cpSync(githubSrc, githubDest, { recursive: true })
    // SECURITY.md also lives at repo root (GitHub surfaces it in the Security tab)
    const securitySrc = join(githubDest, 'SECURITY.md')
    if (existsSync(securitySrc)) {
      writeFileSync(join(STAGE_ROOT, 'SECURITY.md'), readFileSync(securitySrc, 'utf-8'), 'utf-8')
    }
    log('  ✓ PAI/GitHub/ → .github/ + SECURITY.md (repo root)')
  } else {
    log('  ⚠ PAI/GitHub/ not found — no .github/ scaffolding')
  }

  // --- Aphorisms: swap database to release seed ----------------
  const dbPath = join(skills, 'Aphorisms', 'Database', 'aphorisms.md')
  const releaseSeed = join(skills, 'Aphorisms', 'Database', 'aphorisms-release.md')
  if (existsSync(releaseSeed)) {
    writeFileSync(dbPath, readFileSync(releaseSeed, 'utf-8'), 'utf-8')
    rm(releaseSeed)
    log('  ✓ Aphorisms: database → release seed (Sagan)')
  }

  // --- settings.json → sanitized template ----------------------
  sanitizeSettingsJson(pai)
  // Promote settings.json to repo root so bundle-copy install picks it up at ~/.claude/settings.json
  const settingsPai = join(STAGE_ROOT, 'PAI', 'settings.json')
  if (existsSync(settingsPai)) {
    writeFileSync(join(STAGE_ROOT, 'settings.json'), readFileSync(settingsPai, 'utf-8'), 'utf-8')
    log('  ✓ settings.json → repo root (bundle-copy install target)')
  }
}

// ── Settings.json sanitization ────────────────────────────────────────────────

// Public skills secunit ships — only tips referencing these slash commands survive
const PUBLIC_SKILL_COMMANDS = new Set([
  'aperture-oscillation', 'council', 'first-principles', 'iterative-depth',
  'root-cause-analysis', 'science', 'systems-thinking', 'aphorisms',
  'arxiv', 'context-search', 'extract-wisdom', 'knowledge', 'private-investigator', 'research',
  'art', 'be-creative', 'ideate', 'webdesign', 'write-story',
  'agents', 'create-cli', 'create-skill', 'daemon', 'delegation', 'evals',
  'isa', 'loop', 'migrate', 'optimize', 'pai-upgrade', 'prompting',
  'red-team', 'world-threat-model',
  'apify', 'bright-data', 'browser', 'fabric', 'interceptor',
  'bitter-pill-engineering', 'interview', 'sales', 'telos',
])

// Inline string fixes applied before strip check (find → replace within tip text)
const TIP_INLINE_FIXES: [string, string][] = [
  ['Playwright is banned across PAI.',
   'Playwright MCP (browser_navigate) is the headless fallback when no DISPLAY is available.'],
  ['SkillGuard + AgentGuard active via Pulse HTTP routes at pai:31337.',
   'SkillGuard and AgentGuard active when Pulse is running (optional).'],
  ['Use ${PAI_DIR}, ${PROJECTS_DIR}, {PRINCIPAL.NAME}.',
   'Use ${PAI_DIR} or ${HOME}/.claude for paths.'],
]

// Strip any tip containing these substrings (checked after inline fixes)
const STRIP_TIP_PATTERNS: string[] = [
  '90 skills, 387 workflows',
  '{DA_IDENTITY.NAME}', '{PRINCIPAL.NAME}',
  'Algorithm v3.24',
  'Euphoric Surprise is the goal',
  'Loop mode spawns claude -p sessions',
  'v5.0 skills: 48 public and 42 private',
  'pai:31337/notify',
  'your-project.example.com',
  'your-domain.example.com',
]

// New secunit-specific tips — populated at sanitize time when counts are known
function buildSecunitTips(): string[] {
  return [
    `secunit runs Algorithm v${ALGO_VERSION_LATEST} — a reliability release. 146 logged failure events drove six coordinated changes.`,
    `${stagedSkillCount} public skills across cognition, research, security, infrastructure, web, and life OS.`,
    'To cure carpal tunnel syndrome: stand up from desk, leave the room, walk away never to be seen again.',
  ]
}

function sanitizeSettingsJson(stageDir: string): void {
  const src = join(CLAUDE_DIR, 'settings.json')
  if (!existsSync(src)) { log('  ⚠ settings.json not found — skipping template generation'); return }

  const raw = JSON.parse(readFileSync(src, 'utf-8'))

  // Blank user-specific fields
  raw.principal = { name: '', pronunciation: '', timezone: raw.principal?.timezone ?? 'America/New_York', voiceClone: '' }
  raw.daidentity = { name: '', fullName: '', displayName: '', color: raw.daidentity?.color ?? '#3B82F6' }
  raw.feedbackSurveyState = {}

  // Sync algorithmVersion from ALGORITHM/LATEST — settings.json can drift behind LATEST
  raw.pai = Object.assign(raw.pai ?? {}, { algorithmVersion: ALGO_VERSION_LATEST })

  // Strip personal env vars; keep system-level timeouts
  const keepEnv = new Set(['BASH_DEFAULT_TIMEOUT_MS', 'API_TIMEOUT_MS'])
  raw.env = Object.fromEntries(
    Object.entries(raw.env ?? {}).filter(([k]) => keepEnv.has(k))
  )
  raw.env.PAI_DIR = '${HOME}/.claude/PAI'

  // Blank notification tokens; preserve structure and routing config
  if (raw.notifications) {
    if (raw.notifications.ntfy) { raw.notifications.ntfy.topic = ''; raw.notifications.ntfy.enabled = false }
    if (raw.notifications.discord) { raw.notifications.discord.webhook = ''; raw.notifications.discord.enabled = false }
    if (raw.notifications.twilio) { raw.notifications.twilio.toNumber = ''; raw.notifications.twilio.enabled = false }
  }

  // Remove work-client plugins and marketplaces
  if (raw.enabledPlugins) delete raw.enabledPlugins['app-security-assessment@app-security-assessment']
  if (raw.extraKnownMarketplaces) delete raw.extraKnownMarketplaces['app-security-assessment']

  // Sanitize tips
  const override = raw.spinnerTipsOverride ?? { excludeDefault: true, tips: [] }
  let tips: string[] = override.tips ?? []

  // 1. Apply inline fixes
  tips = tips.map(tip => {
    let t = tip
    for (const [find, replace] of TIP_INLINE_FIXES) {
      if (t.includes(find)) t = t.replace(find, replace)
    }
    return t
  })

  // 2. Strip tips referencing non-public slash commands
  tips = tips.filter(tip => {
    const m = tip.match(/^(\/[\w-]+)/)
    if (!m) return true
    const cmd = m[1].slice(1).toLowerCase()
    return PUBLIC_SKILL_COMMANDS.has(cmd)
  })

  // 3. Strip tips matching bad patterns
  tips = tips.filter(tip => !STRIP_TIP_PATTERNS.some(pat => tip.includes(pat)))

  // 4. Append secunit-specific tips
  tips.push(...buildSecunitTips())

  override.tips = tips
  raw.spinnerTipsOverride = override

  // Write to PAI/settings.json (installer merges user fields into this template)
  const dest = join(stageDir, 'settings.json')
  writeFileSync(dest, JSON.stringify(raw, null, 2), 'utf-8')
  log(`  ✓ settings.json → sanitized template (${tips.length} tips, personal fields blanked)`)
}

function buildSkillRouting(srcPath: string): string {
  const header = `version: 1
decision_date: ${new Date().toISOString().slice(0, 10)}
description: |
  Skill-level routing preferences. Each skill declares its preferred inference tier
  and optional model hints. At runtime, Inference.ts resolves tier → available models
  via inference-routing.yaml, then selects the best available model.

  If a skill does not appear here, Inference.ts uses --level CLI param or defaults
  to 'standard' tier.

`
  try {
    const raw = readFileSync(srcPath, 'utf-8')
    const doc = parseYaml(raw) as any
    if (doc?.skills && Array.isArray(doc.skills)) {
      doc.skills = doc.skills.filter((s: any) => !WORK_CLIENT_SKILLS.has(s.name))
      doc.decision_date = new Date().toISOString().slice(0, 10)
      return yamlStringify(doc)
    }
  } catch {
    // fallback: line-based filter
    if (existsSync(srcPath)) {
      const lines = readFileSync(srcPath, 'utf-8').split('\n')
      const out: string[] = []
      let skip = false
      for (const line of lines) {
        if (/^\s+-\s+name:\s+"?(tabletop-exercise|asa|aurascape)"?/.test(line)) { skip = true }
        else if (skip && /^\s+-\s+name:/.test(line)) { skip = false }
        if (!skip) out.push(line)
      }
      return out.join('\n')
    }
  }
  return header + 'skills: []\n'
}

// ── Sanitize: replace personal identifiers in public source files ─────────────

interface Sanitization {
  rel: string
  replacements: Array<[RegExp, string]>
}

const SANITIZATIONS: Sanitization[] = [
  {
    rel: 'PAI/TOOLS/audiobookify.ts',
    replacements: [
      [/100\.126\.185\.104/g, 'localhost'],
      [/\bubullm\b/gi, 'your-inference-host'],
    ],
  },
  {
    rel: 'PAI/TOOLS/BenchmarkLocalModels.ts',
    replacements: [
      [/100\.124\.228\.50/g, 'localhost'],
    ],
  },
  {
    rel: 'PAI/TOOLS/QualityTestModels.ts',
    replacements: [
      [/100\.124\.228\.50/g, 'localhost'],
    ],
  },
  {
    rel: 'PAI/TOOLS/BenchAllGgufs.sh',
    replacements: [
      [/\bubullm\b/gi, 'your-inference-host'],
      [/100\.126\.185\.104/g, '127.0.0.1'],
    ],
  },
  {
    rel: 'PAI/TOOLS/BenchNewModels.sh',
    replacements: [
      [/\bubullm\b/gi, 'your-inference-host'],
      [/100\.126\.185\.104/g, '127.0.0.1'],
    ],
  },
  {
    rel: 'PAI/TOOLS/LibraryClassify.ts',
    replacements: [[/192\.168\.1\.252/g, '<NAS_HOST>']],
  },
  {
    rel: 'PAI/TOOLS/LibraryIngest.ts',
    replacements: [[/192\.168\.1\.252/g, '<NAS_HOST>']],
  },
  {
    rel: 'PAI/TOOLS/Inference.ts',
    replacements: [
      [/\bcsonprop\b/g, 'host1'],
      [/\bubullm\b/g, 'host2'],
      [/100\.126\.185\.104/g, '127.0.0.1'],
      [/100\.124\.228\.50/g, '127.0.0.1'],
      [/gps-cyber\.com/g, 'your-domain.example.com'],
    ],
  },
  {
    rel: 'PAI/TOOLS/SubmitLocalMaxxing.ts',
    replacements: [[/\bubullm\b/g, 'your-inference-host']],
  },
  {
    rel: 'PAI/hooks/InferenceRouting.hook.ts',
    replacements: [
      [/\bcsonprop\b/g, 'host1'],
      [/\bubullm\b/g, 'host2'],
    ],
  },
  {
    rel: 'PAI/DOCUMENTATION/secunit-feature-diff.md',
    replacements: [
      [/\bubullm\b/g, 'host2'],
      [/\bcsonprop\b/g, 'host1'],
      [/Evolving Solutions/g, 'your-organization'],
    ],
  },
  {
    rel: 'PAI/GOALS/moonshot-candidates.md',
    replacements: [
      [/Evolving Solutions/g, 'your-organization'],
    ],
  },
  {
    rel: 'PAI/PULSE/pulse.ts',
    replacements: [
      [/\b100\.\d+\.\d+\.\d+\b/g, 'YOUR_TAILSCALE_IP'],
    ],
  },
  {
    rel: 'PAI/PULSE/Assistant/module.ts',
    replacements: [
      [/George Pagel/g, 'Your Name'],
      [/\bPagel\b/g, 'User'],
      [/georgepagel@gmail\.com/gi, 'user@example.com'],
    ],
  },
  {
    rel: 'PAI/TOOLS/TLDRHarvest.ts',
    replacements: [
      [/George Pagel:[^"']*/g, 'Your Name: your interests and focus areas here.'],
    ],
  },
  {
    rel: 'PAI/DOCUMENTATION/TLDR/cron-config.md',
    replacements: [
      [/\/home\/realuser\//g, '/home/<username>/'],
    ],
  },
  {
    rel: 'PAI/TOOLS/BenchV100.sh',
    replacements: [
      [/\bubullm\b/gi, 'your-inference-host'],
      [/100\.126\.185\.104/g, '127.0.0.1'],
      [/\/home\/axcint09\//g, '/home/<username>/'],
      [/\baxcint09\b/g, '<username>'],
    ],
  },
  {
    rel: 'PAI/TOOLS/MigrateKnowledgeToArchive.ts',
    replacements: [
      [/\/home\/realuser\//g, '${HOME}/'],
      [/-home-realuser/g, '-home-<username>'],
    ],
  },
  {
    rel: 'PAI/DOCUMENTATION/Integration/DELIVERABLES.txt',
    replacements: [[/\/home\/realuser\//g, '/home/<username>/']],
  },
  {
    rel: 'PAI/DOCUMENTATION/Integration/PortkeyImplementationChecklist.md',
    replacements: [[/\/home\/realuser\//g, '/home/<username>/']],
  },
  {
    rel: 'PAI/DOCUMENTATION/Integration/PortkeyASAWorkflow.md',
    replacements: [
      [/\/home\/realuser\//g, '/home/<username>/'],
      [/Evolving Solutions/g, 'your-organization'],
    ],
  },
  {
    rel: 'PAI/DOCUMENTATION/Integration/PortkeyIntegration.md',
    replacements: [[/\/home\/realuser\//g, '/home/<username>/']],
  },
  {
    rel: 'hooks/PromptProcessing.hook.ts',
    replacements: [
      [/\bubullm\b/gi, 'your-inference-host'],
    ],
  },
]

function sanitize() {
  log('\n🧹 Sanitizing personal identifiers in public code')
  let count = 0
  for (const { rel, replacements } of SANITIZATIONS) {
    const changed = sanitizeFile(join(STAGE_ROOT, rel), replacements)
    if (changed) { log(`  ✓ ${rel}`); count++ }
    else verbose(`  - ${rel}: no matches`)
  }
  log(`  ${count}/${SANITIZATIONS.length} files had changes`)
}

// ── Identifier gate ────────────────────────────────────────────────────────────

interface Hit { file: string; line: number; pattern: string; text: string }

interface ScanPattern {
  re: RegExp
  label: string
  // Files (relative to STAGE_ROOT) where this pattern is intentional
  whitelist?: RegExp
}

const PERSONAL_PATTERNS: ScanPattern[] = [
  // Tailscale CGNAT block (100.64.0.0/10)
  {
    re: /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b/g,
    label: 'tailscale-ip',
  },
  // RFC-1918 LAN
  {
    re: /\b192\.168\.\d+\.\d+\b/g,
    label: 'lan-ip',
    whitelist: /CommandInjection\.md$|skills\/Fabric\/Patterns\/|skills\/ISA\/Examples\//,
  },
  {
    re: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    label: 'lan-ip-10',
    whitelist: /skills\/Fabric\/Patterns\/|skills\/ISA\/Examples\//,
  },
  // GP's machine names
  {
    re: /\b(ubullm|csonprop|ubupai)\b/gi,
    label: 'machine-name',
  },
  // Linux username and Claude-derived project path
  {
    re: /\brealuser\b/g,
    label: 'linux-username',
  },
  {
    re: /-home-realuser/g,
    label: 'linux-username-derived',
  },
  // Personal domains / usernames / handles
  {
    re: /(goose-mirach|realgoodcollab|gps-cyber|axcint09|georgepagel)/gi,
    label: 'personal-identifier',
  },
  // Work company names — ESI uppercase only (lowercase "esi" hits Turkish locale strings)
  {
    re: /\b(Evolving Solutions|esilabs|evolvingsol|ESI)\b/g,
    label: 'work-company',
  },
  // Personal name — whitelisted in copyright files (intentional authorship credit)
  {
    re: /George Pagel/g,
    label: 'personal-name',
    whitelist: /secunit-README\.md$|\/LICENSE$|^README\.md$/,
  },
  {
    re: /\bPagel\b/g,
    label: 'personal-surname',
    whitelist: /secunit-README\.md$|\/LICENSE$|^README\.md$|aphorisms/i,
  },
  // Personal email
  {
    re: /georgepagel@gmail\.com/gi,
    label: 'personal-email',
  },
]

function runIdentifierGate(): { pass: boolean; hits: Hit[] } {
  log('\n🛡  Running personal identifier gate')
  const hits: Hit[] = []

  // Files that intentionally reference personal identifiers (the scanner itself, etc.)
  const SCAN_WHITELIST = new Set(['PAI/TOOLS/release.ts'])

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'out' || entry === '.cursor') continue
      const full = join(dir, entry)
      let st: ReturnType<typeof lstatSync>
      try { st = lstatSync(full) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) { walk(full); continue }
      const ext = entry.includes('.') ? '.' + entry.split('.').pop()! : ''
      if (!TEXT_EXTS.has(ext)) continue
      const rel = full.slice(STAGE_ROOT.length + 1)
      if (SCAN_WHITELIST.has(rel)) continue
      try {
        const lines = readFileSync(full, 'utf-8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          for (const { re, label, whitelist } of PERSONAL_PATTERNS) {
            if (whitelist?.test(rel)) continue
            re.lastIndex = 0
            if (re.test(lines[i])) {
              hits.push({ file: rel, line: i + 1, pattern: label, text: lines[i].trim().slice(0, 120) })
            }
          }
        }
      } catch { /* skip unreadable files */ }
    }
  }

  walk(STAGE_ROOT)

  if (hits.length === 0) {
    log('  ✓ Identifier gate: clean')
    return { pass: true, hits }
  }

  fail(`Identifier gate: ${hits.length} hit(s)\n`)
  for (const h of hits) {
    log(`  [${h.pattern}] ${h.file}:${h.line}`)
    log(`    ${h.text}`)
  }
  return { pass: false, hits }
}

// ── ADR stub gate ─────────────────────────────────────────────────────────────

function runAdrStubGate(): boolean {
  log('\n📋 Checking ADR stubs')
  const decisionsDir = join(STAGE_ROOT, 'PAI', 'DOCUMENTATION', 'Decisions')
  if (!existsSync(decisionsDir)) {
    log('  ✓ ADR stub gate: no Decisions/ directory — skipping')
    return true
  }
  const stubs: string[] = []
  for (const entry of readdirSync(decisionsDir)) {
    if (!entry.endsWith('.md') || entry === 'README.md') continue
    const full = join(decisionsDir, entry)
    try {
      const content = readFileSync(full, 'utf-8')
      if (/^status:\s*stub\s*$/m.test(content)) stubs.push(entry)
    } catch { /* skip unreadable */ }
  }
  if (stubs.length === 0) {
    log('  ✓ ADR stub gate: clean')
    return true
  }
  fail(`ADR stub gate: ${stubs.length} unfilled stub(s) — fill reasoning and set status: complete before releasing`)
  for (const s of stubs) log(`    PAI/DOCUMENTATION/Decisions/${s}`)
  return false
}

// ── SecretScan ────────────────────────────────────────────────────────────────

function runSecretScan(): boolean {
  log('\n🔍 Running SecretScan.ts')
  if (!existsSync(SECRET_SCAN)) {
    log('  ⚠ SecretScan.ts not found — skipping (install TruffleHog to enable)')
    return true
  }
  const r = spawnSync('bun', [SECRET_SCAN, STAGE_ROOT], { encoding: 'utf-8', stdio: 'pipe' })
  if (r.stdout?.trim()) log(r.stdout)
  if (r.stderr?.trim()) log(r.stderr)
  if (r.status !== 0) {
    fail('SecretScan found issues — fix before pushing')
    return false
  }
  log('  ✓ SecretScan: clean')
  return true
}

// ── Git push ──────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', stdio: 'pipe' })
  return { ok: r.status === 0, out: (r.stdout + r.stderr).trim() }
}

// ── Incremental release helpers ───────────────────────────────────────────────

// Work dir persists across pushToForgejo so Forgejo + GitHub share one commit
let _gitWorkDir: string | null = null
let _hasClonedHistory = false

function overlayStage(gitDir: string): void {
  // Wipe everything except .git/, then copy fresh staged tree in
  for (const entry of readdirSync(gitDir)) {
    if (entry === '.git') continue
    rmSync(join(gitDir, entry), { recursive: true, force: true })
  }
  for (const entry of readdirSync(STAGE_ROOT)) {
    cpSync(join(STAGE_ROOT, entry), join(gitDir, entry), { recursive: true })
  }
}

function setupGitWorkDir(primaryRemote: string, version: string): boolean {
  const workDir = `${STAGE_ROOT}-git`
  _gitWorkDir = workDir
  rm(workDir)

  if (!FORCE_SNAPSHOT) {
    const r = spawnSync('git', ['clone', '--depth=50', primaryRemote, workDir], {
      encoding: 'utf-8', stdio: 'pipe',
    })
    _hasClonedHistory = r.status === 0
    if (_hasClonedHistory) {
      log('  ✓ Cloned existing history — will produce incremental commit')
    } else {
      verbose(`clone: ${(r.stdout + r.stderr).trim()}`)
      log('  ⚠ Clone failed — fresh init (first release or empty remote)')
    }
  } else {
    log('  ℹ --force-snapshot: skipping clone, single-commit history wipe')
  }

  if (!_hasClonedHistory) {
    ensureDir(workDir)
    git(workDir, 'init')
    git(workDir, 'remote', 'add', 'origin', primaryRemote)
  }

  git(workDir, 'config', 'user.email', 'secunit-release@local')
  git(workDir, 'config', 'user.name', 'secunit-release')

  overlayStage(workDir)
  git(workDir, 'add', '-A')

  const dirty = git(workDir, 'status', '--porcelain').out.trim()
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const msg = `secunit v${version} — ${ts}`

  if (dirty) {
    const { ok, out } = git(workDir, 'commit', '-m', msg)
    if (!ok) { fail(`git commit failed:\n  ${out}`); return false }
    log(`  ✓ Committed: ${msg}`)
  } else {
    log('  ℹ No file changes since last release — tagging existing HEAD')
  }

  git(workDir, 'tag', '-a', '-f', `v${version}`, '-m', `secunit v${version}`)
  return true
}

function pushToForgejo(version: string): boolean {
  log(`\n🚀 Pushing v${version} to Forgejo`)

  if (!setupGitWorkDir(FORGEJO_REMOTE, version)) return false
  const workDir = _gitWorkDir!

  // Ensure origin points to Forgejo (clone sets it; fresh init already did)
  git(workDir, 'remote', 'set-url', 'origin', FORGEJO_REMOTE)

  // Use --force only when there's no prior history to build on
  const useForce = !_hasClonedHistory || FORCE_SNAPSHOT
  const pushMain = useForce
    ? git(workDir, 'push', '--force', 'origin', 'HEAD:main')
    : git(workDir, 'push', 'origin', 'HEAD:main')

  if (!pushMain.ok) { fail(`Forgejo push failed:\n  ${pushMain.out}`); return false }

  const pushTag = git(workDir, 'push', '--force', 'origin', `refs/tags/v${version}`)
  if (!pushTag.ok) { fail(`Forgejo tag push failed:\n  ${pushTag.out}`); return false }

  log(`  ✓ Pushed to Forgejo`)

  if (GITHUB_REMOTE) {
    log(`\n🚀 Pushing v${version} to GitHub`)

    const remoteExists = git(workDir, 'remote', 'get-url', 'github').ok
    if (remoteExists) git(workDir, 'remote', 'set-url', 'github', GITHUB_REMOTE)
    else git(workDir, 'remote', 'add', 'github', GITHUB_REMOTE)

    const ghPush = useForce
      ? git(workDir, 'push', '--force', 'github', 'HEAD:main')
      : git(workDir, 'push', 'github', 'HEAD:main')

    if (!ghPush.ok) { fail(`GitHub push failed:\n  ${ghPush.out}`); return false }

    const ghTag = git(workDir, 'push', '--force', 'github', `refs/tags/v${version}`)
    if (!ghTag.ok) { fail(`GitHub tag push failed:\n  ${ghTag.out}`); return false }

    log(`  ✓ Pushed to GitHub`)
  }

  return true
}

// ── Example config templates ──────────────────────────────────────────────────

const PAI_CONFIG_EXAMPLE = `# PAI_CONFIG.yaml — Fill in your values and rename to PAI_CONFIG.yaml
# See PAI/DOCUMENTATION/ for the full schema.

version: "5.0.0"

principal:
  name: "<your-name>"
  timezone: "America/New_York"

da:
  name: "<your-da-name>"

anthropic:
  api_key: "<sk-ant-...>"

elevenlabs:
  api_key: "<your-elevenlabs-key>"
  voice_id: "<primary-voice-id>"
  secondary_voice_id: "<secondary-voice-id>"

pulse:
  port: 31337

services:
  forgejo:
    base_url: "<https://your-forgejo-instance>"
    token: "<your-forgejo-token>"

ollama:
  base_url: "http://localhost:11434"
`

const INFERENCE_ROUTING_EXAMPLE = `version: 2
decision_date: ${new Date().toISOString().slice(0, 10)}
description: |
  Per-model routing manifest for local inference.
  Populate with your own hosts and benchmark data.

  Fast tier:     batch p50 < 5000ms
  Standard tier: batch p50 5000–15000ms
  Smart tier:    high-capacity models; latency secondary

  Benchmark with: bun PAI/TOOLS/BenchmarkLocalModels.ts --host <addr>
  Quality-test with: bun PAI/TOOLS/QualityTestModels.ts --host <addr>

inference_hosts:
  host1:
    base_url: "http://localhost:11434"    # your primary inference server
  host2:
    base_url: "http://localhost:11435"    # optional secondary

models:
  - name: "your-model-name"
    preferred_host: "host1"
    tier: "standard"
    tok_per_s: 0
    warm_p50_ms: 0
    quality_pct: 0
    requires_no_think: false
    excluded: false
    notes: "Replace with real data from BenchmarkLocalModels.ts + QualityTestModels.ts"
`

// ── SBOM ─────────────────────────────────────────────────────────────────────

function generateSBOM(version: string): boolean {
  log('\n📋 Generating SBOM')
  // Scan the staged PAI/TOOLS dir — post-strip, so pipeline-monitor-ui and
  // other internal tooling are already excluded from the dep surface.
  const toolsStage = join(STAGE_ROOT, 'PAI', 'TOOLS')
  const outFile = join(STAGE_ROOT, 'sbom.json')
  const r = spawnSync(
    'bunx',
    ['--bun', '@cyclonedx/cdxgen', '-p', toolsStage, '-o', outFile,
     '--type', 'npm', '--spec-version', '1.5'],
    { encoding: 'utf-8', stdio: 'pipe' }
  )
  if (r.status !== 0 || !existsSync(outFile)) {
    log('  ⚠ SBOM generation failed — release continues without sbom.json')
    if (VERBOSE && r.stderr?.trim()) log(`  [v] ${r.stderr.trim()}`)
    return false
  }
  try {
    const sbom = JSON.parse(readFileSync(outFile, 'utf-8'))
    if (sbom.metadata?.component) {
      sbom.metadata.component.name = 'secunit'
      sbom.metadata.component.version = version
    }
    writeFileSync(outFile, JSON.stringify(sbom, null, 2), 'utf-8')
  } catch { /* leave as-is if json parse fails */ }
  log('  ✓ SBOM: sbom.json (CycloneDX 1.5)')
  return true
}

// ── Grype vuln scan ───────────────────────────────────────────────────────────

function resolveGrype(): string | null {
  const candidates = [join(HOME, '.local', 'bin', 'grype'), '/usr/local/bin/grype', '/usr/bin/grype']
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  // fallback: check PATH
  const r = spawnSync('which', ['grype'], { encoding: 'utf-8', stdio: 'pipe' })
  const found = r.stdout?.trim()
  return (r.status === 0 && found) ? found : null
}

function runGrype(): boolean {
  log('\n🔬 Running Grype vulnerability scan')
  const grype = resolveGrype()
  if (!grype) {
    log('  ⚠ grype not found — skipping vuln scan (install: curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh -s -- -b ~/.local/bin)')
    return true
  }
  const sbomFile = join(STAGE_ROOT, 'sbom.json')
  if (!existsSync(sbomFile)) {
    log('  ⚠ sbom.json not found — skipping grype scan')
    return true
  }
  const r = spawnSync(grype, ['-q', '--fail-on', 'high', '-o', 'table', `sbom:${sbomFile}`],
    { encoding: 'utf-8', stdio: 'pipe' })
  const output = (r.stdout ?? '').trim()
  if (output) log(output)
  if (r.status === 2) {
    fail('Grype: HIGH or CRITICAL vulnerabilities found — fix before pushing')
    return false
  }
  const hasFindings = output && !output.includes('No vulnerabilities found')
  if (hasFindings) {
    log('  ⚠ Grype: MEDIUM/LOW findings above — review before pushing')
  } else {
    log('  ✓ Grype: clean')
  }
  return true
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  applyBumps()
  const version = resolveVersion()
  log(`\n════ secunit release v${version} ════`)
  log(`  PUSH=${PUSH}  DRY_RUN=${DRY_RUN}  VERBOSE=${VERBOSE}`)

  stage()

  if (DRY_RUN) {
    log(`\n[dry-run] Skipped strip/sanitize/scan/push`)
    log(`Staged output at: ${STAGE_ROOT}`)
    return
  }

  strip()
  sanitize()

  const adrOk = runAdrStubGate()
  const secretOk = runSecretScan()
  const { pass: identOk, hits } = runIdentifierGate()

  if (!adrOk || !secretOk || !identOk) {
    fail(`\nRelease gate FAILED`)
    fail(`  ADR stub gate: ${adrOk ? 'pass' : 'FAIL'}`)
    fail(`  SecretScan: ${secretOk ? 'pass' : 'FAIL'}`)
    fail(`  Identifier gate: ${identOk ? 'pass' : `FAIL (${hits.length} hits)`}`)
    log(`\nStaged output preserved for inspection: ${STAGE_ROOT}`)
    process.exit(1)
  }

  log(`\n✅ All gates passed`)
  log(`   Staged output: ${STAGE_ROOT}`)

  const sbomOk = generateSBOM(version)
  const grypeOk = sbomOk ? runGrype() : true

  if (!grypeOk) {
    log(`\nStaged output preserved for inspection: ${STAGE_ROOT}`)
    process.exit(1)
  }

  if (!PUSH) {
    log('\nScan-only run complete. Remove --scan-only to push.')
    return
  }

  const go = YES || await confirm(`\nPush v${version} to ${FORGEJO_REMOTE}?`)
  if (!go) {
    log('Push cancelled. Staged output preserved.')
    return
  }

  const pushed = pushToForgejo(version)
  if (pushed) {
    rm(STAGE_ROOT)
    if (_gitWorkDir) rm(_gitWorkDir)
    log('\n🎉 Release complete.' + (GITHUB_REMOTE ? '' : ' Set SECUNIT_GITHUB_REMOTE to also push to GitHub.'))
    log(`   http://tower.goose-mirach.ts.net:3000/theultimate/secunit`)
  }
}

main().catch(e => { fail(String(e)); process.exit(1) })
