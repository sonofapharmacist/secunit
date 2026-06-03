#!/usr/bin/env bun
/**
 * QualityTestModels.ts — deterministic quality harness for local server models.
 *
 * The local inference server is llama-server (OpenAI-compatible) — Ollama is no
 * longer supported. We bypass PAI/TOOLS/Inference.ts on purpose: this harness
 * tests raw model quality against the server, so it must hit the HTTP API
 * directly without any routing/wrapping layers (same rationale as
 * BenchmarkLocalModels.ts).
 *
 * Usage: bun $HOME/.claude/PAI/TOOLS/QualityTestModels.ts [options]
 *   --host <addr>         Server host:port (default: localhost:11434)
 *   --gpu-label <name>    GPU label recorded in saved results (default: "unknown")
 *   --models <m1,m2>      Comma-separated model filter (default: all non-cloud models in routing config)
 *   --tier <name>         Prompt tier: fast|standard|smart|all (default: all)
 *   --timeout-ms <n>      Per-request timeout in milliseconds (default: 90000)
 *   --save <file>         Write JSON results to file
 *   --compare <f1> <f2> [<f3>]
 *                         Compare 2-3 saved result files and exit
 *   --help                Print usage and exit 0
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const LOCAL_AUTH_HEADERS: Record<string, string> = process.env.PAI_INFERENCE_TOKEN
  ? { Authorization: `Bearer ${process.env.PAI_INFERENCE_TOKEN}` }
  : {}

// detectServerType: the server is always llama-server (OpenAI-compatible).
// We probe /v1/models to confirm it's reachable; if it isn't, callers will get
// errors from subsequent calls — there is no Ollama fallback.
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

const DEFAULT_HOST = 'localhost:11434'
const DEFAULT_GPU_LABEL = 'unknown'
const DEFAULT_TIMEOUT_MS = 90000
const ROUTING_YAML = join(homedir(), '.claude/PAI/USER/Config/inference-routing.yaml')
const THINK_TAG_RE = /<think>[\s\S]*?<\/think>/gi
const VALID_TIERS = new Set<Tier>(['fast', 'standard', 'smart'])

type Tier = 'fast' | 'standard' | 'smart'
type TierSelection = Tier | 'all'

type RoutingModel = {
  tier: Tier
}

type PromptSpec = {
  id: string
  tier: Tier
  prompt: string
  checkCorrect: (response: string) => boolean
  findExpectedIndex: (response: string) => number
}

type PromptResult = {
  id: string
  tier: Tier
  prompt: string
  response: string
  responseLength: number
  correct: boolean
  coherent: boolean
  instructionFollow: boolean
  qualityScore: number
  error: string | null
}

type ModelResult = {
  model: string
  tier: Tier
  qualityScore: number
  coherent: boolean
  instructionFollow: boolean
  error: string | null
  prompts: PromptResult[]
}

type SavedResultsFile = {
  timestamp: string
  host: string
  gpuLabel: string
  results: ModelResult[]
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

type CliOptions = {
  host: string
  gpuLabel: string
  models: string[]
  tier: TierSelection
  mode: 'general' | 'coding'
  noThink: boolean
  timeoutMs: number
  saveFile: string
  compareFiles: string[]
  help: boolean
}

const PROMPTS: PromptSpec[] = [
  {
    id: 'P1',
    tier: 'fast',
    prompt: 'Classify this text as SECURITY, PERFORMANCE, or OTHER. Reply with only the single word label.\nText: "The authentication endpoint accepts passwords over HTTP without TLS."',
    checkCorrect: (response: string): boolean => /security/i.test(response),
    findExpectedIndex: (response: string): number => response.search(/security/i),
  },
  {
    id: 'P2',
    tier: 'fast',
    prompt: 'Extract the CVE number from this text. Reply with only the CVE ID, nothing else.\nText: "Researchers disclosed CVE-2024-3094 affecting XZ Utils versions 5.6.0 and 5.6.1."',
    checkCorrect: (response: string): boolean => /CVE-\d{4}-\d+/i.test(response),
    findExpectedIndex: (response: string): number => {
      const match = response.match(/CVE-\d{4}-\d+/i)
      return match?.index ?? -1
    },
  },
  {
    id: 'P3',
    tier: 'fast',
    prompt: 'A server returns HTTP 200 on POST /login with wrong credentials. List exactly three security issues this indicates, numbered 1-3.',
    checkCorrect: (response: string): boolean => response.includes('1.') && response.includes('2.') && response.includes('3.'),
    findExpectedIndex: (response: string): number => {
      const indexes = ['1.', '2.', '3.']
        .map((marker: string) => response.indexOf(marker))
        .filter((index: number) => index >= 0)
      return indexes.length > 0 ? Math.min(...indexes) : -1
    },
  },
  {
    id: 'P4',
    tier: 'standard',
    prompt: 'List the OWASP Top 10 web application security risks as a numbered list. Include only the risk names, no descriptions.',
    checkCorrect: (response: string): boolean => {
      const keywords = [
        'injection',
        'broken auth',
        'xss',
        'idor',
        'security misconfiguration',
        'cryptographic',
        'insecure design',
        'software integrity',
        'logging',
        'ssrf',
      ]
      const lowered = response.toLowerCase()
      const hits = keywords.filter((keyword: string) => lowered.includes(keyword)).length
      return hits >= 5
    },
    findExpectedIndex: (): number => -1,
  },
  {
    id: 'P5',
    tier: 'standard',
    prompt: 'Analyze this diff and identify the security vulnerability in one sentence:\n```\n-  query = "SELECT * FROM users WHERE id=" + user_id\n+  query = "SELECT * FROM users WHERE id=?" + user_id\n```',
    checkCorrect: (response: string): boolean => /injection|sql/i.test(response),
    findExpectedIndex: (): number => -1,
  },
  {
    id: 'P6',
    tier: 'standard',
    prompt: "You are reviewing a pull request. The code does: os.system('rm -rf ' + user_input). Write a 2-sentence security review comment.",
    checkCorrect: (response: string): boolean => response.length > 50 && /inject|input|sanitiz|command/i.test(response),
    findExpectedIndex: (): number => -1,
  },
  {
    id: 'P7',
    tier: 'smart',
    prompt: 'A web app stores JWT tokens in localStorage and uses them for API auth. The tokens never expire. Identify the three highest-severity security risks and for each: name the risk, explain the attack vector, suggest a mitigation. Format as numbered list.',
    checkCorrect: (response: string): boolean => {
      const lowered = response.toLowerCase()
      const keywords = ['xss', 'csrf', 'expire', 'refresh', 'httponly', 'secure', 'storage']
      const hits = keywords.filter((keyword: string) => lowered.includes(keyword)).length
      return response.includes('1.') && response.includes('2.') && response.includes('3.') && hits >= 2
    },
    findExpectedIndex: (): number => -1,
  },
  {
    id: 'P8',
    tier: 'smart',
    prompt: 'Compare symmetric and asymmetric encryption: when should each be used? Give a concrete example for each. Be thorough but concise.',
    checkCorrect: (response: string): boolean => response.length > 200 && /symmetric/i.test(response) && /asymmetric/i.test(response),
    findExpectedIndex: (): number => -1,
  },
]

const CODING_PROMPTS: PromptSpec[] = [
  {
    id: 'C1',
    tier: 'fast',
    prompt: 'Identify the TypeScript type error in this code. Reply with only the error description in one sentence.\nconst x: number = "hello";\nconst y: string = x + 1;',
    checkCorrect: (response: string): boolean => /type|string|number|assign/i.test(response),
    findExpectedIndex: (response: string): number => response.search(/type|string|number/i),
  },
  {
    id: 'C2',
    tier: 'fast',
    prompt: 'Write only the TypeScript function signature (no body, no semicolon) for: takes a readonly string array and returns the longest string. Reply with only the signature line.',
    checkCorrect: (response: string): boolean => (/string\[\]|Array<string>|ReadonlyArray/.test(response)) && /string/.test(response),
    findExpectedIndex: (response: string): number => response.search(/function|=>|const/),
  },
  {
    id: 'C3',
    tier: 'fast',
    prompt: 'Summarize this git diff in one sentence:\n-  const timeoutMs = 5000\n+  const timeoutMs = 30000\n-  const maxRetries = 1\n+  const maxRetries = 3',
    checkCorrect: (response: string): boolean => /(timeout|retry|retries)/i.test(response) && /(increase|longer|higher|raised|bumped|extended|tripled)/i.test(response),
    findExpectedIndex: (): number => -1,
  },
  {
    id: 'C4',
    tier: 'standard',
    prompt: 'Find the bug in this TypeScript and name it in one sentence:\nasync function fetchUser(id: string) {\n  const res = await fetch(\'/api/users/\' + id)\n  return res.json()\n}',
    checkCorrect: (response: string): boolean => /(error|ok|status|check|throw|catch|handle)/i.test(response),
    findExpectedIndex: (): number => -1,
  },
  {
    id: 'C5',
    tier: 'standard',
    prompt: 'Review this function for issues. List exactly two problems, numbered 1-2:\nfunction getUser(req, res) {\n  const id = req.query.id;\n  db.query("SELECT * FROM users WHERE id = " + id, (err, rows) => {\n    res.json(rows[0]);\n  });\n}',
    checkCorrect: (response: string): boolean => response.includes('1.') && response.includes('2.') && /(inject|sql)/i.test(response),
    findExpectedIndex: (response: string): number => response.indexOf('1.'),
  },
  {
    id: 'C6',
    tier: 'standard',
    prompt: 'Given this task: "TypeScript function that parses a JSON string and returns null on error". Write a single bun test command that verifies a correct implementation exists at ./parse.ts. Reply with only the command.',
    checkCorrect: (response: string): boolean => /(bun|node|test|import|require|parse)/i.test(response),
    findExpectedIndex: (response: string): number => response.search(/bun|node|echo/),
  },
  {
    id: 'C7',
    tier: 'smart',
    prompt: 'Implement a TypeScript function `debounce(fn: (...args: unknown[]) => void, ms: number): (...args: unknown[]) => void` that delays invoking fn until ms milliseconds have elapsed since the last call. Then in 1-2 sentences explain why the closure is necessary.',
    checkCorrect: (response: string): boolean => /setTimeout/.test(response) && /clearTimeout/.test(response),
    findExpectedIndex: (): number => -1,
  },
  {
    id: 'C8',
    tier: 'smart',
    prompt: 'Refactor this TypeScript to be type-safe and handle all error paths. Show only the complete rewritten function:\nasync function saveUser(data) {\n  const result = await db.save(data)\n  return result.id\n}',
    checkCorrect: (response: string): boolean => (/(try|catch|throw|Error)/.test(response)) && /:\s*(string|number|unknown|Promise)/.test(response),
    findExpectedIndex: (): number => -1,
  },
]

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag)
  if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  const eq = process.argv.find((a: string) => a.startsWith(flag + '='))
  return eq ? eq.slice(flag.length + 1) : def
}

function printUsage(): void {
  console.log(`Usage: bun $HOME/.claude/PAI/TOOLS/QualityTestModels.ts [options]
  --host <addr>         Server host:port (default: ${DEFAULT_HOST})
  --gpu-label <name>    GPU label recorded in saved results (default: "${DEFAULT_GPU_LABEL}")
  --models <m1,m2>      Comma-separated model filter (default: all non-cloud models in routing config)
  --tier fast|standard|smart|all
                        Prompt tier to run (default: all)
  --mode general|coding Prompt suite to use (default: general)
  --no-think            Prepend /no_think to all prompts (disables Qwen3 thinking mode)
  --timeout-ms <n>      Per-request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --save <file>         Write JSON results to file
  --compare <f1> <f2> [<f3>]
                        Compare 2-3 saved result files and exit
  --help                Print usage and exit 0`)
}

function parseCompareFiles(argv: string[]): string[] {
  const index = argv.indexOf('--compare')
  if (index < 0) return []

  const files: string[] = []
  for (let i = index + 1; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('--')) break
    files.push(token)
  }
  return files
}

function parseArgs(argv: string[]): CliOptions {
  const help = argv.includes('--help')
  if (help) {
    return {
      host: DEFAULT_HOST,
      gpuLabel: DEFAULT_GPU_LABEL,
      models: [],
      tier: 'all',
      mode: 'general',
      noThink: false,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      saveFile: '',
      compareFiles: [],
      help: true,
    }
  }

  const compareFiles = parseCompareFiles(argv)

  if (argv.includes('--compare') && compareFiles.length < 2) {
    throw new Error('--compare requires 2 or 3 file paths')
  }

  if (compareFiles.length > 3) {
    throw new Error('--compare accepts at most 3 file paths')
  }

  const rawHost = arg('--host', DEFAULT_HOST)
  const host = rawHost.startsWith('http') ? rawHost : `http://${rawHost}`
  const gpuLabel = arg('--gpu-label', DEFAULT_GPU_LABEL)
  const models = arg('--models', '')
    .split(',')
    .map((model: string) => model.trim())
    .filter(Boolean)
  const tierText = arg('--tier', 'all')
  if (tierText !== 'all' && !VALID_TIERS.has(tierText as Tier)) {
    throw new Error(`Invalid --tier value: ${tierText}`)
  }
  const modeText = arg('--mode', 'general')
  if (modeText !== 'general' && modeText !== 'coding') {
    throw new Error(`Invalid --mode value: ${modeText}`)
  }
  const timeoutMs = Number.parseInt(arg('--timeout-ms', String(DEFAULT_TIMEOUT_MS)), 10)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms value: ${arg('--timeout-ms', String(DEFAULT_TIMEOUT_MS))}`)
  }

  return {
    host,
    gpuLabel,
    models,
    tier: tierText as TierSelection,
    mode: modeText as 'general' | 'coding',
    noThink: argv.includes('--no-think'),
    timeoutMs,
    saveFile: arg('--save', ''),
    compareFiles,
    help,
  }
}

function loadRoutingModels(): Map<string, RoutingModel> {
  const text = readFileSync(ROUTING_YAML, 'utf-8')
  const map = new Map<string, RoutingModel>()
  let inModels = false
  let currentModel = ''
  let tier = ''

  for (const line of text.split('\n')) {
    if (line === 'models:') {
      inModels = true
      continue
    }
    if (!inModels) continue
    if (/^  \S/.test(line) && line.trimEnd().endsWith(':')) {
      if (currentModel && VALID_TIERS.has(tier as Tier)) map.set(currentModel, { tier: tier as Tier })
      currentModel = line.trim().slice(0, -1)
      tier = ''
      continue
    }
    if (currentModel && /^    \S/.test(line)) {
      const match = line.match(/^\s+([\w_]+):\s+(.+)/)
      if (!match) continue
      if (match[1] === 'tier') tier = match[2].trim()
    }
  }

  if (currentModel && VALID_TIERS.has(tier as Tier)) map.set(currentModel, { tier: tier as Tier })
  return map
}

function getPromptSuite(tier: TierSelection, mode: 'general' | 'coding'): PromptSpec[] {
  const source = mode === 'coding' ? CODING_PROMPTS : PROMPTS
  if (tier === 'all') return source
  return source.filter((prompt: PromptSpec) => prompt.tier === tier)
}

function stripThinkTags(response: string): string {
  return response.replace(THINK_TAG_RE, '').trim()
}

function checkCoherent(response: string): boolean {
  if (response.trim().length === 0) return false
  if (response.length < 20) return true

  const counts = new Map<string, number>()
  for (let i = 0; i <= response.length - 20; i++) {
    const slice = response.slice(i, i + 20)
    const next = (counts.get(slice) ?? 0) + 1
    if (next >= 3) return false
    counts.set(slice, next)
  }
  return true
}

function checkInstructionFollow(prompt: PromptSpec, response: string): boolean {
  if (!/reply with only|list exactly/i.test(prompt.prompt)) return true
  const expectedIndex = prompt.findExpectedIndex(response)
  if (expectedIndex < 0) return false
  return expectedIndex <= 100
}

function computeQualityScore(correct: boolean, coherent: boolean, instructionFollow: boolean): number {
  return (correct ? 60 : 0) + (coherent ? 25 : 0) + (instructionFollow ? 15 : 0)
}

function buildErrorPromptResult(prompt: PromptSpec, error: string): PromptResult {
  return {
    id: prompt.id,
    tier: prompt.tier,
    prompt: prompt.prompt,
    response: '',
    responseLength: 0,
    correct: false,
    coherent: false,
    instructionFollow: false,
    qualityScore: 0,
    error,
  }
}

function evaluatePromptResponse(prompt: PromptSpec, rawResponse: string): PromptResult {
  const strippedResponse = stripThinkTags(rawResponse)
  const correct = prompt.checkCorrect(strippedResponse)
  const coherent = checkCoherent(strippedResponse)
  const instructionFollow = checkInstructionFollow(prompt, strippedResponse)

  return {
    id: prompt.id,
    tier: prompt.tier,
    prompt: prompt.prompt,
    response: rawResponse,
    responseLength: strippedResponse.length,
    correct,
    coherent,
    instructionFollow,
    qualityScore: computeQualityScore(correct, coherent, instructionFollow),
    error: null,
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function generateResponse(
  baseUrl: string,
  model: string,
  prompt: PromptSpec,
  timeoutMs: number,
  noThink = false,
): Promise<string> {
  const promptText = noThink ? `/no_think\n${prompt.prompt}` : prompt.prompt

  const response = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...LOCAL_AUTH_HEADERS },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: promptText }],
      max_tokens: 512,
      stream: false,
    }),
  }, timeoutMs)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  }
  const payload = await response.json() as OpenAIChatCompletionsResponse
  return payload.choices?.[0]?.message?.content ?? ''
}

async function fetchAvailableModels(baseUrl: string, timeoutMs: number): Promise<{ models: string[] }> {
  // Probe to surface unreachable-server errors early; result is informational.
  await detectServerType(baseUrl)
  const response = await fetchWithTimeout(`${baseUrl}/v1/models`, { method: 'GET', headers: LOCAL_AUTH_HEADERS }, timeoutMs)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  }
  const payload = await response.json() as OpenAIModelsResponse
  const models = (payload.data ?? [])
    .map((model: { id?: string }) => model.id?.trim() ?? '')
    .filter(Boolean)
  return { models }
}

async function runPromptSuite(
  host: string,
  model: string,
  prompts: PromptSpec[],
  timeoutMs: number,
  noThink = false,
): Promise<PromptResult[]> {
  const results: PromptResult[] = []

  for (const prompt of prompts) {
    try {
      const response = await generateResponse(host, model, prompt, timeoutMs, noThink)
      results.push(evaluatePromptResponse(prompt, response))
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        results.push(buildErrorPromptResult(prompt, 'timeout'))
        continue
      }
      const message = error instanceof Error ? error.message : String(error)
      results.push(buildErrorPromptResult(prompt, message))
    }
  }

  return results
}

function buildModelResult(model: string, tier: Tier, prompts: PromptResult[]): ModelResult {
  const qualitySum = prompts.reduce((sum: number, prompt: PromptResult) => sum + prompt.qualityScore, 0)
  const erroredCount = prompts.filter((prompt: PromptResult) => prompt.error !== null).length
  const meanScore = prompts.length > 0 ? qualitySum / prompts.length : 0

  return {
    model,
    tier,
    qualityScore: Number(meanScore.toFixed(2)),
    coherent: prompts.every((prompt: PromptResult) => prompt.coherent),
    instructionFollow: prompts.every((prompt: PromptResult) => prompt.instructionFollow),
    error: erroredCount === prompts.length ? 'all prompts failed' : null,
    prompts,
  }
}

function selectModels(
  routingModels: Map<string, RoutingModel>,
  availableModels: string[],
  modelFilter: string[],
): Array<{ model: string; tier: Tier }> {
  const availableSet = new Set<string>(availableModels)
  const filterSet = modelFilter.length > 0 ? new Set<string>(modelFilter) : null

  return [...routingModels.entries()]
    .filter(([model]: [string, RoutingModel]) => !model.includes(':cloud'))
    .filter(([model]: [string, RoutingModel]) => availableSet.has(model))
    .filter(([model]: [string, RoutingModel]) => filterSet === null || filterSet.has(model))
    .map(([model, config]: [string, RoutingModel]) => ({ model, tier: config.tier }))
}

function loadResultsFile(file: string): SavedResultsFile {
  if (!existsSync(file)) {
    throw new Error(`Missing compare file: ${file}`)
  }
  const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<SavedResultsFile>
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid results file: ${file}`)
  }
  if (typeof parsed.gpuLabel !== 'string' || !Array.isArray(parsed.results)) {
    throw new Error(`Invalid results file shape: ${file}`)
  }
  return {
    timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
    host: typeof parsed.host === 'string' ? parsed.host : '',
    gpuLabel: parsed.gpuLabel,
    results: parsed.results as ModelResult[],
  }
}

function pad(value: string, width: number, right = false): string {
  const text = value.length > width ? value.slice(0, Math.max(1, width - 1)) + '…' : value
  return right ? text.padStart(width) : text.padEnd(width)
}

function tierRank(tier: string): number {
  if (tier === 'fast') return 0
  if (tier === 'standard') return 1
  if (tier === 'smart') return 2
  return 3
}

function compareScores(scores: Array<{ label: string; score: number }>): string {
  if (scores.length === 0) return 'tie'
  if (scores.length === 1) return scores[0].label

  const maxScore = Math.max(...scores.map((entry: { score: number }) => entry.score))
  const winners = scores.filter((entry: { score: number }) => entry.score === maxScore)
  return winners.length === scores.length ? 'tie' : winners.length === 1 ? winners[0].label : 'tie'
}

function formatScore(result: ModelResult | undefined): string {
  if (!result) return '—'
  return `${result.qualityScore} ${result.coherent ? '✓' : '✗'}`
}

function runCompareMode(files: string[]): void {
  const loaded = files.map((file: string) => ({ file, data: loadResultsFile(file) }))
  const labels = loaded.map(({ data }: { file: string; data: SavedResultsFile }) => data.gpuLabel)
  const rowMap = new Map<string, { model: string; tier: string; scores: Map<string, ModelResult> }>()

  for (const { data } of loaded) {
    for (const result of data.results) {
      const key = `${result.model}\u0000${result.tier}`
      const existing = rowMap.get(key) ?? { model: result.model, tier: result.tier, scores: new Map<string, ModelResult>() }
      existing.scores.set(data.gpuLabel, result)
      rowMap.set(key, existing)
    }
  }

  const rows = [...rowMap.values()].sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.model.localeCompare(b.model))
  const headers = ['MODEL', 'TIER', ...labels, 'WINNER']
  const tableRows = rows.map((row) => {
    const presentScores = labels
      .map((label: string) => {
        const result = row.scores.get(label)
        return result ? { label, score: result.qualityScore } : null
      })
      .filter((entry: { label: string; score: number } | null): entry is { label: string; score: number } => entry !== null)

    const winner = compareScores(presentScores)
    return [
      row.model,
      row.tier,
      ...labels.map((label: string) => formatScore(row.scores.get(label))),
      winner,
    ]
  })

  const widths = headers.map((header: string, index: number) =>
    Math.max(header.length, ...tableRows.map((row: string[]) => row[index].length)),
  )

  console.log(headers.map((header: string, index: number) => pad(header, widths[index])).join('  '))
  console.log(widths.map((width: number) => '─'.repeat(width)).join('  '))
  for (const row of tableRows) {
    console.log(row.map((value: string, index: number) => pad(value, widths[index])).join('  '))
  }
}

async function runQualityMode(options: CliOptions): Promise<void> {
  const routingModels = loadRoutingModels()
  const { models: availableModels } = await fetchAvailableModels(options.host, options.timeoutMs)
  const selectedModels = selectModels(routingModels, availableModels, options.models)

  if (selectedModels.length === 0) {
    const availableLocal = availableModels.filter((model: string) => !model.includes(':cloud'))
    console.error(`No matching local routed models found on ${options.host}. Routing models: ${routingModels.size}. Host models: ${availableLocal.join(', ') || '(none)'}`)
    process.exit(1)
  }

  const promptSuite = getPromptSuite(options.tier, options.mode)
  const results: ModelResult[] = []

  for (const [index, entry] of selectedModels.entries()) {
    const promptResults = await runPromptSuite(options.host, entry.model, promptSuite, options.timeoutMs, options.noThink)
    const modelResult = buildModelResult(entry.model, entry.tier, promptResults)
    results.push(modelResult)
    process.stderr.write(`[${index + 1}/${selectedModels.length}] ${entry.model} — qualityScore: ${modelResult.qualityScore}, coherent: ${modelResult.coherent ? '✓' : '✗'}\n`)
  }

  if (options.saveFile) {
    const output: SavedResultsFile = {
      timestamp: new Date().toISOString(),
      host: options.host,
      gpuLabel: options.gpuLabel,
      results,
    }
    writeFileSync(options.saveFile, JSON.stringify(output, null, 2))
  }

  const summaryHeaders = ['MODEL', 'TIER', 'QUALITY', 'COHERENT', 'FOLLOW', 'ERROR']
  const summaryRows = results
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.model.localeCompare(b.model))
    .map((result: ModelResult) => [
      result.model,
      result.tier,
      String(result.qualityScore),
      result.coherent ? '✓' : '✗',
      result.instructionFollow ? '✓' : '✗',
      result.error ?? '—',
    ])
  const widths = summaryHeaders.map((header: string, index: number) =>
    Math.max(header.length, ...summaryRows.map((row: string[]) => row[index].length)),
  )

  console.log(summaryHeaders.map((header: string, index: number) => pad(header, widths[index])).join('  '))
  console.log(widths.map((width: number) => '─'.repeat(width)).join('  '))
  for (const row of summaryRows) {
    console.log(row.map((value: string, index: number) => pad(value, widths[index])).join('  '))
  }
}

async function main(): Promise<void> {
  let options: CliOptions
  try {
    options = parseArgs(process.argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    printUsage()
    process.exit(1)
    return
  }

  if (options.help) {
    printUsage()
    process.exit(0)
    return
  }

  if (options.compareFiles.length > 0) {
    try {
      runCompareMode(options.compareFiles)
      process.exit(0)
      return
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
      return
    }
  }

  await runQualityMode(options)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
