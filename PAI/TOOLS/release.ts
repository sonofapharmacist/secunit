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
  '_ES_SOLUTIONS_PLACEMENT', '_ES_VENDOR_INTEL',
])

// Fail-safe allow-list of directory names known to be intentionally public.
// PRIVATE_SKILL_DIRS is deny-by-name (staged if not listed); this is the
// complementary allow-by-name check that runs POST-stage, against what
// actually shipped — not what the copy step intended to exclude. A skill
// that ships without appearing here is either a brand-new legitimate public
// skill (add it) or a forgotten-naming mistake (the gap PRIVATE_SKILL_DIRS
// alone cannot catch — see runPrivateZoneGate()).
const PUBLIC_SKILL_DIR_ALLOWLIST = new Set([
  'Agents', 'ApertureOscillation', 'Aphorisms', 'Apify', 'ArXiv', 'Art',
  'BeCreative', 'BitterPillEngineering', 'BrightData', 'Browser',
  'ContextSearch', 'Council', 'CreateCLI', 'CreateSkill', 'Daemon',
  'Delegation', 'DualCheck', 'Evals', 'ExtractWisdom', 'Fabric', 'FirstPrinciples', 'ISA',
  'Ideate', 'Interceptor', 'Interview', 'IterativeDepth', 'Knowledge', 'Loop',
  'Migrate', 'Optimize', 'PAIUpgrade', 'PrivateInvestigator', 'Prompting',
  'RedTeam', 'Research', 'RootCauseAnalysis', 'Sales', 'Science',
  'SessionFork', 'SystemsThinking', 'Telos', 'TmuxCliDriver', 'Verify',
  'Webdesign', 'WorldThreatModel', 'WriteStory',
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
    // Two-layer exclusion: the explicit allowlist covers TitleCase skills that are
    // private despite their name (Recon, app-security-assessment, …); the `_` prefix
    // check enforces the documented `skills/_*` convention so a newly-created private
    // skill is excluded by default rather than shipping until someone remembers to
    // add it here. _ES_VENDOR_INTEL shipped through this gap once.
    if (PRIVATE_SKILL_DIRS.has(entry) || entry.startsWith('_')) continue
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

  // --- TOOLS/LiteLLM/ → strip (local configs carry live provider API keys) --
  rm(join(pai, 'TOOLS', 'LiteLLM'))
  log('  ✓ TOOLS/LiteLLM/ stripped (local-only, carries live API keys)')

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

  // --- FreeTierEvals/threat_model_bench_results/ → strip (personal run history,
  // not a template — slot_label fields name GP's local machines) --
  rm(join(pai, 'TOOLS', 'FreeTierEvals', 'threat_model_bench_results'))
  log('  ✓ TOOLS/FreeTierEvals/threat_model_bench_results/ stripped (personal bench run history)')

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

  // --- public CLAUDE.md → promote to repo root -----------------
  // The private root CLAUDE.md is stripped (it carries identity, contacts, and business
  // context). Without a public replacement the DA boots with no modes, no format
  // templates, and no context routing — everything the README promises the harness does.
  // TEMPLATES/CLAUDE.md is the public doctrine file; it is written to be gate-clean.
  const claudeMdSrc = join(pai, 'TEMPLATES', 'CLAUDE.md')
  if (existsSync(claudeMdSrc)) {
    writeFileSync(join(STAGE_ROOT, 'CLAUDE.md'), readFileSync(claudeMdSrc, 'utf-8'), 'utf-8')
    log('  ✓ PAI/TEMPLATES/CLAUDE.md → CLAUDE.md (repo root)')
  } else {
    throw new Error(
      'PAI/TEMPLATES/CLAUDE.md not found — refusing to ship a release with no public ' +
      'CLAUDE.md. A release without it installs a DA with no operational doctrine.',
    )
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

  // --- PAI/backends/*.sh → promote to repo root -----------------
  // Backend-switch scripts (source, don't execute) for the resilience chain:
  // minimax.sh / glm.sh (cloud fallbacks) + offline.sh / offline-off.sh (local Ollama)
  const backendsSrc = join(pai, 'backends')
  if (existsSync(backendsSrc)) {
    let backendCount = 0
    for (const entry of readdirSync(backendsSrc)) {
      if (!entry.endsWith('.sh')) continue
      const dest = join(STAGE_ROOT, entry)
      writeFileSync(dest, readFileSync(join(backendsSrc, entry), 'utf-8'), 'utf-8')
      chmodSync(dest, 0o755)
      backendCount++
    }
    log(`  ✓ PAI/backends/*.sh → repo root (${backendCount} scripts, +x)`)
  } else {
    log('  ⚠ PAI/backends/ not found — no backend-switch scripts')
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
  'isa', 'loop', 'migrate', 'optimize', 'pai-upgrade', 'prompting', 'tmux-cli-driver',
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
    // fallback: line-based filter, for when srcPath itself doesn't parse as YAML.
    // A line-based filter operating on already-broken YAML has no guarantee its
    // output still parses (e.g. a stray unbalanced quote anywhere outside the
    // tabletop-exercise/asa/aurascape blocks survives the filter untouched).
    // Re-parse before returning it — ship the safe empty-skills doc instead of
    // an unvalidated guess if the fallback's own output doesn't parse either.
    if (existsSync(srcPath)) {
      const lines = readFileSync(srcPath, 'utf-8').split('\n')
      const out: string[] = []
      let skip = false
      for (const line of lines) {
        if (/^\s+-\s+name:\s+"?(tabletop-exercise|asa|aurascape)"?/.test(line)) { skip = true }
        else if (skip && /^\s+-\s+name:/.test(line)) { skip = false }
        if (!skip) out.push(line)
      }
      const fallbackOutput = out.join('\n')
      try {
        parseYaml(fallbackOutput)
        return fallbackOutput
      } catch (reparseErr) {
        log(`  ⚠ buildSkillRouting fallback output failed YAML re-validation: ${(reparseErr as Error).message.split('\n')[0]}`)
        log(`    Shipping empty-skills doc instead of unvalidated fallback output.`)
      }
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
  {
    rel: 'PAI/PULSE/PULSE.toml',
    replacements: [
      [/\/home\/realuser\//g, '${HOME}/'],
      [/\bubullm\b/gi, 'your-inference-host'],
    ],
  },
  {
    rel: 'PAI/TOOLS/NightlyCodeReview.ts',
    replacements: [
      [/\/home\/realuser\//g, '${HOME}/'],
      [/\bubullm\b/gi, 'your-inference-host'],
      [/192\.168\.1\.240/g, '127.0.0.1'],
    ],
  },
  {
    rel: 'PAI/TOOLS/FreeTierEvals/unified_bench.ts',
    replacements: [[/\bubullm\b/gi, 'your-inference-host']],
  },
  {
    rel: 'PAI/TOOLS/FreeTierEvals/threat_model_bench.ts',
    replacements: [
      [/\bubullm\b/gi, 'your-inference-host'],
      [/\bcsonprop\b/gi, 'your-other-host'],
      [/100\.126\.185\.104/g, '127.0.0.1'],
    ],
  },
  {
    rel: 'PAI/DOCUMENTATION/Decisions/threat-model-tier-0-routing.md',
    replacements: [[/\bubullm\b/gi, 'your-inference-host']],
  },
  {
    rel: 'PAI/DOCUMENTATION/Decisions/passage-secret-disclosure-guard.md',
    replacements: [
      [/\bubullm\b/gi, 'your-inference-host'],
      [/\bcsonprop\b/gi, 'your-other-host'],
      [/\bubupai\b/gi, 'your-third-host'],
      [/\brealuser\b/g, '<username>'],
      [/-home-realuser/g, '-home-<username>'],
    ],
  },
  {
    rel: 'PAI/TOOLS/BackendHealth.ts',
    replacements: [[/autogen\.esilabs\.com/g, 'your-ollama-host.example.com']],
  },
  {
    rel: 'PAI/DOCUMENTATION/Resilience/FaultTaxonomy.md',
    replacements: [[/autogen\.esilabs\.com/g, 'your-ollama-host.example.com']],
  },
  {
    rel: 'PAI/PROFILES/work/CLAUDE.md',
    replacements: [
      [/gps-cyber\.com/g, 'your-domain.example.com'],
      [/-home-realuser/g, '-home-<username>'],
    ],
  },
  {
    // sbom.json contains absolute file paths in evidence.files (cdxgen
    // resolves from the live tree). Scrub usernames and home-dir paths so
    // the identifier gate accepts the file.
    rel: 'sbom.json',
    replacements: [
      [/100\.126\.185\.104/g, '127.0.0.1'],
      [/100\.124\.228\.50/g, '127.0.0.1'],
      [/\/home\/realuser\//g, '/home/<username>/'],
      [/-home-realuser/g, '-home-<username>'],
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

// ── Private-zone gate (ISC-6) ─────────────────────────────────────────────────
//
// PRIVATE_SKILL_DIRS + the `_` prefix check in stage() are deny-by-name,
// applied once at copy time — a skill that should have been marked private
// but wasn't named `_Foo` or added to that set ships silently, because
// runIdentifierGate() only greps file CONTENT for personal-identifier
// patterns, never checks directory PROVENANCE. Proven live (2026-07-26): a
// planted skill with generic text and no identifier-pattern matches shipped
// completely undetected. This gate closes that gap in two layers:
//   1. Fail-safe allow-list check against staged skills/ (deterministic,
//      instant) — anything shipped but not on PUBLIC_SKILL_DIR_ALLOWLIST
//      blocks release outright.
//   2. For each unlisted directory, an LLM classification pass (Haiku, via
//      Inference.ts) judges it against CreateSkill's own public/private
//      decision rule (real name / real customer / real domain / real
//      business process / real internal infra → must be private). This is
//      advisory context for the human, not a second way to pass — the gate
//      already failed at step 1 and stays failed regardless of the verdict.
//      Per CLAUDE.md's fail-closed rule for inference calls in security
//      paths: a timeout or unparseable response is treated as "flag it,"
//      never as "assume it's fine."

interface UnlistedSkillVerdict {
  dir: string
  classification: 'likely-public' | 'likely-private' | 'inference-failed'
  reasoning: string
}

function classifyUnlistedSkill(dir: string, skillMdPath: string): UnlistedSkillVerdict {
  let content: string
  try {
    content = readFileSync(skillMdPath, 'utf-8').slice(0, 4000)
  } catch {
    return { dir, classification: 'inference-failed', reasoning: 'could not read SKILL.md' }
  }

  const systemPrompt =
    'You classify whether a Claude Code skill should be PUBLIC or PRIVATE per this rule: ' +
    'a skill MUST be private if it mentions a specific person\'s name, a specific product/customer/client, ' +
    'a paid API account or subscription, a private domain/hostname/internal IP, a private repo or local infra, ' +
    'a company-specific business process, or specific financial/health/security/legal context. ' +
    'Respond with EXACTLY one line: either "PUBLIC: <one sentence reason>" or "PRIVATE: <one sentence reason>". ' +
    'No other output.'
  const userPrompt = `Skill directory name: ${dir}\n\nSKILL.md content:\n${content}`

  const r = spawnSync(
    'bun',
    [join(PAI_SRC, 'TOOLS', 'Inference.ts'), '--level', 'fast', systemPrompt, userPrompt],
    { encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 }
  )

  if (r.status !== 0 || !r.stdout?.trim()) {
    return { dir, classification: 'inference-failed', reasoning: `Inference.ts exited ${r.status}, no usable output` }
  }

  const out = r.stdout.trim()
  const m = out.match(/^(PUBLIC|PRIVATE):\s*(.+)$/is)
  if (!m) {
    return { dir, classification: 'inference-failed', reasoning: `unparseable response: ${out.slice(0, 200)}` }
  }
  return {
    dir,
    classification: m[1].toUpperCase() === 'PUBLIC' ? 'likely-public' : 'likely-private',
    reasoning: m[2].trim(),
  }
}

function runPrivateZoneGate(): { pass: boolean; unlisted: UnlistedSkillVerdict[] } {
  log('\n🔒 Running private-zone gate (staged skill directories vs. allow-list)')
  const skillsDir = join(STAGE_ROOT, 'skills')
  if (!existsSync(skillsDir)) {
    log('  ✓ Private-zone gate: no staged skills/ — skipping')
    return { pass: true, unlisted: [] }
  }

  const staged = readdirSync(skillsDir).filter(e => statSync(join(skillsDir, e)).isDirectory())
  const unlistedDirs = staged.filter(e => !PUBLIC_SKILL_DIR_ALLOWLIST.has(e))

  if (unlistedDirs.length === 0) {
    log(`  ✓ Private-zone gate: clean — all ${staged.length} staged skills on allow-list`)
    return { pass: true, unlisted: [] }
  }

  fail(`Private-zone gate: ${unlistedDirs.length} staged skill(s) not on PUBLIC_SKILL_DIR_ALLOWLIST`)
  const verdicts: UnlistedSkillVerdict[] = []
  for (const dir of unlistedDirs) {
    const skillMd = join(skillsDir, dir, 'SKILL.md')
    const verdict = classifyUnlistedSkill(dir, skillMd)
    verdicts.push(verdict)
    const tag = verdict.classification === 'likely-private' ? '⚠ LIKELY PRIVATE'
      : verdict.classification === 'inference-failed' ? '⚠ COULD NOT CLASSIFY'
      : 'looks public'
    log(`    ${dir} — ${tag}: ${verdict.reasoning}`)
  }
  log('  → If these are legitimate new public skills, add them to PUBLIC_SKILL_DIR_ALLOWLIST and re-run.')
  log('  → If any are private, add them to PRIVATE_SKILL_DIRS (or rename with a `_` prefix) and re-run.')
  return { pass: false, unlisted: verdicts }
}

// ── Prose-tip gate (ISC-7) ────────────────────────────────────────────────────
//
// sanitizeSettingsJson()'s tips filtering has two allow-list-based checks
// (slash-command names, env vars) that are structurally sound — but any tip
// WITHOUT a leading slash-command falls through both filters unconditionally
// and is only checked against STRIP_TIP_PATTERNS, a hand-maintained exact-
// substring deny-list. A new prose tip added later that references specific
// business/infra context ships silently unless someone remembers to add its
// exact substring to that list. The identifier gate doesn't cover this either
// — it only matches its own IP/machine-name/company regex set, not generic
// prose. This gate batches all prose tips into a single classification call
// and blocks release on any flag. No allow-list escape hatch here (unlike the
// private-zone gate) — tips are meant to be fully generic content, so a
// flagged tip should be rewritten or removed, not exempted.
//
// MODEL CHOICE (verified live, 2026-07-26): Haiku and Sonnet both missed a
// known real leak (a port number: "...on pai:31337.") sitting among 19 other
// tips in the same 20-item chunk that name skills/tools the prompt explicitly
// says NOT to flag — dense true-negative context suppressed detection of the
// one true positive, on BOTH Claude-family models, at every batch size tried
// (3, 20, 144). MiniMax M3 via OpenRouter caught it correctly on the first
// full 144-tip single-call attempt with the identical prompt, zero false
// positives. This is the one place in this file that calls a non-Claude
// model — a deliberate, evidence-based choice, not a default.

interface FlaggedTip {
  tip: string
  reasoning: string
}

// Resolves via passage (PAI standard secret store), mirroring Inference.ts's
// resolveAnthropicApiKey() pattern exactly: env var first, then spawn `passage
// show <key>` with piped stdout (never via shell command-substitution string —
// a prior Cato/Anvil audit flagged `$(passage show ...)` for briefly exposing
// the key in /proc and `ps aux` process listings during the substitution).
async function readOpenRouterApiKey(): Promise<string | null> {
  const envKey = process.env.OPENROUTER_API_KEY
  if (envKey && envKey.trim()) return envKey.trim()
  try {
    const proc = Bun.spawn(['passage', 'show', 'api/openrouter'], { stdout: 'pipe', stderr: 'pipe' })
    const key = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    return key || null
  } catch {
    return null
  }
}

// Ensemble size for classifyProseTips. Live-tested 2026-07-26: single-call
// M3 classification against the real 144-tip corpus has a genuine, roughly
// 20-30% miss rate on the one true leak in this corpus — NOT truncation,
// a well-formed "[]" response that's simply wrong. This is a probabilistic
// model-reliability issue, not fixable by prompt tuning or smaller batches
// (halving the batch to ~70 tips reduced neither the truncation nor the
// miss rate in a 2nd larger sample, despite looking clean in a first,
// smaller sample — see ISA Changelog). A "first successfully-parsed
// response wins" retry loop (the prior version of this function) cannot
// defend against this: a genuine miss parses just fine as `[]`, so it looks
// identical to "nothing to flag" and the retry loop would accept it
// immediately. The only defense that showed 5/5 reliability in live testing
// is running N independent full-batch attempts and OR-combining every
// successfully-parsed result — a flag from ANY attempt is authoritative,
// since a false negative on one run doesn't imply a false negative on all.
const ENSEMBLE_SIZE = 5
const MIN_SUCCESSFUL_PARSES = 3 // fail closed if fewer than this many attempts even parse

async function classifyProseTipsOnce(
  tips: string[], systemPrompt: string, userPrompt: string, apiKey: string
): Promise<{ parsed: true; flagged: FlaggedTip[] } | { parsed: false; error: string }> {
  let resp: Response
  try {
    resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'minimax/minimax-m3',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      }),
      signal: AbortSignal.timeout(45_000),
    })
  } catch (e) {
    return { parsed: false, error: `OpenRouter request failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!resp.ok) {
    return { parsed: false, error: `OpenRouter returned HTTP ${resp.status}` }
  }
  try {
    const body: any = await resp.json()
    const content: string = body?.choices?.[0]?.message?.content ?? ''
    const jsonMatch = content.match(/\[[\s\S]*\]/)
    const candidate = jsonMatch ? jsonMatch[0] : content
    const parsed = JSON.parse(candidate)
    if (!Array.isArray(parsed)) throw new Error('not an array')
    const flagged: FlaggedTip[] = parsed
      .filter((p: any) => typeof p.line === 'number' && p.line >= 1 && p.line <= tips.length)
      .map((p: any) => ({ tip: tips[p.line - 1], reasoning: p.reason ?? '(no reason given)' }))
    return { parsed: true, flagged }
  } catch (e) {
    return { parsed: false, error: `unparseable: ${e instanceof Error ? e.message : String(e)} — raw content missing/truncated` }
  }
}

async function classifyProseTips(tips: string[]): Promise<{ flagged: FlaggedTip[]; failed: boolean }> {
  if (tips.length === 0) return { flagged: [], failed: false }

  const apiKey = await readOpenRouterApiKey()
  if (!apiKey) {
    return { flagged: [{ tip: '(all tips)', reasoning: 'OPENROUTER_API_KEY not set (env or ~/.claude/.env) — fail-closed' }], failed: true }
  }

  const systemPrompt =
    'Review each numbered tip line. A tip is FLAGGED if it contains any of: a network port number, ' +
    'a private IP address or hostname, a credential or token value, a specific person\'s name, a specific ' +
    'customer or company name (other than well-known AI vendors). ' +
    'A tip is NOT flagged just for naming a skill, tool, or feature of this open-source project, or the ' +
    'project itself by name (e.g. Council, RedTeam, hooks, MEMORY, Algorithm, "secunit" — secunit IS this ' +
    'project\'s own public name, not a customer) — those are intentionally public. ' +
    'Output a JSON array like [{"line":1,"reason":"..."}] listing ONLY flagged lines. ' +
    'Output exactly [] if nothing is flagged. Output nothing else.'
  const userPrompt = tips.map((t, i) => `${i + 1}. ${t}`).join('\n')

  // Sequential, not Promise.all — live-tested 2026-07-26: firing all 5 ensemble
  // calls concurrently measurably raised the truncation rate (multiple
  // simultaneous truncations/malformed-JSON responses, occasionally enough to
  // trip MIN_SUCCESSFUL_PARSES and fail-closed on transient API flakiness
  // rather than real risk). 8/8 sequential calls in the same test came back
  // clean with zero truncation. Slower (~5x latency) but reliable — the right
  // tradeoff for a release gate that runs once per release, not per request.
  const results: Array<{ parsed: true; flagged: FlaggedTip[] } | { parsed: false; error: string }> = []
  for (let i = 0; i < ENSEMBLE_SIZE; i++) {
    results.push(await classifyProseTipsOnce(tips, systemPrompt, userPrompt, apiKey))
  }

  const successfulParses = results.filter((r): r is { parsed: true; flagged: FlaggedTip[] } => r.parsed)
  const errors = results.filter((r): r is { parsed: false; error: string } => !r.parsed).map(r => r.error)

  if (successfulParses.length < MIN_SUCCESSFUL_PARSES) {
    return {
      flagged: [{
        tip: '(all tips)',
        reasoning: `only ${successfulParses.length}/${ENSEMBLE_SIZE} ensemble calls parsed successfully (need ${MIN_SUCCESSFUL_PARSES}) — fail-closed. Errors: ${errors.slice(0, 3).join(' | ')}`,
      }],
      failed: true,
    }
  }

  // OR-combine: a flag on ANY successful attempt is authoritative. Dedupe by tip text
  // since the same real leak will typically get flagged by multiple attempts.
  const seen = new Map<string, FlaggedTip>()
  for (const r of successfulParses) {
    for (const f of r.flagged) {
      if (!seen.has(f.tip)) seen.set(f.tip, f)
    }
  }
  return { flagged: [...seen.values()], failed: false }
}

async function runProseTipGate(): Promise<{ pass: boolean; flagged: FlaggedTip[] }> {
  log('\n📝 Running prose-tip gate (settings.json spinnerTipsOverride.tips)')
  const settingsPath = join(STAGE_ROOT, 'PAI', 'settings.json')
  if (!existsSync(settingsPath)) {
    log('  ✓ Prose-tip gate: no staged settings.json — skipping')
    return { pass: true, flagged: [] }
  }

  let tips: string[]
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    tips = raw.spinnerTipsOverride?.tips ?? []
  } catch {
    fail('Prose-tip gate: could not parse staged settings.json — fail-closed')
    return { pass: false, flagged: [{ tip: '(all tips)', reasoning: 'staged settings.json unparseable' }] }
  }

  const prose = tips.filter((t: string) => !/^\/[\w-]+/.test(t))
  const { flagged, failed } = await classifyProseTips(prose)

  if (failed) {
    fail(`Prose-tip gate: classifier call failed — ${flagged[0]?.reasoning}`)
    return { pass: false, flagged }
  }
  if (flagged.length === 0) {
    log(`  ✓ Prose-tip gate: clean — ${prose.length} prose tips reviewed, none flagged`)
    return { pass: true, flagged: [] }
  }

  fail(`Prose-tip gate: ${flagged.length} tip(s) flagged out of ${prose.length} prose tips`)
  for (const f of flagged) {
    log(`    "${f.tip.slice(0, 80)}${f.tip.length > 80 ? '...' : ''}" — ${f.reasoning}`)
  }
  log('  → Rewrite or remove flagged tips in the source spinnerTipsOverride.tips array and re-run.')
  return { pass: false, flagged }
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
  your-model-name:
    tier: "standard"
    preferred_host: "host1"
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
  // CRITICAL: Run cdxgen against the LIVE PAI/TOOLS tree (which has node_modules),
  // NOT the staged tree. The strip step removes node_modules to keep the release
  // small — without it, cdxgen's npm resolver finds the declared package.json
  // dependencies but cannot enumerate the installed graph, producing an SBOM
  // with zero components (CVE database coverage effectively empty for the
  // dependencies the release actually ships). Generating pre-strip and copying
  // the file into the staged tree decouples SBOM accuracy from release size.
  const toolsLive = join(PAI_SRC, 'TOOLS')
  const outFile = join(STAGE_ROOT, 'sbom.json')
  const r = spawnSync(
    'bunx',
    ['--bun', '@cyclonedx/cdxgen', '-p', toolsLive, '-o', outFile,
     '--type', 'npm', '--spec-version', '1.5'],
    { encoding: 'utf-8', stdio: 'pipe' }
  )
  // cdxgen 12.7.0 can crash in its post-generation summary-table printer
  // (TypeError on c.evidence?.identity?.some) after the SBOM file is already
  // written correctly. Non-zero exit doesn't mean the file is bad — verify
  // the file itself rather than trusting the process exit code.
  if (!existsSync(outFile)) {
    log('  [FAIL] SBOM file not written by cdxgen — release blocked, vuln scan cannot run')
    if (VERBOSE && r.stderr?.trim()) log(`  [v] ${r.stderr.trim()}`)
    return false
  }
  let sbom: any
  try {
    sbom = JSON.parse(readFileSync(outFile, 'utf-8'))
  } catch {
    log('  [FAIL] SBOM file is not valid JSON — release blocked, vuln scan cannot run')
    rm(outFile)
    return false
  }
  if (!Array.isArray(sbom.components) || sbom.components.length === 0) {
    log('  [FAIL] SBOM has zero components — release blocked, vuln scan cannot run')
    rm(outFile)
    return false
  }
  if (sbom.metadata?.component) {
    sbom.metadata.component.name = 'secunit'
    sbom.metadata.component.version = version
  }
  writeFileSync(outFile, JSON.stringify(sbom, null, 2), 'utf-8')
  if (r.status !== 0) {
    log(`  ✓ SBOM: sbom.json (CycloneDX 1.5, ${sbom.components.length} components) — cdxgen exited ${r.status} on summary-table printing, file verified valid`)
  } else {
    log(`  ✓ SBOM: sbom.json (CycloneDX 1.5, ${sbom.components.length} components)`)
  }
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

  // SBOM must run BEFORE strip — strip removes PAI/TOOLS/node_modules, which
  // cdxgen needs to enumerate the installed dependency graph. Running it here
  // (against the staged tree, before strip) means the SBOM reflects the real
  // npm install state, not the declared-but-uninstalled package.json.
  const sbomOk = generateSBOM(version)
  if (!sbomOk) {
    fail('\nRelease gate FAILED — SBOM generation did not produce a valid sbom.json')
    fail('  Grype vuln scan cannot run without an SBOM. Blocked from pushing.')
    log(`\nStaged output preserved for inspection: ${STAGE_ROOT}`)
    process.exit(1)
  }

  strip()
  sanitize()

  const adrOk = runAdrStubGate()
  const secretOk = runSecretScan()
  const { pass: identOk, hits } = runIdentifierGate()
  const { pass: privZoneOk, unlisted } = runPrivateZoneGate()
  const { pass: proseTipOk, flagged } = await runProseTipGate()

  if (!adrOk || !secretOk || !identOk || !privZoneOk || !proseTipOk) {
    fail(`\nRelease gate FAILED`)
    fail(`  ADR stub gate: ${adrOk ? 'pass' : 'FAIL'}`)
    fail(`  SecretScan: ${secretOk ? 'pass' : 'FAIL'}`)
    fail(`  Identifier gate: ${identOk ? 'pass' : `FAIL (${hits.length} hits)`}`)
    fail(`  Private-zone gate: ${privZoneOk ? 'pass' : `FAIL (${unlisted.length} unlisted)`}`)
    fail(`  Prose-tip gate: ${proseTipOk ? 'pass' : `FAIL (${flagged.length} flagged)`}`)
    log(`\nStaged output preserved for inspection: ${STAGE_ROOT}`)
    process.exit(1)
  }

  log(`\n✅ All gates passed`)
  log(`   Staged output: ${STAGE_ROOT}`)

  const grypeOk = runGrype()
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
    log(`   ${FORGEJO_REMOTE}`)
  }
}

main().catch(e => { fail(String(e)); process.exit(1) })
