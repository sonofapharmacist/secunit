#!/usr/bin/env bun
/**
 * RoutingDriftCheck.ts — verifies that the models actually SERVED by the local
 * inference hosts agree with every config surface that names a model.
 *
 * The 2026-08-08 prod migration to qwen3_next_80b_a3b updated PAI_CONFIG.yaml and
 * Inference.ts's DEFAULT_FALLBACK_MODELS but never added the model to
 * inference-routing.yaml. Result: getTierForModel() fell back to a guessed tier on
 * every prod call for five weeks, announced only via a stderr line nobody reads.
 * This tool exists so that class of drift fails loudly instead.
 *
 * Checks:
 *   1. Every model served by a host is declared in inference-routing.yaml.
 *   2. Every model named in PAI_CONFIG.yaml (default/general/coding_offload/
 *      fallback_models) is declared in inference-routing.yaml.
 *   3. Every model named in Inference.ts DEFAULT_FALLBACK_MODELS is declared.
 *   4. Declared models carry total_params_b / active_params_b (warn only — the
 *      bench table degrades gracefully without them).
 *   5. Duplicate model keys in inference-routing.yaml (last-wins silently).
 *
 * Usage: bun PAI/TOOLS/RoutingDriftCheck.ts [options]
 *   --hosts <h1,h2>   host:port list to probe (default: your-inference-host :11434 + :11436)
 *   --no-probe        skip live host probing; check config surfaces only
 *   --json            machine-readable output
 *   --quiet           suppress OK lines; print only problems
 *
 * Exit codes: 0 = clean, 1 = drift found, 2 = could not run (missing file etc).
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const PAI = join(homedir(), '.claude/PAI')
const ROUTING_YAML = join(PAI, 'USER/Config/inference-routing.yaml')
const PAI_CONFIG = join(PAI, 'USER/Config/PAI_CONFIG.yaml')
const INFERENCE_TS = join(PAI, 'TOOLS/Inference.ts')

// Prod (:11434) + fast tier (:11436) on the host named by PAI_CONFIG.yaml ollama.base_url, the same
// source Inference.ts routes through. No IP literal here: it tracks host moves and ships clean.
function defaultHosts(): string[] {
  try {
    const cfg = Bun.YAML.parse(readFileSync(join(PAI, 'USER/Config/PAI_CONFIG.yaml'), 'utf-8')) as any
    const host = new URL(String(cfg?.ollama?.base_url)).hostname
    return [`${host}:11434`, `${host}:11436`]
  } catch {
    return ['127.0.0.1:11434', '127.0.0.1:11436']
  }
}
const DEFAULT_HOSTS = defaultHosts()

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag)
  if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  const eq = process.argv.find(a => a.startsWith(flag + '='))
  return eq ? eq.slice(flag.length + 1) : def
}

const noProbe = process.argv.includes('--no-probe')
const asJson = process.argv.includes('--json')
const quiet = process.argv.includes('--quiet')
const hosts = arg('--hosts', DEFAULT_HOSTS.join(',')).split(',').filter(Boolean)

type Problem = { severity: 'error' | 'warn'; check: string; model?: string; detail: string }
const problems: Problem[] = []
const notes: string[] = []

// ---------------------------------------------------------------- routing yaml

/** Model keys declared under `models:`, plus which ones declare param counts. */
function parseRoutingYaml(): {
  declared: Set<string>
  duplicates: string[]
  missingParams: string[]
} {
  if (!existsSync(ROUTING_YAML)) {
    console.error(`FATAL: ${ROUTING_YAML} not found`)
    process.exit(2)
  }
  const lines = readFileSync(ROUTING_YAML, 'utf-8').split('\n')
  const seen: string[] = []
  const declared = new Set<string>()
  const missingParams: string[] = []

  let inModels = false
  let current = ''
  let hasTier = false
  let hasParams = false

  const closeCurrent = () => {
    // A block without `tier:` is a comment/prose block, not a model entry —
    // this mirrors loadBaselines()/loadRoutingManifest(), which both require tier.
    if (!current || !hasTier) return
    seen.push(current)
    declared.add(current)
    if (!hasParams) missingParams.push(current)
  }

  for (const line of lines) {
    if (line === 'models:') { inModels = true; continue }
    if (!inModels) continue
    if (/^  \S/.test(line) && line.trimEnd().endsWith(':')) {
      closeCurrent()
      current = line.trim().slice(0, -1)
      hasTier = false
      hasParams = false
      continue
    }
    if (current && /^    \S/.test(line)) {
      if (/^    tier:/.test(line)) hasTier = true
      if (/^    (total|active)_params_b:/.test(line)) hasParams = true
    }
  }
  closeCurrent()

  const counts = new Map<string, number>()
  for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1)
  const duplicates = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k)

  return { declared, duplicates, missingParams }
}

// ---------------------------------------------------------------- PAI_CONFIG

/**
 * Pull model names out of the ollama block. Deliberately regex-based rather than a
 * YAML parse: this must not gain a dependency, and the keys of interest are flat
 * scalars. Comment lines are stripped so documented-but-inactive names don't count.
 */
function parsePaiConfigModels(): Map<string, string> {
  const found = new Map<string, string>()
  if (!existsSync(PAI_CONFIG)) {
    notes.push(`PAI_CONFIG.yaml not found at ${PAI_CONFIG} — skipped that check`)
    return found
  }
  const text = readFileSync(PAI_CONFIG, 'utf-8')
  const ollama = text.match(/^ollama:\n([\s\S]*?)(?=^\S)/m)?.[1] ?? ''
  const scalarKeys = ['default_model', 'general_model', 'coding_offload_model']
  for (const line of ollama.split('\n')) {
    const bare = line.split('#')[0]
    for (const key of scalarKeys) {
      const m = bare.match(new RegExp(`^\\s+${key}:\\s*["']?([^"'\\s]+)`))
      if (m) found.set(m[1], `PAI_CONFIG.ollama.${key}`)
    }
    const fb = bare.match(/^\s+(fast|standard|smart|fable):\s*["']?([^"'\s]+)/)
    if (fb && /fallback_models/.test(ollama.slice(0, ollama.indexOf(line)).split('\n').slice(-12).join('\n'))) {
      found.set(fb[2], `PAI_CONFIG.ollama.fallback_models.${fb[1]}`)
    }
  }
  return found
}

// ---------------------------------------------------------------- Inference.ts

function parseInferenceDefaults(): Map<string, string> {
  const found = new Map<string, string>()
  if (!existsSync(INFERENCE_TS)) {
    notes.push(`Inference.ts not found at ${INFERENCE_TS} — skipped that check`)
    return found
  }
  const text = readFileSync(INFERENCE_TS, 'utf-8')
  const block = text.match(/DEFAULT_FALLBACK_MODELS[^=]*=\s*\{([\s\S]*?)\}/)?.[1] ?? ''
  for (const line of block.split('\n')) {
    const m = line.split('//')[0].match(/^\s*(fast|standard|smart|fable):\s*['"]([^'"]+)['"]/)
    if (m) found.set(m[2], `Inference.ts DEFAULT_FALLBACK_MODELS.${m[1]}`)
  }
  return found
}

// ---------------------------------------------------------------- host probe

async function probeHost(hostPort: string): Promise<string[] | null> {
  const base = hostPort.startsWith('http') ? hostPort : `http://${hostPort}`
  const headers: Record<string, string> = process.env.PAI_INFERENCE_TOKEN
    ? { Authorization: `Bearer ${process.env.PAI_INFERENCE_TOKEN}` }
    : {}
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    const res = await fetch(`${base}/v1/models`, { signal: controller.signal, headers })
    clearTimeout(timer)
    if (!res.ok) { notes.push(`${hostPort}: HTTP ${res.status} — skipped`); return null }
    const payload = await res.json() as { data?: Array<{ id?: string }> }
    return (payload.data ?? []).map(m => m.id?.trim() ?? '').filter(Boolean)
  } catch (err) {
    // Unreachable host is NOT drift — it may simply be powered down. Note it and
    // move on; the config-surface checks below still run and still catch the
    // failure mode this tool was built for.
    notes.push(`${hostPort}: unreachable (${err instanceof Error ? err.name : 'error'}) — skipped`)
    return null
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const { declared, duplicates, missingParams } = parseRoutingYaml()

  if (!noProbe) {
    const up = new Set<string>(), down: string[] = []
    const hostOf = (hp: string) => { try { return new URL(hp.startsWith('http') ? hp : `http://${hp}`).hostname } catch { return hp } }
    for (const h of hosts) {
      const served = await probeHost(h)
      if (!served) { down.push(h); continue }
      up.add(hostOf(h))
      for (const model of served) {
        if (!declared.has(model)) {
          problems.push({
            severity: 'error',
            check: 'served-not-declared',
            model,
            detail: `served by ${h} but has no entry in inference-routing.yaml — getTierForModel() will guess a tier`,
          })
        }
      }
    }
    // A refused port on a host whose other port answered is a STOPPED SERVICE, not a powered-down
    // machine: whatever routes there silently falls back to cloud. 2026-09-24: llama-server-fast
    // (:11436, the fast tier) was stopped by a bench session and nothing noticed for two days.
    for (const h of down) {
      if (up.has(hostOf(h))) {
        problems.push({
          severity: 'error',
          check: 'service-down',
          model: h,
          detail: `${h} is unreachable while ${hostOf(h)} answers on another port — a stopped inference service; models routed here fall back to cloud. Check its systemd unit.`,
        })
      }
    }
  }

  for (const [model, where] of [...parsePaiConfigModels(), ...parseInferenceDefaults()]) {
    if (!declared.has(model)) {
      problems.push({
        severity: 'error',
        check: 'referenced-not-declared',
        model,
        detail: `named by ${where} but has no entry in inference-routing.yaml`,
      })
    }
  }

  for (const model of duplicates) {
    problems.push({
      severity: 'error',
      check: 'duplicate-key',
      model,
      detail: 'declared more than once in inference-routing.yaml — later block silently wins, earlier is dead config',
    })
  }

  for (const model of missingParams) {
    problems.push({
      severity: 'warn',
      check: 'missing-params',
      model,
      detail: 'no total_params_b/active_params_b — PARAMS and TOK/S/AB columns will show "—"',
    })
  }

  const errors = problems.filter(p => p.severity === 'error')
  const warns = problems.filter(p => p.severity === 'warn')

  if (asJson) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      declaredCount: declared.size,
      errors, warnings: warns, notes,
      ok: errors.length === 0,
    }, null, 2))
    process.exit(errors.length === 0 ? 0 : 1)
  }

  console.log(`\nRoutingDriftCheck — ${declared.size} models declared in inference-routing.yaml`)
  if (noProbe) console.log('(--no-probe: config surfaces only, hosts not contacted)')

  for (const n of notes) console.log(`  ℹ  ${n}`)

  if (errors.length > 0) {
    console.log(`\n✗ ${errors.length} DRIFT ERROR(S):\n`)
    for (const p of errors) console.log(`  [${p.check}] ${p.model}\n      ${p.detail}`)
  }
  if (warns.length > 0 && !quiet) {
    console.log(`\n⚠  ${warns.length} warning(s):\n`)
    for (const p of warns) console.log(`  [${p.check}] ${p.model} — ${p.detail}`)
  }
  if (errors.length === 0) {
    console.log(`\n✓ No drift. Every served and referenced model is declared.`)
    if (warns.length > 0 && quiet) console.log(`  (${warns.length} param-declaration warning(s) suppressed by --quiet)`)
  } else {
    if (errors.some(p => p.check !== 'service-down')) console.log(`\nFix: add the missing entries to ${ROUTING_YAML}`)
    console.log(`See DOCUMENTATION/Tools/ProdModelChangeProcedure.md for the full checklist.`)
  }

  process.exit(errors.length === 0 ? 0 : 1)
}

main().catch(err => { console.error('FATAL:', err); process.exit(2) })
