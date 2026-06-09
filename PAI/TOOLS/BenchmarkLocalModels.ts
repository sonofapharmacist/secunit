#!/usr/bin/env bun
/**
 * BenchmarkLocalModels.ts — warm p50 latency benchmark for local models served by llama-server
 * Compares observed latency against inference-routing.yaml baselines.
 *
 * Usage: bun PAI/TOOLS/BenchmarkLocalModels.ts [options]
 *   --host <addr>        llama-server host:port (default: localhost:11434)
 *   --gpu-name <name>    GPU display name for results file (e.g. "RTX 3060")
 *   --vram-gb <n>        GPU VRAM in GB for results file (e.g. 12)
 *   --runs <n>           Timed runs per model after 1 warmup (default: 3)
 *   --models <m1,m2>     Comma-separated model filter (default: all in routing config)
 *   --timeout-ms <n>     Per-request timeout (default: 90000)
 *   --include-cloud      Include :cloud models (network latency, not local inference)
 *   --save <file>        Write JSON results to file for use with SubmitLocalMaxxing.ts
 */

// Benchmarks bypass Inference.ts intentionally — we need raw model latency, not
// routing-layer overhead.

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const LOCAL_AUTH_HEADERS: Record<string, string> = process.env.PAI_INFERENCE_TOKEN
  ? { Authorization: `Bearer ${process.env.PAI_INFERENCE_TOKEN}` }
  : {}

// llama-server speaks the OpenAI-compatible API. If the /v1/models probe fails
// the server is down or misconfigured — callers should see an error from the
// subsequent request rather than a silent Ollama-mode fallback.
async function detectServerType(baseUrl: string, timeoutMs = 3000): Promise<'openai'> {
  try {
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), timeoutMs)
    const response = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal, headers: LOCAL_AUTH_HEADERS })
    clearTimeout(id)
    if (response.ok) return 'openai'
  } catch {}
  return 'openai'
}

const BENCH_PROMPT_BASE = 'List three key differences between symmetric and asymmetric encryption. Be concise.'
const ROUTING_YAML = join(homedir(), '.claude/PAI/USER/Config/inference-routing.yaml')

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag)
  if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  const eq = process.argv.find(a => a.startsWith(flag + '='))
  return eq ? eq.slice(flag.length + 1) : def
}

type Baseline = { tier: string; warm_p50_ms: number }

function loadBaselines(): Map<string, Baseline> {
  const text = readFileSync(ROUTING_YAML, 'utf-8')
  const map = new Map<string, Baseline>()
  let inModels = false
  let currentModel = ''
  let tier = ''
  let warm_p50_ms = 0

  for (const line of text.split('\n')) {
    if (line === 'models:') { inModels = true; continue }
    if (!inModels) continue
    if (/^  \S/.test(line) && line.trimEnd().endsWith(':')) {
      if (currentModel && tier) map.set(currentModel, { tier, warm_p50_ms })
      currentModel = line.trim().slice(0, -1)
      tier = ''; warm_p50_ms = 0
      continue
    }
    if (currentModel && /^    \S/.test(line)) {
      const m = line.match(/^\s+([\w_]+):\s+(.+)/)
      if (!m) continue
      if (m[1] === 'tier') tier = m[2].trim()
      if (m[1] === 'warm_p50_ms') warm_p50_ms = parseInt(m[2])
    }
  }
  if (currentModel && tier) map.set(currentModel, { tier, warm_p50_ms })
  return map
}

type OpenAIModelsResponse = {
  data?: Array<{ id?: string }>
}

type OpenAIChatCompletionsResponse = {
  choices?: Array<{ message?: { content?: string } }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

type GenerateResponse = {
  serverType: 'openai'
  wallClockMs: number
  promptTokens: number
  completionTokens: number
  content: string
}

async function generate(
  baseUrl: string,
  serverType: 'openai',
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<GenerateResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const startedAt = Date.now()
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...LOCAL_AUTH_HEADERS },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 128,
        stream: false,
      }),
      signal: controller.signal,
    })
    const wallClockMs = Date.now() - startedAt
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    const payload = await res.json() as OpenAIChatCompletionsResponse
    return {
      serverType,
      wallClockMs,
      promptTokens: payload.usage?.prompt_tokens ?? 0,
      completionTokens: payload.usage?.completion_tokens ?? 0,
      content: payload.choices?.[0]?.message?.content ?? '',
    }
  } finally {
    clearTimeout(timer)
  }
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  return s.length % 2 === 0 ? (s[s.length / 2 - 1] + s[s.length / 2]) / 2 : s[Math.floor(s.length / 2)]
}

function pad(s: string, n: number, right = false): string {
  const str = s.length >= n ? s.slice(0, n - 1) + '…' : s
  return right ? str.padStart(n) : str.padEnd(n)
}

function driftLabel(baseline: number, observed: number): string {
  if (baseline === 0) return '—'
  const pct = Math.round(((observed - baseline) / baseline) * 100)
  const sign = pct > 0 ? '+' : ''
  const flag = Math.abs(pct) > 20 ? (pct > 0 ? ' ⚠' : ' ↓') : ''
  return `${sign}${pct}%${flag}`
}

async function main() {
  const rawHost = arg('--host', 'localhost:11434')
  const host = rawHost.startsWith('http') ? rawHost : `http://${rawHost}`
  const gpuName = arg('--gpu-name', '')
  const vramGb = parseInt(arg('--vram-gb', '0')) || null
  const runs = parseInt(arg('--runs', '3'))
  const modelFilter = arg('--models', '').split(',').filter(Boolean)
  const timeoutMs = parseInt(arg('--timeout-ms', '90000'))
  const includeCloud = process.argv.includes('--include-cloud')
  const noThink = process.argv.includes('--no-think')
  const saveFile = arg('--save', '')
  const serverType = await detectServerType(host)
  const BENCH_PROMPT = noThink ? `/no_think ${BENCH_PROMPT_BASE}` : BENCH_PROMPT_BASE

  console.log(`\nBenchmarkLocalModels [${serverType}] — ${host} | ${runs} runs + 1 warmup | timeout ${timeoutMs / 1000}s${noThink ? ' | no-think' : ''}`)
  console.log(`Prompt: "${BENCH_PROMPT.slice(0, 70)}"\n`)

  const baselines = loadBaselines()

  const modelsRes = await fetch(`${host}/v1/models`, { headers: LOCAL_AUTH_HEADERS })
  if (!modelsRes.ok) { console.error(`Cannot reach server at ${host}`); process.exit(1) }
  const payload = await modelsRes.json() as OpenAIModelsResponse
  const available: string[] = (payload.data ?? []).map(model => model.id?.trim() ?? '').filter(Boolean)

  const toTest = available.filter(m => {
    if (!baselines.has(m)) return false
    if (!includeCloud && m.includes(':cloud')) return false
    if (modelFilter.length > 0) return modelFilter.includes(m)
    return true
  })

  if (toTest.length === 0) {
    console.error('No matching models. Available:', available.join(', '))
    process.exit(1)
  }

  console.log(`Testing ${toTest.length} model(s):\n`)

  const results: Array<{ model: string; tier: string; baseline: number; p50: number; tokPerSec: number; error?: string }> = []

  for (const model of toTest) {
    const { tier, warm_p50_ms } = baselines.get(model)!
    process.stdout.write(`  ${model.padEnd(38)} warmup`)

    try {
      await generate(host, serverType, model, BENCH_PROMPT, timeoutMs)
      process.stdout.write(' → timing')

      const latencies: number[] = []
      const tokRates: number[] = []

      for (let i = 0; i < runs; i++) {
        const r = await generate(host, serverType, model, BENCH_PROMPT, timeoutMs)
        latencies.push(r.wallClockMs)
        if (r.completionTokens > 0 && r.wallClockMs > 0) tokRates.push(r.completionTokens / (r.wallClockMs / 1000))
        process.stdout.write('.')
      }

      const p50 = Math.round(median(latencies))
      const tokPerSec = tokRates.length > 0 ? Math.round(median(tokRates)) : 0
      process.stdout.write(' done\n')
      results.push({ model, tier, baseline: warm_p50_ms, p50, tokPerSec })
    } catch (err) {
      const msg = err instanceof Error && err.name === 'AbortError' ? 'TIMEOUT' : String(err)
      process.stdout.write(` ${msg}\n`)
      results.push({ model, tier, baseline: warm_p50_ms, p50: 0, tokPerSec: 0, error: msg })
    }
  }

  const W = { model: 36, tier: 10, ms: 10, drift: 10, toks: 8 }
  const line = '─'.repeat(W.model + W.tier + W.ms + W.ms + W.drift + W.toks)
  console.log('\n' + line)
  console.log(pad('MODEL', W.model) + pad('TIER', W.tier) + pad('BASELINE', W.ms, true) + pad('OBSERVED', W.ms, true) + pad('DRIFT', W.drift, true) + 'TOK/S')
  console.log(line)

  const updates: string[] = []
  for (const r of results.sort((a, b) => a.tier.localeCompare(b.tier) || a.model.localeCompare(b.model))) {
    if (r.error) {
      console.log(pad(r.model, W.model) + pad(r.tier, W.tier) + pad(`${r.baseline}ms`, W.ms, true) + pad(r.error, W.ms + W.drift + W.toks))
      continue
    }
    const drift = driftLabel(r.baseline, r.p50)
    console.log(pad(r.model, W.model) + pad(r.tier, W.tier) + pad(`${r.baseline}ms`, W.ms, true) + pad(`${r.p50}ms`, W.ms, true) + pad(drift, W.drift, true) + `${r.tokPerSec}`)
    if (r.baseline > 0 && Math.abs(r.p50 - r.baseline) / r.baseline > 0.2) {
      updates.push(`  ${r.model}:\n    warm_p50_ms: ${r.p50}  # was ${r.baseline}`)
    }
  }
  console.log(line)

  if (updates.length > 0) {
    console.log(`\n⚠  Suggested inference-routing.yaml updates (>20% drift from baseline):\n`)
    console.log(updates.join('\n'))
  } else {
    console.log('\n✓  All baselines within 20% drift threshold.')
  }

  if (saveFile) {
    const output = {
      timestamp: new Date().toISOString(),
      host,
      gpu: { name: gpuName || 'unknown', vramGb: vramGb ?? 0 },
      results: results.map(r => ({
        model: r.model,
        tier: r.tier,
        p50Ms: r.error ? null : r.p50,
        tokPerSec: r.error ? null : r.tokPerSec,
        error: r.error ?? null,
      })),
    }
    writeFileSync(saveFile, JSON.stringify(output, null, 2))
    console.log(`\n💾 Results saved to ${saveFile}`)
  } else if (!gpuName) {
    console.log('\n💡 Tip: pass --gpu-name and --save <file> to record results for SubmitLocalMaxxing.ts')
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
