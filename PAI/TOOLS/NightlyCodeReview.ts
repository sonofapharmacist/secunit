#!/usr/bin/env bun
/**
 * NightlyCodeReview.ts - Nightly autopilot code review for Forgejo repos
 *
 * Local-first-pass pipeline: your-inference-host (qwen3:30b-a3b) reviews the 24h diff for
 * free, then Sonnet validates each local finding (confirm/reject/downgrade)
 * before anything reaches the queue. Falls back to a direct `/code-review high`
 * Sonnet pass if your-inference-host is unreachable. Report-only — never applies fixes.
 * Pulse's code-review module renders the queue.
 *
 * Usage:
 *   bun ~/.claude/PAI/TOOLS/NightlyCodeReview.ts --repo ${HOME}/.claude --label pai-config
 *   bun ~/.claude/PAI/TOOLS/NightlyCodeReview.ts --resolve <finding-id>
 */

import { spawnSync } from "child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { randomUUID } from "crypto"

const HOME = process.env.HOME ?? ""
const QUEUE_PATH = join(HOME, ".claude", "PAI", "MEMORY", "STATE", "code-review-queue.jsonl")
const EVAL_PATH = join(HOME, ".claude", "PAI", "MEMORY", "STATE", "local-review-eval.jsonl")
const INFERENCE_TOOL = join(HOME, ".claude", "PAI", "TOOLS", "Inference.ts")

interface Finding {
  id: string
  repo: string
  severity: "high" | "medium" | "low"
  file: string
  line: number | null
  description: string
  created_at: string
  resolved: boolean
}

interface LocalFinding {
  severity: "high" | "medium" | "low"
  file: string
  line: number | null
  description: string
}

type Verdict = "confirm" | "reject" | "downgrade"

interface ValidationVerdict {
  index: number
  verdict: Verdict
  reason: string
  downgraded_severity?: "high" | "medium" | "low" | null
}

interface ValidationResult {
  verdicts: ValidationVerdict[]
  additional_findings: LocalFinding[]
}

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          file: { type: "string" },
          line: { type: ["number", "null"] },
          description: { type: "string" },
        },
        required: ["severity", "file", "description"],
      },
    },
  },
  required: ["findings"],
}

const VALIDATION_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "number" },
          verdict: { type: "string", enum: ["confirm", "reject", "downgrade"] },
          reason: { type: "string" },
          downgraded_severity: { type: ["string", "null"], enum: ["high", "medium", "low", null] },
        },
        required: ["index", "verdict", "reason"],
      },
    },
    additional_findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          file: { type: "string" },
          line: { type: ["number", "null"] },
          description: { type: "string" },
        },
        required: ["severity", "file", "description"],
      },
    },
  },
  required: ["verdicts", "additional_findings"],
}

// Applied to every plain `git` spawnSync in this file — none of these normally take more than
// a few hundred ms, so a hang means something is actually stuck (lock contention, network
// filesystem), not a slow-but-legitimate diff. Only the `claude` CLI calls get long timeouts
// (300s/600s) since those genuinely can take that long.
const GIT_SPAWN_TIMEOUT_MS = 30_000

function hadCommitsInLast24h(repoPath: string): boolean {
  const result = spawnSync("git", ["-C", repoPath, "log", "--since=24.hours", "--oneline"], {
    encoding: "utf-8",
    stdio: "pipe",
    timeout: GIT_SPAWN_TIMEOUT_MS,
  })
  return result.status === 0 && result.stdout.trim().length > 0
}

const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

// Auto-generated state/log paths that dominate diffs numerically but carry zero review
// value (timestamps, cron sentinels, benchmark result dumps, diary/growth logs). Excluded
// via pathspec so MAX_DIFF_CHARS_FOR_LOCAL_REVIEW's budget goes to actual code/config —
// found live 2026-07-06 when a 977KB diff's first 40K chars (alphabetical order) were
// entirely ".last-cleanup"/".last-update-result.json" noise and the local pass never saw
// a single real code change.
const DIFF_NOISE_EXCLUDES = [
  ":(exclude).last-cleanup",
  ":(exclude).last-update-result.json",
  ":(exclude)**/state/**",
  ":(exclude)**/*.jsonl",
  ":(exclude)**/results-*.json",
  ":(exclude)**/reasoning-probe-*.json",
  ":(exclude)**/_arch-state.json",
  ":(exclude)**/Performance/aggregator-state.json",
]

/** Returns the diff text, or null if diff computation itself failed (distinct from a genuinely empty diff). */
function getDiffText(repoPath: string): string | null {
  const firstCommit = spawnSync(
    "git",
    ["-C", repoPath, "log", "--since=24.hours", "--reverse", "--format=%H"],
    { encoding: "utf-8", stdio: "pipe", timeout: GIT_SPAWN_TIMEOUT_MS }
  )
  if (firstCommit.status !== 0) return null
  const oldestHash = firstCommit.stdout.trim().split("\n")[0]
  if (!oldestHash) return ""

  // Root-commit case: oldestHash^ doesn't exist. Diff against the empty tree instead
  // so the oldest commit's own content is included rather than silently dropped.
  const parentCheck = spawnSync("git", ["-C", repoPath, "rev-parse", "--verify", `${oldestHash}^`], {
    encoding: "utf-8",
    stdio: "pipe",
    timeout: GIT_SPAWN_TIMEOUT_MS,
  })
  const base = parentCheck.status === 0 ? `${oldestHash}^` : EMPTY_TREE_HASH

  return runGitDiff(repoPath, base)
}

/** --full mode: diffs the whole tracked tree against the empty tree, ignoring commit history
 * entirely. For a one-off manual review of a repo with no recent commits (e.g. dinenasty,
 * last commit 4 days old) where the nightly 24h-window gate would otherwise skip it. */
function getFullTreeDiff(repoPath: string): string | null {
  return runGitDiff(repoPath, EMPTY_TREE_HASH)
}

// Default spawnSync maxBuffer (~1MB) throws ENOBUFS on any repo diff larger than that — found
// live 2026-07-06 on dinenasty's 3.1MB --full diff (84 files). ENOBUFS is a thrown error, not a
// non-zero exit status, so the old `diff.status === 0 ? diff.stdout : null` pattern never even
// ran — it was caught by main()'s outer .catch() instead, several layers removed from the real
// cause. Wrapping in try/catch here keeps the null-on-failure contract intact and preserves the
// actual error for the caller to log.
const GIT_DIFF_MAX_BUFFER = 64 * 1024 * 1024 // 64MB — comfortably above any realistic repo diff

function runGitDiff(repoPath: string, base: string): string | null {
  try {
    const diff = spawnSync(
      "git",
      ["-C", repoPath, "diff", base, "HEAD", "--", ".", ...DIFF_NOISE_EXCLUDES],
      { encoding: "utf-8", stdio: "pipe", maxBuffer: GIT_DIFF_MAX_BUFFER, timeout: GIT_SPAWN_TIMEOUT_MS }
    )
    return diff.status === 0 ? diff.stdout : null
  } catch (err) {
    console.error(`[NightlyCodeReview] git diff failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

const OLLAMA_BASE_URL = "http://127.0.0.1:11434"
const OLLAMA_MODEL = "qwen3:30b-a3b" // default local model; override with --local-model
// Diffs are sent over HTTP (not argv) specifically to avoid E2BIG on large diffs, but the
// model's own context/output budget is still finite (n_ctx 131072, ollama backend caps
// completions at max_tokens 2048 per Inference.ts) — cap the diff text sent to the local
// pass so a huge daily diff doesn't silently starve or truncate the response.
const MAX_DIFF_CHARS_FOR_LOCAL_REVIEW = 40_000

const CODE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".rb", ".java", ".c", ".cpp", ".h",
  ".hpp", ".sh", ".bash", ".sql", ".swift", ".kt",
]

/** Reorders per-file diff chunks so code files come before docs/config/data before truncation.
 * `git diff` output is alphabetical by path — on a real repo that means docs (DOCUMENTATION/,
 * MEMORY/) sort before code (PAI/TOOLS/, hooks/) and eat the entire truncation budget, so the
 * local pass reviews nothing but prose. Found live 2026-07-06: a 906KB diff's first 40K chars
 * were 11 markdown files, while the session's actual 369-line .ts changes sat un-reviewed past
 * the cutoff. Splitting on "diff --git" markers and partitioning by extension fixes this
 * regardless of alphabetical path order or diff size. */
function sortDiffByPriority(diffText: string): string {
  if (!diffText) return diffText
  const chunks = diffText.split(/(?=^diff --git )/m).filter((c) => c.length > 0)
  const isCode = (chunk: string) => {
    const headerLine = chunk.split("\n", 1)[0]
    return CODE_EXTENSIONS.some((ext) => headerLine.includes(`${ext} `) || headerLine.endsWith(ext))
  }
  const code = chunks.filter(isCode)
  const rest = chunks.filter((c) => !isCode(c))
  return [...code, ...rest].join("")
}

/** Local first-pass review via your-inference-host (qwen3:30b-a3b), called directly over HTTP to avoid
 * ARG_MAX limits that break passing large diffs as CLI positional args (Inference.ts's own
 * CLI only accepts prompts as argv). Returns null if your-inference-host is unreachable. */
async function runLocalReview(repoPath: string, label: string, diffText: string, localModel?: string): Promise<LocalFinding[] | null> {
  const prioritized = sortDiffByPriority(diffText)
  const truncated = prioritized.length > MAX_DIFF_CHARS_FOR_LOCAL_REVIEW
  const boundedDiff = truncated ? prioritized.slice(0, MAX_DIFF_CHARS_FOR_LOCAL_REVIEW) : prioritized

  const systemPrompt =
    "You are a senior code reviewer. OPEN and read the diff carefully before answering. " +
    "Report ONLY defects you can point to with a file:line anchor from the diff text itself. " +
    "DO NOT FABRICATE findings, function names, or behavior not visible in the diff. " +
    "If you find nothing real, return an empty findings array — do not invent findings to fill space. " +
    "Respond with ONLY a JSON object, no prose, no markdown fences."

  const userPrompt =
    `CONTEXT\n  Repo: ${label} (${repoPath})\n\n` +
    `THE DIFF (last 24h of commits${truncated ? ", TRUNCATED — only the first portion is shown, do not report on files past the cutoff" : ""})\n` +
    `\`\`\`diff\n${boundedDiff}\n\`\`\`\n\n` +
    `Return findings as strict JSON matching this shape:\n` +
    `{"findings": [{"severity": "high|medium|low", "file": "path", "line": number|null, "description": "1-2 sentence defect description with file:line anchor"}]}`

  let response: Response
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: localModel ?? OLLAMA_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 5000,
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)
  } catch (err) {
    console.error(`[NightlyCodeReview] ${label}: your-inference-host unreachable: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => "<no body>")
    console.error(`[NightlyCodeReview] ${label}: your-inference-host returned HTTP ${response.status}: ${errBody.slice(0, 500)}`)
    return null
  }

  let content: string
  try {
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> }
    content = body.choices[0].message.content
  } catch (err) {
    console.error(`[NightlyCodeReview] ${label}: failed to parse your-inference-host HTTP response: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  return parseLocalFindings(content, label)
}

/** Extracts a findings array from a parsed JSON value, or null if the shape doesn't match
 * either the documented {"findings": [...]} contract or a bare top-level array. A single
 * finding object (e.g. `{"severity": ..., "file": ...}` with no "findings" key) is neither —
 * it must not be treated as "zero findings" via a silent empty-array fallback, since that's
 * indistinguishable from a genuinely empty result and masks the real cause (wrong shape). */
function extractFindingsArray(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw
  if (Array.isArray((raw as { findings?: unknown[] })?.findings)) {
    return (raw as { findings: unknown[] }).findings
  }
  return null
}

/** Local models don't reliably honor the requested {"findings": [...]} shape — some return a bare
 * JSON array, and some use "message" instead of "description". Handle both rather than silently
 * dropping real findings that arrived in a slightly different envelope. */
function parseLocalFindings(content: string, label: string): LocalFinding[] {
  const objectMatch = content.match(/\{[\s\S]*\}/)
  const arrayMatch = content.match(/\[[\s\S]*\]/)
  // Both regexes are greedy, and each can match a region that parses as valid JSON but is the
  // WRONG shape — e.g. objectMatch on `[{"severity":...}]` captures just the inner object (a
  // single finding, not a {findings:[...]} envelope), which used to silently resolve to zero
  // findings instead of falling through to the array candidate that actually holds them.
  // Fix: try every candidate, and among the ones that parse AND yield a real findings array
  // (extractFindingsArray returns non-null), prefer object-shaped candidates first since
  // {"findings": [...]} is the documented contract — but don't stop at the first candidate
  // that merely parses if it doesn't actually resolve to a findings array.
  const candidates = [objectMatch?.[0], arrayMatch?.[0], content].filter(
    (c): c is string => typeof c === "string"
  )

  let rawFindings: unknown[] | null = null
  for (const candidate of candidates) {
    let raw: unknown
    try {
      raw = JSON.parse(candidate)
    } catch {
      continue
    }
    const extracted = extractFindingsArray(raw)
    if (extracted !== null) {
      rawFindings = extracted
      break
    }
  }
  if (rawFindings === null) {
    console.error(`[NightlyCodeReview] ${label}: failed to parse local findings (no candidate matched the expected shape), treating as zero findings`)
    return []
  }

  return rawFindings
    .map((item) => {
      const f = item as Record<string, unknown>
      const description = typeof f.description === "string" ? f.description : typeof f.message === "string" ? f.message : null
      const file = typeof f.file === "string" ? f.file : null
      if (!description || !file) return null
      const severity = f.severity === "high" || f.severity === "medium" || f.severity === "low" ? f.severity : "low"
      const line = typeof f.line === "number" ? f.line : null
      return { severity, file, line, description } as LocalFinding
    })
    .filter((f): f is LocalFinding => f !== null)
}

/** Sonnet validates each local finding (confirm/reject/downgrade) and may add new findings. Scoped prompt — NOT a full /code-review high pass.
 * Prompt is piped via stdin (not argv) — diffs routinely exceed OS ARG_MAX. */
function validateWithSonnet(repoPath: string, label: string, diffText: string, localFindings: LocalFinding[]): ValidationResult | null {
  const prompt =
    `You are validating a local model's code-review findings against the actual diff. Be skeptical — local models frequently fabricate findings that don't match the real code.\n\n` +
    `REPO: ${label} (${repoPath})\n\n` +
    `THE DIFF\n\`\`\`diff\n${diffText}\n\`\`\`\n\n` +
    `LOCAL MODEL'S CANDIDATE FINDINGS (0-indexed)\n${JSON.stringify(localFindings, null, 2)}\n\n` +
    `For EACH local finding, verify it against the diff and return a verdict: "confirm" (real defect, keep severity), ` +
    `"reject" (fabricated or not a real issue), or "downgrade" (real but less severe — include downgraded_severity). ` +
    `Give a one-sentence reason for each verdict. ` +
    `Separately, if you spot additional real defects in the diff that the local model missed, list them in additional_findings.`

  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(
      "claude",
      ["-p", "--output-format", "json", "--json-schema", JSON.stringify(VALIDATION_SCHEMA), "--permission-mode", "default"],
      { cwd: repoPath, encoding: "utf-8", stdio: "pipe", timeout: 300_000, input: prompt, maxBuffer: GIT_DIFF_MAX_BUFFER }
    )
  } catch (err) {
    console.error(`[NightlyCodeReview] ${label}: Sonnet validation threw: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  if (result.status !== 0) {
    console.error(`[NightlyCodeReview] ${label}: Sonnet validation failed (exit ${result.status}): ${result.stderr}`)
    return null
  }

  try {
    const outer = JSON.parse(result.stdout)
    const resultText = typeof outer.result === "string" ? outer.result : result.stdout
    return JSON.parse(resultText) as ValidationResult
  } catch (err) {
    console.error(`[NightlyCodeReview] ${label}: failed to parse validation result: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function toFinding(f: LocalFinding, label: string, severityOverride?: "high" | "medium" | "low"): Finding {
  return {
    id: randomUUID(),
    repo: label,
    severity: severityOverride ?? f.severity,
    file: f.file,
    line: f.line ?? null,
    description: f.description,
    created_at: new Date().toISOString(),
    resolved: false,
  }
}

function appendEvalRows(label: string, localFindings: LocalFinding[], verdicts: ValidationVerdict[], dryRun = false): void {
  if (dryRun) {
    // In dry-run, emit the same eval rows to stdout so the operator can compare runs.
    if (localFindings.length === 0) return
    const verdictByIndex = new Map(verdicts.map((v) => [v.index, v]))
    for (let i = 0; i < localFindings.length; i++) {
      const v = verdictByIndex.get(i)
      console.log(JSON.stringify({
        repo: label,
        local_finding: localFindings[i],
        verdict: v?.verdict ?? "reject",
        reason: v?.reason ?? "no verdict returned",
      }))
    }
    return
  }
  if (localFindings.length === 0) return
  mkdirSync(dirname(EVAL_PATH), { recursive: true })
  const verdictByIndex = new Map(verdicts.map((v) => [v.index, v]))
  const rows = localFindings.map((finding, index) => {
    const v = verdictByIndex.get(index)
    return JSON.stringify({
      repo: label,
      local_finding: finding,
      verdict: v?.verdict ?? "reject",
      reason: v?.reason ?? "no verdict returned by Sonnet — treated as reject",
      created_at: new Date().toISOString(),
    })
  })
  appendFileSync(EVAL_PATH, rows.join("\n") + "\n")
}

function runReview(repoPath: string, label: string): Finding[] {
  const result = spawnSync(
    "claude",
    [
      "-p",
      "/code-review high",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(FINDINGS_SCHEMA),
      "--permission-mode",
      "default",
    ],
    { cwd: repoPath, encoding: "utf-8", stdio: "pipe", timeout: 600_000 }
  )

  if (result.status !== 0) {
    console.error(`[NightlyCodeReview] ${label} review failed (exit ${result.status}): ${result.stderr}`)
    return []
  }

  let parsed: { findings: Array<{ severity: string; file: string; line?: number; description: string }> }
  try {
    const outer = JSON.parse(result.stdout)
    const resultText = typeof outer.result === "string" ? outer.result : result.stdout
    parsed = JSON.parse(resultText)
  } catch (err) {
    console.error(`[NightlyCodeReview] ${label} failed to parse findings: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }

  // Guard the shape, not just the parse — if a future CLI version ever returns findings at
  // the top level instead of wrapped in `.result`, JSON.parse above still succeeds (it parses
  // *something*), but parsed.findings would be undefined and .map() would throw uncaught,
  // outside the try/catch, killing the whole nightly run for this repo instead of just
  // logging and skipping it.
  if (!Array.isArray(parsed.findings)) {
    console.error(`[NightlyCodeReview] ${label}: parsed result has no findings array (unexpected CLI output shape), skipping`)
    return []
  }

  return parsed.findings.map((f) => ({
    id: randomUUID(),
    repo: label,
    severity: f.severity as Finding["severity"],
    file: f.file,
    line: f.line ?? null,
    description: f.description,
    created_at: new Date().toISOString(),
    resolved: false,
  }))
}

function appendFindings(findings: Finding[], dryRun = false): void {
  if (dryRun) {
    console.log(`[NightlyCodeReview] DRY-RUN: would have appended ${findings.length} findings to ${QUEUE_PATH}`)
    return
  }
  if (findings.length === 0) return
  mkdirSync(dirname(QUEUE_PATH), { recursive: true })
  const lines = findings.map((f) => JSON.stringify(f)).join("\n") + "\n"
  appendFileSync(QUEUE_PATH, lines)
}

function resolveFinding(id: string): void {
  if (!existsSync(QUEUE_PATH)) {
    console.error("[NightlyCodeReview] queue file does not exist")
    return
  }
  const lines = readFileSync(QUEUE_PATH, "utf-8").trim().split("\n").filter(Boolean)
  const updated = lines.map((line) => {
    const finding: Finding = JSON.parse(line)
    if (finding.id === id) finding.resolved = true
    return JSON.stringify(finding)
  })
  writeFileSync(QUEUE_PATH, updated.join("\n") + "\n")
}

// A flag's value slot is missing (undefined) or actually holds another flag (e.g.
// `--repo --label x`, where the intended value was omitted). Either way it's a usage
// mistake, not a valid value — reject it here instead of letting `undefined` or a
// stray "--label" string flow into git/spawnSync as a literal, confusing argv entry.
function requireFlagValue(args: string[], flagIdx: number, flagName: string): string {
  const value = args[flagIdx + 1]
  if (value === undefined || value.startsWith("--")) {
    console.error(`Usage error: ${flagName} requires a value`)
    process.exit(1)
  }
  return value
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  const resolveIdx = args.indexOf("--resolve")
  if (resolveIdx !== -1) {
    resolveFinding(requireFlagValue(args, resolveIdx, "--resolve"))
    return
  }

  const repoIdx = args.indexOf("--repo")
  const labelIdx = args.indexOf("--label")
  const full = args.includes("--full")
  const dryRun = args.includes("--dry-run")
  const localModelIdx = args.indexOf("--local-model")
  if (repoIdx === -1 || labelIdx === -1) {
    console.error(
      "Usage: NightlyCodeReview.ts --repo <path> --label <name> [--full] [--dry-run] [--local-model <alias>]",
    )
    process.exit(1)
  }
  const repoPath = requireFlagValue(args, repoIdx, "--repo")
  const label = requireFlagValue(args, labelIdx, "--label")
  const localModel = localModelIdx !== -1 ? requireFlagValue(args, localModelIdx, "--local-model") : undefined

  // --full is a one-off manual-invocation escape hatch: review the whole tracked tree against
  // the empty-tree base instead of the last-24h diff. Does not change nightly-cron behavior —
  // the 24h gate and getDiffText's incremental diff are untouched for the default path.
  if (!full && !hadCommitsInLast24h(repoPath)) {
    console.log(`[NightlyCodeReview] ${label}: no commits in last 24h, skipping`)
    return
  }

  const diffText = full ? getFullTreeDiff(repoPath) : getDiffText(repoPath)

  if (diffText === null) {
    console.error(`[NightlyCodeReview] ${label}: DIFF COMPUTATION FAILED — cannot review, this is a tooling failure, not a clean diff. Skipping without writing to the queue.`)
    process.exitCode = 1
    return
  }

  console.log(`[NightlyCodeReview] ${label}: running local first-pass review (your-inference-host, model=${localModel ?? OLLAMA_MODEL}${dryRun ? ", DRY-RUN" : ""})`)
  const localFindings = await runLocalReview(repoPath, label, diffText, localModel)

  if (localFindings === null) {
    console.error(`[NightlyCodeReview] ${label}: your-inference-host unreachable, falling back to direct Sonnet review`)
    const findings = runReview(repoPath, label)
    if (findings.length === 0) {
      console.error(`[NightlyCodeReview] ${label}: FALLBACK REVIEW PRODUCED NO FINDINGS — verify this is a genuinely clean diff, not a second failure (check stderr above for a runReview error)`)
    }
    appendFindings(findings)
    console.log(`[NightlyCodeReview] ${label}: ${findings.length} findings written (fallback path)`)
    return
  }

  if (localFindings.length === 0) {
    console.log(`[NightlyCodeReview] ${label}: local pass found nothing to validate, skipping Sonnet validation`)
    return
  }

  console.log(`[NightlyCodeReview] ${label}: validating ${localFindings.length} local findings with Sonnet`)
  const validation = validateWithSonnet(repoPath, label, diffText, localFindings)

  if (validation === null) {
    console.error(`[NightlyCodeReview] ${label}: BOTH local review parsing succeeded AND Sonnet validation failed — local findings are UNVALIDATED and will NOT be written to the queue. This repo's review did not complete this cycle.`)
    process.exitCode = 1
    return
  }

  appendEvalRows(label, localFindings, validation.verdicts, dryRun)

  const verdictByIndex = new Map(validation.verdicts.map((v) => [v.index, v]))
  const confirmed: Finding[] = []
  localFindings.forEach((finding, index) => {
    const v = verdictByIndex.get(index)
    if (!v || v.verdict === "reject") return
    if (v.verdict === "confirm") confirmed.push(toFinding(finding, label))
    if (v.verdict === "downgrade") {
      const fallbackSeverity = finding.severity === "high" ? "medium" : "low"
      confirmed.push(toFinding(finding, label, v.downgraded_severity ?? fallbackSeverity))
    }
  })
  const additional = validation.additional_findings.map((f) => toFinding(f, label))

  const finalFindings = [...confirmed, ...additional]
  appendFindings(finalFindings, dryRun)
  console.log(`[NightlyCodeReview] ${label}: ${finalFindings.length} findings ${dryRun ? "would be written" : "written"} (${confirmed.length} confirmed/downgraded, ${additional.length} added by Sonnet)`)
}

main().catch((err) => {
  console.error(`[NightlyCodeReview] unhandled error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
