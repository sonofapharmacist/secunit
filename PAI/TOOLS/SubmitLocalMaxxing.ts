#!/usr/bin/env bun
/**
 * SubmitLocalMaxxing.ts — submit local Ollama benchmark results to localmaxxing.com
 * Reads from a --results JSON file (output of BenchmarkLocalModels.ts --save),
 * or falls back to inference-routing.yaml with explicit --gpu-name / --vram-gb.
 *
 * Usage:
 *   bun PAI/TOOLS/SubmitLocalMaxxing.ts --results /tmp/your-inference-host-rtx3060.json [options]
 *   bun PAI/TOOLS/SubmitLocalMaxxing.ts --gpu-name "RTX 3060" --vram-gb 12 [options]
 *
 *   --results <file>     JSON file from BenchmarkLocalModels.ts --save (preferred)
 *   --gpu-name <name>    GPU display name (required if no --results)
 *   --vram-gb <n>        Total VRAM in GB (required if no --results)
 *   --models <m1,m2>     Comma-separated model filter (default: all mapped models)
 *   --engine <name>      Engine name for submission (default: llama.cpp; use ollama for Ollama results)
 *   --dry-run            Print payloads without submitting
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const ROUTING_YAML = join(homedir(), '.claude/PAI/USER/Config/inference-routing.yaml')
const API_URL = 'https://localmaxxing.com/api/benchmarks'
const RATE_LIMIT_MS = 65_000

type BenchmarkResult = {
  model: string
  tier: string
  p50Ms: number | null
  tokPerSec: number | null
  error: string | null
}

type ResultsFile = {
  timestamp: string
  host: string
  gpu: { name: string; vramGb: number }
  results: BenchmarkResult[]
}

// Ollama model name → { hfId, quantization, peakVramGb }
const MODEL_MAP: Record<string, { hfId: string; quantization: string; peakVramGb: number }> = {
  'qwen2.5-coder:7b':                     { hfId: 'Qwen/Qwen2.5-Coder-7B-Instruct',                  quantization: 'Q4_K_M', peakVramGb: 4.7 },
  'qwen2.5-coder:7b-instruct-q4_K_M':    { hfId: 'Qwen/Qwen2.5-Coder-7B-Instruct',                  quantization: 'Q4_K_M', peakVramGb: 4.7 },
  'qwen2.5-coder:14b':                    { hfId: 'Qwen/Qwen2.5-Coder-14B-Instruct',                 quantization: 'Q4_K_M', peakVramGb: 9.0 },
  'qwen2.5-coder:14b-instruct-q4_K_M':   { hfId: 'Qwen/Qwen2.5-Coder-14B-Instruct',                 quantization: 'Q4_K_M', peakVramGb: 9.0 },
  'qwen2.5:14b':                          { hfId: 'Qwen/Qwen2.5-14B-Instruct',                       quantization: 'Q4_K_M', peakVramGb: 9.0 },
  'qwen2.5:14b-instruct-q4_K_M':         { hfId: 'Qwen/Qwen2.5-14B-Instruct',                       quantization: 'Q4_K_M', peakVramGb: 9.0 },
  'qwen3:30b-a3b-q4_K_M':                { hfId: 'Qwen/Qwen3-30B-A3B',                              quantization: 'Q4_K_M', peakVramGb: 12.0 },
  'qwen3-coder-next:latest':              { hfId: 'Qwen/Qwen3-Coder-480B-A35B-Instruct',             quantization: 'Q4_K_M', peakVramGb: 12.0 },
  'gemma3n:latest':                       { hfId: 'google/gemma-3n-E4B-it',                          quantization: 'Q4_K_M', peakVramGb: 7.5 },
  'gemma3:12b':                           { hfId: 'google/gemma-3-12b-it',                           quantization: 'Q4_K_M', peakVramGb: 8.1 },
  'gemma3:12b-it-q4_K_M':                { hfId: 'google/gemma-3-12b-it',                           quantization: 'Q4_K_M', peakVramGb: 8.1 },
  'gemma4:e4b':                           { hfId: 'google/gemma-4-E4B-it',                           quantization: 'Q4_K_M', peakVramGb: 9.6 },
  'gemma4:e4b-it-q4_K_M':                { hfId: 'google/gemma-4-E4B-it',                           quantization: 'Q4_K_M', peakVramGb: 9.6 },
  'llama3.1:8b':                          { hfId: 'meta-llama/Meta-Llama-3.1-8B-Instruct',           quantization: 'Q4_K_M', peakVramGb: 4.9 },
  'deepseek-coder-v2:lite':               { hfId: 'deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct',     quantization: 'Q4_K_M', peakVramGb: 8.9 },
  'deepseek-r1:7b':                       { hfId: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',         quantization: 'Q4_K_M', peakVramGb: 4.7 },
  'deepseek-r1:7b-8k':                   { hfId: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',         quantization: 'Q4_K_M', peakVramGb: 4.8 },
  'deepseek-coder-v2:lite-8k':           { hfId: 'deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct',     quantization: 'Q4_K_M', peakVramGb: 9.6 },
  'gemma4:e4b-it-q4_K_M-8k':            { hfId: 'google/gemma-4-E4B-it',                           quantization: 'Q4_K_M', peakVramGb: 9.8 },
  'gemma3:12b-8k':                       { hfId: 'google/gemma-3-12b-it',                           quantization: 'Q4_K_M', peakVramGb: 8.9 },
  'llama3.1:8b-8k':                      { hfId: 'meta-llama/Meta-Llama-3.1-8B-Instruct',           quantization: 'Q4_K_M', peakVramGb: 5.1 },
  'qwen2.5-coder:14b-8k':               { hfId: 'Qwen/Qwen2.5-Coder-14B-Instruct',                 quantization: 'Q4_K_M', peakVramGb: 9.0 },
  'qwen2.5:14b-8k':                      { hfId: 'Qwen/Qwen2.5-14B-Instruct',                       quantization: 'Q4_K_M', peakVramGb: 9.0 },
  'gpt-oss:20b':                          { hfId: 'openai/gpt-oss-20b',                              quantization: 'Q4_K_M', peakVramGb: 12.0 },
  'deepcoder:14b':                         { hfId: 'agentica-org/DeepCoder-14B-Preview',               quantization: 'Q4_K_M', peakVramGb: 9.0 },
  'phi4:14b':                              { hfId: 'microsoft/phi-4',                                  quantization: 'Q4_K_M', peakVramGb: 8.7 },
  'qwen3:14b':                             { hfId: 'Qwen/Qwen3-14B',                                  quantization: 'Q4_K_M', peakVramGb: 8.7 },
  'lfm2:24b':                              { hfId: 'LiquidAI/LFM2-24B-A2B',                            quantization: 'Q4_K_M', peakVramGb: 14.4 },
  'gemma4:26b':                            { hfId: 'google/gemma-4-27b-it',                            quantization: 'Q4_K_M', peakVramGb: 18.0 },
  'nouscoder-14b':                         { hfId: 'NousResearch/NousCoder-14B',                       quantization: 'Q4_K_M', peakVramGb: 9.0 },
  'nemotron-nano-9b-v2':                   { hfId: 'nvidia/NVIDIA-Nemotron-Nano-9B-v2',                quantization: 'Q4_K_M', peakVramGb: 5.2 },
  'nemotron-3-nano-30b-a3b':               { hfId: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16',       quantization: 'IQ4_NL', peakVramGb: 17.0 },
  'nemotron-cascade-2:30b-a3b':           { hfId: 'nvidia/Nemotron-Cascade-2-30B-A3B',                quantization: 'IQ4_XS', peakVramGb: 17.6 },
  'gemma-3-27b-it':                        { hfId: 'google/gemma-3-27b-it',                            quantization: 'Q4_K_M', peakVramGb: 16.5 },
  'mistral-small-3.1-24b':                 { hfId: 'mistralai/Mistral-Small-3.1-24B-Instruct-2503',    quantization: 'Q4_K_M', peakVramGb: 13.3 },
  'qwen3.6-35b-a3b':                       { hfId: 'Qwen/Qwen3.6-35B-A3B',                            quantization: 'UD-Q4_K_M', peakVramGb: 21.1 },
}

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag)
  if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  const eq = process.argv.find(a => a.startsWith(flag + '='))
  return eq ? eq.slice(flag.length + 1) : def
}

function loadTokPerSec(): Map<string, number> {
  const text = readFileSync(ROUTING_YAML, 'utf-8')
  const map = new Map<string, number>()
  let inModels = false
  let currentModel = ''
  let tokPerS = 0

  for (const line of text.split('\n')) {
    if (line === 'models:') { inModels = true; continue }
    if (!inModels) continue
    if (/^  \S/.test(line) && line.trimEnd().endsWith(':')) {
      if (currentModel && tokPerS > 0) map.set(currentModel, tokPerS)
      currentModel = line.trim().slice(0, -1)
      tokPerS = 0
      continue
    }
    if (currentModel && /^    \S/.test(line)) {
      const m = line.match(/^\s+tok_per_s:\s+(\d+)/)
      if (m) tokPerS = parseInt(m[1])
    }
  }
  if (currentModel && tokPerS > 0) map.set(currentModel, tokPerS)
  return map
}

// Parse GGUF metadata from your-inference-host via SSH — returns hfId resolved from repo URLs in metadata
async function resolveGgufMeta(modelAlias: string, ubullmHost: string): Promise<{ hfId: string; quantization: string } | null> {
  const { spawnSync } = await import('child_process')
  // list GGUF files, find the best match for the alias
  const ls = spawnSync('ssh', [ubullmHost, 'ls /data/models/*.gguf 2>/dev/null'], { encoding: 'utf-8', stdio: 'pipe' })
  if (ls.status !== 0) return null
  const files = ls.stdout.trim().split('\n').map(f => f.trim()).filter(Boolean)
  const slug = modelAlias.replace(/[^a-z0-9]/gi, '-').toLowerCase()
  const match = files.find(f => f.toLowerCase().includes(slug)) ?? null
  if (!match) { console.log(`    [gguf-lookup] no file found matching "${modelAlias}"`) ; return null }

  // extract quantization from filename (e.g. Q4_K_M, IQ4_NL, Q8_0)
  const qMatch = match.match(/[_-]((?:IQ|Q)\d[_A-Z0-9]+)\.gguf$/i)
  const quantization = qMatch ? qMatch[1].toUpperCase() : 'Q4_K_M'

  // read key metadata fields
  const py = `
import struct, json, sys
def read_gguf_kv(path, keys):
    out = {}
    with open(path, 'rb') as f:
        if f.read(4) != b'GGUF': return out
        f.read(4); f.read(8)
        n_kv = struct.unpack('<Q', f.read(8))[0]
        for _ in range(min(n_kv, 80)):
            kl = struct.unpack('<Q', f.read(8))[0]
            key = f.read(kl).decode('utf-8', errors='replace')
            vt = struct.unpack('<I', f.read(4))[0]
            if vt == 8:
                sl = struct.unpack('<Q', f.read(8))[0]
                val = f.read(sl).decode('utf-8', errors='replace')
                if key in keys: out[key] = val
            elif vt in (4,5,6): f.read(4)
            elif vt in (2,3,7): f.read(2)
            elif vt in (0,1): f.read(1)
            elif vt in (10,11): f.read(8)
            elif vt == 9:
                at = struct.unpack('<I', f.read(4))[0]; n = struct.unpack('<Q', f.read(8))[0]
                if at == 8: [f.read(struct.unpack('<Q',f.read(8))[0]) for _ in range(n)]
                elif at in (4,5,6): f.read(4*n)
                elif at in (10,11): f.read(8*n)
                else: break
            else: break
    return out
keys = ['general.repo_url','general.base_model.0.repo_url']
print(json.dumps(read_gguf_kv('${match}', keys)))
`
  const meta = spawnSync('ssh', [ubullmHost, `python3 -c "${py.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`], { encoding: 'utf-8', stdio: 'pipe' })
  if (meta.status !== 0 || !meta.stdout.trim()) return null

  let parsed: Record<string, string> = {}
  try { parsed = JSON.parse(meta.stdout.trim()) } catch { return null }

  // prefer instruction model repo_url over base model
  const rawUrl = parsed['general.repo_url'] ?? parsed['general.base_model.0.repo_url'] ?? ''
  const urlMatch = rawUrl.match(/huggingface\.co\/([^/\s]+\/[^/\s]+)/)
  if (!urlMatch) { console.log(`    [gguf-lookup] no HF URL in metadata: ${JSON.stringify(parsed)}`); return null }

  const hfId = urlMatch[1]
  console.log(`    [gguf-lookup] ${match.split('/').pop()} → ${hfId} (${quantization})`)
  return { hfId, quantization }
}

async function submit(payload: object, dryRun: boolean): Promise<{ id: string; status: string } | null> {
  if (dryRun) {
    console.log('  [dry-run]', JSON.stringify(payload))
    return { id: 'dry-run', status: 'DRY_RUN' }
  }
  const envText = readFileSync(join(homedir(), '.claude/.env'), 'utf-8')
  const keyMatch = envText.match(/LOCALMAXXING_API_KEY=(\S+)/)
  if (!keyMatch) throw new Error('LOCALMAXXING_API_KEY not found in ~/.claude/.env')
  const apiKey = keyMatch[1]

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const json = await res.json() as Record<string, unknown>
  if (!res.ok) {
    const detail = json.details ?? json.message ?? json.error ?? res.statusText
    throw new Error(`${json.error ?? 'Error'}: ${JSON.stringify(detail)}`)
  }
  return { id: json.id as string, status: json.status as string }
}

async function main() {
  const resultsFile = arg('--results', '')
  const modelFilter = arg('--models', '').split(',').filter(Boolean)
  const engine = arg('--engine', 'llama.cpp')
  const dryRun = process.argv.includes('--dry-run')

  let gpuName: string
  let vramGb: number
  let tokMap: Map<string, number>

  if (resultsFile) {
    const data = JSON.parse(readFileSync(resultsFile, 'utf-8')) as ResultsFile
    gpuName = data.gpu.name
    vramGb = data.gpu.vramGb
    tokMap = new Map(
      data.results
        .filter(r => r.tokPerSec !== null && r.error === null)
        .map(r => [r.model, r.tokPerSec!])
    )
    console.log(`\nSource: ${resultsFile}`)
    console.log(`Benchmarked: ${data.timestamp} on ${data.host}`)
  } else {
    gpuName = arg('--gpu-name', '')
    vramGb = parseInt(arg('--vram-gb', '0'))
    if (!gpuName || !vramGb) {
      console.error('Usage: bun SubmitLocalMaxxing.ts --results <file.json>  OR  --gpu-name "RTX 3060" --vram-gb 12')
      process.exit(1)
    }
    tokMap = loadTokPerSec()
    console.log(`\nSource: inference-routing.yaml (tok_per_s values)`)
  }

  const ubullmHost = arg('--your-inference-host', 'your-inference-host')

  // Build candidates: MODEL_MAP entries + GGUF-resolved entries for unmapped models
  type Candidate = { model: string; hfId: string; quantization: string; peakVramGb: number }
  const candidates: Candidate[] = []

  const mappedNames = new Set(Object.keys(MODEL_MAP))
  const allNames = modelFilter.length > 0 ? modelFilter : [...tokMap.keys()]

  for (const name of allNames) {
    if (!tokMap.has(name)) continue
    if (mappedNames.has(name)) {
      const { hfId, quantization, peakVramGb } = MODEL_MAP[name]
      candidates.push({ model: name, hfId, quantization, peakVramGb })
    } else {
      // Try GGUF metadata lookup for unmapped models
      process.stdout.write(`  [gguf-lookup] ${name} ... `)
      const resolved = await resolveGgufMeta(name, ubullmHost)
      if (resolved) {
        candidates.push({ model: name, hfId: resolved.hfId, quantization: resolved.quantization, peakVramGb: 0 })
      } else {
        console.log(`SKIP (no MODEL_MAP entry and GGUF lookup failed)`)
      }
    }
  }

  if (candidates.length === 0) {
    console.error('No models to submit. Check --models filter or ensure tok_per_s is set in inference-routing.yaml.')
    process.exit(1)
  }

  console.log(`\nSubmitLocalMaxxing — ${gpuName} ${vramGb}GB | engine: ${engine} | ${candidates.length} model(s)${dryRun ? ' [DRY RUN]' : ''}\n`)

  const results: Array<{ model: string; id: string; status: string }> = []

  for (let i = 0; i < candidates.length; i++) {
    const { model: ollamaName, hfId, quantization, peakVramGb } = candidates[i]
    const tokSOut = tokMap.get(ollamaName) ?? 0

    if (!tokSOut) {
      console.log(`  SKIP  ${ollamaName} — no tok_per_s in inference-routing.yaml`)
      continue
    }

    process.stdout.write(`  [${i + 1}/${candidates.length}] ${ollamaName.padEnd(42)} `)

    const payload = {
      hfId,
      hardware: { hwClass: 'DISCRETE_GPU', gpuName, vramGb },
      engineName: engine,
      quantization,
      tokSOut,
      peakVramGb,
    }

    try {
      const result = await submit(payload, dryRun)
      if (result) {
        console.log(`${result.status} (${result.id})`)
        results.push({ model: ollamaName, ...result })
      }
    } catch (err) {
      console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (!dryRun && i < candidates.length - 1) {
      process.stdout.write(`  waiting ${RATE_LIMIT_MS / 1000}s (rate limit)...\r`)
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS))
      process.stdout.write(' '.repeat(50) + '\r')
    }
  }

  console.log(`\nDone. ${results.filter(r => r.status === 'APPROVED').length}/${results.length} approved.\n`)
  for (const r of results) {
    console.log(`  ${r.status.padEnd(10)} ${r.model.padEnd(44)} ${r.id}`)
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
