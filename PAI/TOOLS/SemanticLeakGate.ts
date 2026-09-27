#!/usr/bin/env bun
/**
 * SemanticLeakGate — advisory, local-only prose review for a staged secunit release.
 *
 * The deterministic release gates (identifier regex, secret scan, private-zone
 * allow-list) catch known patterns. They cannot catch a paragraph that leaks
 * private context without tripping any pattern. This gate sends staged prose
 * to a LOCAL model and asks one question per chunk: "would a stranger learn
 * something private about a specific person from this?"
 *
 * Hard invariant: the question "is this private?" is itself private. This
 * module never calls a non-private host. If the endpoint is not on a private
 * network range it refuses to run and reports every file as unreviewed.
 * There is no cloud fallback under any condition.
 *
 * Advisory only. It never blocks, never edits, never redacts. Output is a
 * flagged-files report for a human.
 *
 * Standalone probe:
 *   bun PAI/TOOLS/SemanticLeakGate.ts <dir-or-file> [--no-cache] [--verbose]
 *
 * Config (env; bun loads ~/.claude/.env when run from ~/.claude):
 *   SECUNIT_SEMANTIC_GATE_URL   OpenAI-compatible base URL, e.g. http://host:11434
 *   SECUNIT_SEMANTIC_GATE_MODEL model name (default: first model the server lists)
 *   SECUNIT_SEMANTIC_GATE_CONCURRENCY  parallel requests (default 2)
 *   SECUNIT_SEMANTIC_GATE_TIMEOUT_MS   per-request timeout (default 120000)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, lstatSync } from 'fs'
import { join, extname, basename } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SemanticFlag {
  file: string
  chunk: number
  reason: string
  /** 'model' = the model flagged it; 'unreviewed' = gate could not review it (fail-closed) */
  source: 'model' | 'unreviewed'
}

export interface SemanticGateResult {
  /** true only if the endpoint was reachable and every chunk got a parsed verdict */
  reviewed: boolean
  flagged: SemanticFlag[]
  filesScanned: number
  filesFromCache: number
  chunksSent: number
  wallMs: number
  endpoint: string | null
  model: string | null
  /** why `reviewed` is false, if it is */
  failure?: string
}

interface CacheEntry { flag: boolean; reason: string; model: string; at: string }
type Cache = Record<string, CacheEntry> // key: sha256(promptHash + model + chunk text)

// ── Config ────────────────────────────────────────────────────────────────────

const CACHE_PATH = join(homedir(), '.cache', 'secunit-semantic-cache.json')
const CHUNK_CHARS = 12_000
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_CONCURRENCY = 2
export const PROSE_EXTS = new Set(['.md', '.txt'])

const SYSTEM_PROMPT = `You review files staged for a PUBLIC open-source release of a personal AI harness. The author is a security consultant who has run this software on his own machine, so private context can leak into prose without any name or secret appearing.

Flag a passage if a stranger reading it would learn something private about a specific real person: family members and their circumstances, immigration or legal status, health, finances, home address or home network layout, employer or client engagements described specifically enough to identify them, or interpersonal details.

Do NOT flag any of the following, they are expected in this release:
- Template placeholders: anything in double or single curly braces such as {{PRINCIPAL_NAME}}, {{DA_NAME}}, {PRINCIPAL.NAME}, or shell-style \${VAR}. These are substituted per user and reveal nothing.
- Generic sanitized values: your-organization, host1, host2, your-inference-host, YOUR_TAILSCALE_IP, <username>, 127.0.0.1.
- The harness's own directory layout: paths under ~/.claude, PAI/, skills/, hooks/, MEMORY/, USER/. The layout is the product, not a secret.
- The author's public byline, copyright line, or public GitHub handle.
- AI model names, vendor names, Hugging Face author handles (e.g. jackrong, unsloth), benchmark numbers, service and hostname conventions like "Pulse" or "pai-pulse.service".
- Prompt or workflow text that merely describes categories of personal data the software handles ("their goals", "my journal", "TELOS file", "identity and contacts") without disclosing any actual value.
- Lists of example names in a redaction or classification policy.
- Fictional characters, agent personas, or clearly hypothetical examples.

Flag only when a real, specific fact about a real person is disclosed.

Respond with JSON only: {"flag": boolean, "reason": string}. Keep reason under 140 characters and quote the offending phrase if flagging.`

// ── Endpoint safety ───────────────────────────────────────────────────────────

/** True only for loopback, RFC1918, CGNAT (Tailscale 100.64/10), .local, .ts.net, .internal. */
export function isPrivateHost(url: string): boolean {
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { return false }
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true
  if (host.endsWith('.local') || host.endsWith('.ts.net') || host.endsWith('.internal')) return true
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 127) return true
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

function resolveEndpoint(): { url: string } | { error: string } {
  const raw = (process.env.SECUNIT_SEMANTIC_GATE_URL ?? process.env.OLLAMA_BASE_URL ?? '').trim()
  if (!raw) return { error: 'SECUNIT_SEMANTIC_GATE_URL (or OLLAMA_BASE_URL) not set' }
  const url = raw.replace(/\/+$/, '')
  if (!isPrivateHost(url)) return { error: `endpoint ${url} is not on a private network range; refusing (the question itself is private)` }
  return { url }
}

// ── Chunking / hashing ────────────────────────────────────────────────────────

export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  if (text.length <= size) return [text]
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(i + size, text.length)
    if (end < text.length) {
      const nl = text.lastIndexOf('\n\n', end)
      if (nl > i + size / 2) end = nl
    }
    out.push(text.slice(i, end))
    i = end
  }
  return out
}

function sha(s: string): string { return createHash('sha256').update(s).digest('hex') }
// Cache key includes the prompt hash so a prompt change invalidates stale verdicts.
const PROMPT_HASH = sha(SYSTEM_PROMPT).slice(0, 12)

function loadCache(): Cache {
  try { return JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) } catch { return {} }
}
function saveCache(c: Cache) {
  try { mkdirSync(join(homedir(), '.cache'), { recursive: true }); writeFileSync(CACHE_PATH, JSON.stringify(c)) } catch { /* cache is best-effort */ }
}

// ── Model call ────────────────────────────────────────────────────────────────

async function listFirstModel(base: string, timeoutMs: number): Promise<string | null> {
  try {
    const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return null
    const j: any = await r.json()
    const list = j.data ?? j.models ?? []
    const first = list[0]
    return first?.id ?? first?.name ?? first?.model ?? null
  } catch { return null }
}

async function classifyChunk(base: string, model: string, text: string, timeoutMs: number):
  Promise<{ ok: true; flag: boolean; reason: string } | { ok: false; error: string }> {
  let resp: Response
  try {
    resp = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 200,
        chat_template_kwargs: { enable_thinking: false },
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'verdict', schema: {
            type: 'object', properties: { flag: { type: 'boolean' }, reason: { type: 'string' } },
            required: ['flag', 'reason'], additionalProperties: false } },
        },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `FILE CONTENT:\n\n${text}` },
        ],
      }),
    })
  } catch (e) {
    return { ok: false, error: `request failed: ${String(e).slice(0, 120)}` }
  }
  if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
  let content = ''
  try {
    const j: any = await resp.json()
    content = j.choices?.[0]?.message?.content ?? ''
  } catch { return { ok: false, error: 'non-JSON response body' } }
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const m = content.match(/\{[\s\S]*\}/)
  if (!m) return { ok: false, error: 'no JSON object in model output' }
  try {
    const v = JSON.parse(m[0])
    if (typeof v.flag !== 'boolean') return { ok: false, error: 'verdict missing boolean flag' }
    return { ok: true, flag: v.flag, reason: String(v.reason ?? '').slice(0, 200) }
  } catch { return { ok: false, error: 'verdict JSON unparseable' } }
}

// ── Gate ──────────────────────────────────────────────────────────────────────

export interface GateOptions {
  /** paths relative to root, prose files only */
  files: string[]
  root: string
  useCache?: boolean
  log?: (s: string) => void
}

export async function runSemanticLeakScan(opts: GateOptions): Promise<SemanticGateResult> {
  const t0 = Date.now()
  const log = opts.log ?? (() => {})
  const useCache = opts.useCache ?? true
  const timeoutMs = Number(process.env.SECUNIT_SEMANTIC_GATE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  const concurrency = Math.max(1, Number(process.env.SECUNIT_SEMANTIC_GATE_CONCURRENCY ?? DEFAULT_CONCURRENCY))

  const unreviewedAll = (failure: string, endpoint: string | null, model: string | null): SemanticGateResult => ({
    reviewed: false, failure, endpoint, model,
    flagged: opts.files.map(f => ({ file: f, chunk: 0, reason: `unreviewed: ${failure}`, source: 'unreviewed' as const })),
    filesScanned: opts.files.length, filesFromCache: 0, chunksSent: 0, wallMs: Date.now() - t0,
  })

  const ep = resolveEndpoint()
  if ('error' in ep) return unreviewedAll(ep.error, null, null)

  const model = (process.env.SECUNIT_SEMANTIC_GATE_MODEL ?? '').trim() || await listFirstModel(ep.url, timeoutMs)
  if (!model) return unreviewedAll(`local model endpoint ${ep.url} unreachable or lists no models`, ep.url, null)

  const cache = useCache ? loadCache() : {}
  const flagged: SemanticFlag[] = []
  let filesFromCache = 0
  let chunksSent = 0
  let firstFailure: string | null = null

  // Build work list: (file, chunkIdx, text, key)
  type Job = { file: string; chunk: number; text: string; key: string }
  const jobs: Job[] = []
  for (const rel of opts.files) {
    let text: string
    try { text = readFileSync(join(opts.root, rel), 'utf-8') } catch { continue }
    if (!text.trim()) { filesFromCache++; continue }
    const chunks = chunkText(text)
    let allCached = true
    chunks.forEach((c, i) => {
      const key = sha(PROMPT_HASH + ' ' + model + ' ' + c)
      const hit = cache[key]
      if (hit) {
        if (hit.flag) flagged.push({ file: rel, chunk: i, reason: hit.reason, source: 'model' })
      } else {
        allCached = false
        jobs.push({ file: rel, chunk: i, text: c, key })
      }
    })
    if (allCached) filesFromCache++
  }

  log(`  semantic gate: ${opts.files.length} prose files, ${filesFromCache} fully cached, ${jobs.length} chunks to review via ${model} @ ${ep.url}`)

  // Worker pool
  let next = 0
  let done = 0
  const worker = async () => {
    while (true) {
      const i = next++
      if (i >= jobs.length) return
      const j = jobs[i]
      const v = await classifyChunk(ep.url, model, j.text, timeoutMs)
      chunksSent++
      if (v.ok === true) {
        cache[j.key] = { flag: v.flag, reason: v.reason, model, at: new Date().toISOString() }
        if (v.flag) flagged.push({ file: j.file, chunk: j.chunk, reason: v.reason, source: 'model' })
      } else {
        const err = (v as { ok: false; error: string }).error
        firstFailure ??= err
        flagged.push({ file: j.file, chunk: j.chunk, reason: `unreviewed: ${err}`, source: 'unreviewed' })
      }
      done++
      if (done % 25 === 0) log(`  semantic gate: ${done}/${jobs.length} chunks`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker))

  if (useCache) saveCache(cache)

  return {
    reviewed: firstFailure === null,
    failure: firstFailure ?? undefined,
    flagged,
    filesScanned: opts.files.length,
    filesFromCache,
    chunksSent,
    wallMs: Date.now() - t0,
    endpoint: ep.url,
    model,
  }
}

// ── Standalone probe ──────────────────────────────────────────────────────────

function walkProse(root: string): string[] {
  const out: string[] = []
  const st = lstatSync(root)
  if (st.isFile()) return [basename(root)]
  const rec = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e === '.git') continue
      const full = join(dir, e)
      let s: ReturnType<typeof lstatSync>
      try { s = lstatSync(full) } catch { continue }
      if (s.isSymbolicLink()) continue
      if (s.isDirectory()) { rec(full); continue }
      if (PROSE_EXTS.has(extname(e))) out.push(full.slice(root.length + 1))
    }
  }
  rec(root)
  return out
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const target = args.find(a => !a.startsWith('--'))
  if (!target || !existsSync(target)) {
    console.error('usage: bun SemanticLeakGate.ts <dir-or-file> [--no-cache] [--verbose]')
    process.exit(2)
  }
  const st = lstatSync(target)
  const root = st.isFile() ? join(target, '..') : target
  const files = walkProse(target)
  const res = await runSemanticLeakScan({ files, root, useCache: !args.includes('--no-cache'), log: s => console.error(s) })
  const verbose = args.includes('--verbose')
  console.log(JSON.stringify(verbose ? res : { ...res, flagged: res.flagged.slice(0, 50) }, null, 2))
  process.exit(res.reviewed ? 0 : 1)
}
