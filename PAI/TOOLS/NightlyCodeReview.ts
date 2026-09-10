#!/usr/bin/env bun
/**
 * NightlyCodeReview.ts - Nightly autopilot code review for Forgejo repos
 *
 * Pre-filter pipeline (inverted 2026-08-14 — see local-review-eval.jsonl history: the old
 * "local finds defects, Sonnet validates" shape produced a 7.9% confirm rate across 430 rows,
 * 381 rejects, mostly local fabricating "defects" out of trivial diffs — pattern-matching on
 * difference, not judgment about significance, which is local's weak axis). New shape: your-inference-host's
 * fast tier (jackrong_v4_pro_qwen35_9b_mtp, :11436 — distinct from prod qwen3_next_80b_a3b on
 * :11434, untouched) classifies each diff chunk yes/no for "does this touch security-relevant
 * surface" — a bounded, mechanical recall task, local's actual strength. Sonnet then runs real
 * defect-finding review on the flagged (smaller) subset directly, instead of validating a
 * firehose of local's noise. Falls back to a direct `/code-review high` Sonnet pass if the fast
 * tier is unreachable for every chunk. Report-only — never applies fixes. Pulse's code-review
 * module renders the queue.
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

// 2026-08-08: found live — this pipeline's `spawnSync("claude", ...)` calls were inheriting
// this shell's ANTHROPIC_API_KEY, which outranks CLAUDE_CODE_OAUTH_TOKEN in Anthropic's auth
// precedence and disables claude.ai connectors ("connectors are disabled because
// ANTHROPIC_API_KEY ... takes precedence over your claude.ai login"), breaking Sonnet
// validation outright. Mirrors Inference.ts's inferenceClaudeSubprocess() scrub — see that
// file for the GLM/M3 fallback-mode exception rationale, not replicated here since this is a
// non-interactive nightly job, not a shell session that could have sourced glm.sh/minimax.sh.
function claudeSubprocessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.CLAUDECODE
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

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

/** Local's classification-shaped output: does this chunk touch security-relevant surface, and
 * why. Replaces the old generative-findings LocalFinding[] contract — local is no longer asked
 * to produce findings (severity/file/line/description), only to route attention. This plays to
 * recall (bounded, mechanical presence/absence judgment) rather than significance-judgment
 * (local's weak axis, per the 7.9% confirm rate this inversion is fixing). */
interface LocalFlagResult {
  flag: boolean
  reason: string
}

/** A raw defect finding as produced by a real code-reviewing model (Sonnet, on a flagged chunk,
 * or the direct-Sonnet fallback pass) — the FINDINGS_SCHEMA shape. Named distinctly from the
 * queue's `Finding` (which adds id/repo/created_at/resolved via toFinding()). */
interface RawFinding {
  severity: "high" | "medium" | "low"
  file: string
  line: number | null
  description: string
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

/** Local's classification output schema — flag (bool) + one-line reason. Deliberately much
 * simpler than the old VALIDATION_SCHEMA it replaces: no severity, no file/line anchor, no
 * verdict enum — just "does this chunk plausibly touch security-relevant surface." */
const CLASSIFICATION_SCHEMA = {
  type: "object",
  properties: {
    flag: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["flag", "reason"],
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

// 2026-08-14: inverted this pipeline from critic to pre-filter (see header comment) and moved
// off prod (qwen3_next_80b_a3b on :11434, migration history below) onto a dedicated fast tier
// stood up the same day specifically for classification-shaped work: jackrong_v4_pro_qwen35_9b_mtp
// on :11436, 15/17 on the reasoning battery at 138 tok/s with MTP speculative decoding, 5GB — a
// distinct model+port from prod, which this pipeline no longer calls at all. Do not repoint this
// at :11434 — VRAM headroom across the your-inference-host pool is under 4GB with both tiers loaded, so this
// pipeline must keep using ONLY the fast tier, not add load to prod.
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11436"
// 2026-08-08: base URL was previously the pre-board-swap LAN IP (127.0.0.1), dead since the
// 2026-08-06 board swap moved your-inference-host to .22 — confirmed unreachable, meaning this pipeline's
// local first-pass silently fell through to the your-inference-host-unreachable/direct-Sonnet path for a
// while. Switched to the Tailscale IP (matches PAI_CONFIG.yaml ollama.base_url) since it doesn't
// depend on LAN topology surviving future hardware changes; 2026-08-14's port move to the fast
// tier (:11436) inherits that same Tailscale-IP reasoning.
const OLLAMA_MODEL = "jackrong_v4_pro_qwen35_9b_mtp" // fast-tier classifier model; override with --local-model
// Diffs are sent over HTTP (not argv) specifically to avoid E2BIG on large diffs, but the
// model's own context/output budget is still finite (n_ctx 131072, ollama backend caps
// completions at max_tokens 2048 per Inference.ts) — cap the diff text sent to the local
// pass so a huge daily diff doesn't silently starve or truncate the response.
const MAX_DIFF_CHARS_FOR_LOCAL_REVIEW = 40_000

// 2026-08-08: found live — Sonnet validation had NO cap at all, unlike the local pass above.
// A 1.95MB real diff (the 64GB-fits bench campaign's session commit — bench JSONs, TLDR
// harvest, etc.) produced an 830K-token cache-creation request and Claude returned
// is_error:true / stop_reason:"refusal" at $4.99 cost, silently failing validation with an
// unhelpful blank stderr (see claudeSubprocessEnv() history). Sonnet has far more real
// context than the local model (1M ctx per its own usage response) so this cap is 5x the
// local one, not equal — big enough that Sonnet's real advantage over local isn't wasted on
// routine diffs, small enough to stay well clear of the size that triggered the refusal.
const MAX_DIFF_CHARS_FOR_SONNET_VALIDATION = 200_000

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
  return prioritizedFileChunks(diffText).join("")
}

/** Same split-and-partition as sortDiffByPriority, but returns the ordered per-file chunks
 * instead of the joined string — chunkDiff() packs these into size-bounded groups without
 * ever splitting a single file's diff across two chunks. */
function prioritizedFileChunks(diffText: string): string[] {
  if (!diffText) return []
  const chunks = diffText.split(/(?=^diff --git )/m).filter((c) => c.length > 0)
  const isCode = (chunk: string) => {
    const headerLine = chunk.split("\n", 1)[0]
    return CODE_EXTENSIONS.some((ext) => headerLine.includes(`${ext} `) || headerLine.endsWith(ext))
  }
  const code = chunks.filter(isCode)
  const rest = chunks.filter((c) => !isCode(c))
  return [...code, ...rest]
}

/** ISC-36: named, calibration-dated cap on chunk count — not a time budget (RedTeam proved a
 * time budget makes skip behavior non-deterministic under sequential+priority-ordered
 * processing: one slow chunk starves every later chunk in that run). 12 is a first-pass
 * calibration against today's 1.95MB real diff (packs into ~6-8 chunks at 40K chars/chunk
 * before any single oversized file) — revisit if routine runs start hitting the ceiling
 * (see ObservabilityAndRegression's chunk-count logging, ISC-23/ISC-36 in the ISA).
 * Calibrated: 2026-08-08. */
const MAX_CHUNKS = 12

interface DiffChunk {
  text: string
  files: string[]
}

interface ChunkResult {
  chunks: DiffChunk[]
  skippedFiles: string[]
}

/** Extracts the file path from a `diff --git a/<path> b/<path>` header line. Falls back to the
 * raw header line if the pattern doesn't match (renames/binary diffs still get a usable label
 * even if it's not a clean path) so file-attribution logic downstream never gets an empty string. */
function extractFilePath(chunk: string): string {
  const headerLine = chunk.split("\n", 1)[0]
  const match = headerLine.match(/^diff --git a\/(.+?) b\/.+$/)
  return match ? match[1] : headerLine
}

/** ISC-1 through ISC-6, ISC-19, ISC-31, ISC-36: splits a diff into size-bounded chunks that
 * never cross a file boundary (reuses prioritizedFileChunks' existing split-on-"diff --git"
 * logic — no per-hunk splitting, per the RedTeam-tested rejection of that alternative).
 * Packs multiple small files into one chunk while they fit under maxChunkChars (ISC-3); a
 * single file already over maxChunkChars becomes its own oversized chunk rather than being
 * split mid-file (ISC-4). Priority ordering (code before docs) is applied to the WHOLE diff
 * BEFORE chunking (ISC-6), so once the maxChunks ceiling is hit, the excluded files are
 * whatever sorted last — lowest-priority by construction, not by accident. Excluded files are
 * returned in skippedFiles (ISC-5, ISC-19) rather than silently dropped. */
function chunkDiff(diffText: string, maxChunkChars: number, maxChunks: number): ChunkResult {
  const fileChunks = prioritizedFileChunks(diffText)
  const chunks: DiffChunk[] = []
  const skippedFiles: string[] = []

  let current: DiffChunk | null = null
  for (const fileChunk of fileChunks) {
    const filePath = extractFilePath(fileChunk)

    if (chunks.length >= maxChunks && current === null) {
      skippedFiles.push(filePath)
      continue
    }

    if (current === null) {
      current = { text: fileChunk, files: [filePath] }
      continue
    }

    if (current.text.length + fileChunk.length <= maxChunkChars) {
      current.text += fileChunk
      current.files.push(filePath)
      continue
    }

    chunks.push(current)
    if (chunks.length >= maxChunks) {
      current = null
      skippedFiles.push(filePath)
      continue
    }
    current = { text: fileChunk, files: [filePath] }
  }
  if (current !== null) chunks.push(current)

  return { chunks, skippedFiles }
}

/** Single HTTP call to the fast tier for one chunk's diff text. Returns null if the fast tier is
 * unreachable or returns a non-OK response — distinct from "classified, not flagged" (a real
 * `{flag: false}`), preserving ISC-35's local-failure-vs-genuinely-clean distinction under the
 * new classification contract (the old contract's "genuinely clean" was an empty findings array;
 * the new one's is a false flag — same shape of distinction, different payload).
 *
 * Prompt/contract change (2026-08-14 critic→pre-filter inversion): the old prompt asked local to
 * find and describe defects (severity/file/line/description) — a significance-judgment task,
 * local's weak axis per the 381/34/15 eval history. This prompt asks a single bounded yes/no
 * question instead — "does this chunk touch security-relevant surface" — a recall/classification
 * task the fast tier benched well on (15/17 reasoning battery). Response is a small JSON object,
 * not a findings array.
 *
 * reasoning_content handling: jackrong_v4_pro_qwen35_9b_mtp is thinking-capable and emits
 * `message.reasoning_content` alongside `message.content` even on trivial prompts (confirmed via
 * live curl probe against this exact model/endpoint before writing this parser — see the
 * task's verification evidence). `content` lands clean with only the final answer in both a
 * plain-text probe and a JSON-classification probe; `reasoning_content` is read into the type
 * below for documentation/future-debugging but deliberately never parsed for scoring — only
 * `content` feeds parseLocalClassification. */
async function callLocalModel(repoPath: string, label: string, diffText: string, localModel?: string): Promise<LocalFlagResult | null> {
  const systemPrompt =
    "You are a fast triage classifier for a code review pipeline. You are NOT judging whether " +
    "code is well-written or whether a change is a good idea — you are answering ONE bounded " +
    "question: does this diff chunk touch security-relevant surface? " +
    "Security-relevant surface means: authentication, authorization/permission checks, secrets " +
    "or credential handling, input validation, injection-prone patterns (SQL/shell/command/path), " +
    "network egress or new external calls, cryptography, or access-control logic. " +
    "Plain content edits (docs, JSON data/knowledge files, comments, formatting, tag renames, " +
    "prose rewording) are NOT security-relevant even if the wording changes meaning — flag=false. " +
    "If genuinely unsure, prefer flag=true (this is a recall task — false positives cost a Sonnet " +
    "read, false negatives skip review entirely). " +
    "Respond with ONLY a JSON object, no prose, no markdown fences."

  const userPrompt =
    `CONTEXT\n  Repo: ${label} (${repoPath})\n\n` +
    `THE DIFF (a portion of the last 24h of commits — other files are classified in separate calls)\n` +
    `\`\`\`diff\n${diffText}\n\`\`\`\n\n` +
    `Return strict JSON matching this shape:\n` +
    `{"flag": true|false, "reason": "one sentence: what security-relevant surface (if any) this chunk touches, or why it doesn't"}`

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
        temperature: 0.2,
        // 2026-08-14: found live during verification — jackrong_v4_pro_qwen35_9b_mtp burns a
        // real reasoning_content trace BEFORE emitting content, and on a real ~37K-char chunk
        // (16 files, PAI/TOOLS/*.py/.ts/.sh) a 1500-token budget hit finish_reason:"length" with
        // 7213 chars of reasoning_content and an EMPTY content field — the classification never
        // got written at all, only the scratch reasoning. This is the same class of gotcha
        // documented for deepseek-v4-pro (see AnvilProgress.ts callers / KNOWLEDGE/Research/
        // deepseek-v4-nous-research.md): thinking models need a generous budget or they return
        // nothing. 4000 gives headroom for a multi-file chunk's reasoning trace plus the small
        // JSON answer; parseLocalClassification's fail-toward-review default (flag=true) is the
        // safety net if a chunk is complex enough to still exhaust even this budget.
        max_tokens: 4000,
        // Confirmed live against this exact endpoint (:11436) before wiring in: llama-server
        // honors response_format/json_schema and returns a clean {"flag":...,"reason":...}
        // object in `content`. Belt-and-suspenders with the defensive parseLocalClassification
        // below (schema enforcement can still fail to apply if the backend/model combo changes).
        response_format: {
          type: "json_schema",
          json_schema: { name: "classification", schema: CLASSIFICATION_SCHEMA },
        },
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)
  } catch (err) {
    console.error(`[NightlyCodeReview] ${label}: fast-tier your-inference-host (${OLLAMA_BASE_URL}) unreachable: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => "<no body>")
    console.error(`[NightlyCodeReview] ${label}: fast-tier your-inference-host returned HTTP ${response.status}: ${errBody.slice(0, 500)}`)
    return null
  }

  let content: string
  try {
    // reasoning_content is typed here but intentionally unread below — jackrong_v4_pro_qwen35_9b_mtp
    // emits it alongside content on every call (confirmed via live probe), and the final
    // classification answer lands cleanly in `content` alone. Do not fall back to
    // reasoning_content if content parsing fails — that would silently score on the model's
    // scratch reasoning instead of its stated answer.
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string; reasoning_content?: string } }>
    }
    content = body.choices[0].message.content
  } catch (err) {
    console.error(`[NightlyCodeReview] ${label}: failed to parse fast-tier your-inference-host HTTP response: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  return parseLocalClassification(content, label)
}

/** ISC-37: chunk-index tagging lives in this sidecar array, parallel to the flat classification
 * result — never as a field inside LocalFlagResult itself, so that interface stays a clean,
 * minimal classification contract. `chunkIndex` on a LocalReviewOutcome entry means "this
 * chunk's own ordinal position," used later to re-attach a chunk's source text for Sonnet's
 * flagged-chunk review. */
interface LocalReviewOutcome {
  chunkIndex: number
  files: string[]
  classification: LocalFlagResult | null // null = this chunk's local call failed (ISC-35); a real result = classified either way
}

/** ISC-7 through ISC-10, ISC-33: sequential (never parallel — matches llama-server's -np 1
 * single-slot reality, no batching to exploit) local first-pass classification, one HTTP call
 * per chunk. Chunking happens first (ISC-1..6) so no individual call ever needs the old hard
 * 40K-char truncation — MAX_DIFF_CHARS_FOR_LOCAL_REVIEW now bounds a CHUNK's size, not the
 * whole diff's. Returns per-chunk outcomes (not a flat list) so ISC-35's local-failure vs
 * classified distinction survives into the chunk-selection step. */
async function runLocalReview(repoPath: string, label: string, chunks: DiffChunk[], localModel?: string): Promise<LocalReviewOutcome[]> {
  const outcomes: LocalReviewOutcome[] = []
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    console.log(`[NightlyCodeReview] ${label}: local classify chunk ${i + 1}/${chunks.length} (${chunk.files.length} file(s): ${chunk.files.slice(0, 3).join(", ")}${chunk.files.length > 3 ? ", ..." : ""})`)
    const classification = await callLocalModel(repoPath, label, chunk.text, localModel)
    if (classification === null) {
      console.error(`[NightlyCodeReview] ${label}: chunk ${i + 1}/${chunks.length} local call FAILED (not "not flagged" — the call itself did not succeed)`)
    }
    outcomes.push({ chunkIndex: i, files: chunk.files, classification })
  }
  return outcomes
}

/** Local models don't reliably honor the requested {"flag": ..., "reason": ...} shape exactly —
 * handle a bare boolean-ish field name drift ("flagged" instead of "flag") the same defensive
 * way the old parseLocalFindings handled "message" vs "description", rather than silently
 * dropping a real classification that arrived in a slightly different envelope. */
function parseLocalClassification(content: string, label: string): LocalFlagResult {
  const objectMatch = content.match(/\{[\s\S]*\}/)
  const candidates = [objectMatch?.[0], content].filter((c): c is string => typeof c === "string")

  for (const candidate of candidates) {
    let raw: unknown
    try {
      raw = JSON.parse(candidate)
    } catch {
      continue
    }
    const obj = raw as Record<string, unknown>
    const flagValue = obj.flag ?? obj.flagged
    const reasonValue = typeof obj.reason === "string" ? obj.reason : null
    if (typeof flagValue === "boolean" && reasonValue !== null) {
      return { flag: flagValue, reason: reasonValue }
    }
  }

  // Unparseable response: fail toward review, not away from it. This is a recall task — an
  // unparseable classification is exactly the ISC-35 "local call effectively failed" case in
  // spirit, but callLocalModel already returns null for transport/HTTP failures; a response that
  // came back 200 OK but didn't parse to the expected shape gets flag=true here so the chunk
  // still reaches Sonnet rather than silently falling through as "not flagged."
  console.error(`[NightlyCodeReview] ${label}: failed to parse local classification (no candidate matched the expected shape), defaulting to flag=true (fail toward review)`)
  return { flag: true, reason: "unparseable local classifier response — defaulted to flagged" }
}

/** Sonnet does real defect-finding review on ONE flagged chunk's diff text — this is no longer
 * validating someone else's candidate findings (there are none anymore; local only classified,
 * it never generated findings). Renamed from validateWithSonnet: the role changed from
 * "confirm/reject/downgrade a list" to "review this diff chunk and report defects," which is
 * exactly what runReview()'s full-repo fallback pass already does, scoped to one chunk instead
 * of the whole diff — so this reuses FINDINGS_SCHEMA (unchanged) rather than the old
 * VALIDATION_SCHEMA (removed). Prompt is piped via stdin (not argv) — diffs routinely exceed OS
 * ARG_MAX. `localReason` is the fast tier's one-line justification for flagging this chunk,
 * passed through as context — it's a routing signal, not something Sonnet needs to validate. */
function reviewFlaggedChunk(repoPath: string, label: string, chunkText: string, localReason: string): RawFinding[] | null {
  const truncated = chunkText.length > MAX_DIFF_CHARS_FOR_SONNET_VALIDATION
  const boundedDiff = truncated ? chunkText.slice(0, MAX_DIFF_CHARS_FOR_SONNET_VALIDATION) : chunkText

  // ISC-40: disclose when a single chunk (already file-bounded, already past DiffChunker)
  // still exceeds the Sonnet cap — this is the nested-truncation case Cato flagged (ISC-15):
  // an oversized-file chunk that ALSO exceeds MAX_DIFF_CHARS_FOR_SONNET_VALIDATION. Logging it
  // explicitly here (rather than silently re-truncating) is the whole point of chunking in the
  // first place — don't let the fix for the outer truncation problem reintroduce it silently
  // one level in.
  if (truncated) {
    console.error(`[NightlyCodeReview] ${label}: Sonnet review of chunk (files: ${chunkText.split(/(?=^diff --git )/m)[0]?.split("\n", 1)[0] ?? "unknown"}) was truncated — chunk exceeds MAX_DIFF_CHARS_FOR_SONNET_VALIDATION (${MAX_DIFF_CHARS_FOR_SONNET_VALIDATION}) even after file-level chunking`)
  }

  const prompt =
    `You are a senior code reviewer. This chunk was flagged by a fast local classifier as ` +
    `plausibly touching security-relevant surface (auth, secrets, input validation, permission ` +
    `checks, injection-prone patterns, credential handling, network egress). The classifier's ` +
    `job was only routing, not judgment — treat its reason as a hint about where to look, not a ` +
    `claim to confirm or refute. Do your own real review of the diff below.\n\n` +
    `REPO: ${label} (${repoPath})\n\n` +
    `LOCAL CLASSIFIER'S REASON FOR FLAGGING THIS CHUNK: ${localReason}\n\n` +
    `THE DIFF (one chunk of a larger diff — other files were reviewed in separate passes)${truncated ? " (TRUNCATED — only the first portion of this chunk is shown; do not report a finding that depends on content past the cutoff)" : ""}\n\`\`\`diff\n${boundedDiff}\n\`\`\`\n\n` +
    `OPEN and read the diff carefully before answering. Report ONLY defects you can point to ` +
    `with a file:line anchor from the diff text itself. DO NOT FABRICATE findings, function ` +
    `names, or behavior not visible in the diff. If you find nothing real, return an empty ` +
    `findings array — do not invent findings to fill space.\n\n` +
    `Return findings as strict JSON matching this shape:\n` +
    `{"findings": [{"severity": "high|medium|low", "file": "path", "line": number|null, "description": "1-2 sentence defect description with file:line anchor"}]}`

  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(
      "claude",
      ["-p", "--output-format", "json", "--json-schema", JSON.stringify(FINDINGS_SCHEMA), "--permission-mode", "default"],
      { cwd: repoPath, encoding: "utf-8", stdio: "pipe", timeout: 300_000, input: prompt, maxBuffer: GIT_DIFF_MAX_BUFFER, env: claudeSubprocessEnv() }
    )
  } catch (err) {
    console.error(`[NightlyCodeReview] ${label}: Sonnet review threw: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  if (result.status !== 0) {
    // 2026-08-08: exit !=0 here can mean either a real subprocess/auth failure (stderr
    // populated) or Claude itself returning is_error:true / stop_reason:"refusal" inside a
    // successful JSON response (stderr empty, stdout has the refusal) — check stdout too
    // when stderr is blank, since the two failure modes need different fixes.
    console.error(`[NightlyCodeReview] ${label}: Sonnet review failed (exit ${result.status}): ${result.stderr || `stdout: ${result.stdout?.slice(0, 300)}`}`)
    return null
  }

  try {
    const outer = JSON.parse(result.stdout)
    const resultText = typeof outer.result === "string" ? outer.result : result.stdout
    const parsed = JSON.parse(resultText) as { findings?: RawFinding[] }
    if (!Array.isArray(parsed.findings)) {
      console.error(`[NightlyCodeReview] ${label}: Sonnet review result has no findings array (unexpected shape)`)
      return null
    }
    return parsed.findings
  } catch (err) {
    console.error(`[NightlyCodeReview] ${label}: failed to parse Sonnet review result: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function toFinding(f: RawFinding, label: string, severityOverride?: "high" | "medium" | "low"): Finding {
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

/** ISC-39: a finding whose `file` doesn't match any file actually present in its source chunk
 * gets this sentinel instead of being silently attributed to the wrong file or the chunk's
 * first file. Chunks can hold multiple files (ISC-3's packing rule), so "which file did Sonnet
 * mean" isn't always recoverable from the finding alone. Still relevant post-inversion: Sonnet's
 * flagged-chunk review can still misattribute a finding within a multi-file chunk. */
function attributeFile(claimedFile: string, chunkFiles: string[], chunkIndex: number): string {
  return chunkFiles.includes(claimedFile) ? claimedFile : `<unattributed — see chunk ${chunkIndex}>`
}

/** Decides which chunks get a real Sonnet review. Replaces the old ISC-11..15/ISC-30
 * selectChunksForValidation: that function inspected local's findings' severities to decide
 * which candidate findings needed checking. There are no local findings anymore — the selection
 * question is now simply "did local flag this chunk as security-relevant, or did local's call
 * fail for this chunk." A failed local call still routes to Sonnet (ISC-33's resolution:
 * local failure must not silently skip a chunk) — Sonnet becomes the sole reviewer for that
 * chunk rather than leaving it completely unreviewed. Unflagged, successfully-classified chunks
 * get NO Sonnet call — this is the entire point of the inversion: Sonnet's attention is spent
 * only where local's (cheap, high-recall) classification said to look. */
function selectFlaggedChunks(outcomes: LocalReviewOutcome[]): Set<number> {
  const selected = new Set<number>()
  for (const outcome of outcomes) {
    if (outcome.classification === null) {
      selected.add(outcome.chunkIndex) // ISC-33: local failed — Sonnet is now the only reviewer for this chunk
      continue
    }
    if (outcome.classification.flag) selected.add(outcome.chunkIndex)
  }
  return selected
}

/** The merge step, rewritten for the pre-filter shape. Runs Sonnet only on flagged (or
 * failed-local) chunks, one spawnSync per chunk, sequential — and Sonnet's own real findings
 * on that chunk ARE the result; there is no confirm/reject/downgrade/additional split anymore
 * because there is nothing local produced to confirm or reject. Unflagged chunks contribute
 * zero findings and never touch Sonnet at all. Still returns the same `{confirmed: Finding[]}`-
 * shaped envelope main() already knows how to write to the queue (a lone `confirmed` list now,
 * `additional` dropped — there's no longer a distinct "local said X, Sonnet added Y" split to
 * preserve). */
function reviewChunks(
  repoPath: string,
  label: string,
  chunks: DiffChunk[],
  outcomes: LocalReviewOutcome[],
  dryRun: boolean
): { confirmed: Finding[] } {
  const flagged = selectFlaggedChunks(outcomes)
  console.log(`[NightlyCodeReview] ${label}: ${outcomes.length} chunk(s) classified locally, ${flagged.size} flagged for Sonnet review (security-relevant-surface flags plus any failed-local chunks)`)

  const confirmed: Finding[] = []

  for (const outcome of outcomes) {
    const chunk = chunks[outcome.chunkIndex]

    if (!flagged.has(outcome.chunkIndex)) {
      // Not flagged, local call succeeded: no Sonnet call, zero findings, one eval row logging
      // the classification itself so the flag-rate can be measured (this IS the pre-filter's
      // whole reason for existing — an unflagged chunk isn't "nothing happened," it's the local
      // pass doing its job).
      appendEvalRow(label, outcome.chunkIndex, chunk.files, outcome.classification, 0, dryRun)
      continue
    }

    const reasonForLog = outcome.classification?.reason ?? "local call FAILED for this chunk — Sonnet is the sole reviewer"
    console.log(`[NightlyCodeReview] ${label}: reviewing chunk ${outcome.chunkIndex + 1}/${chunks.length} with Sonnet (reason: ${reasonForLog})`)
    const findings = reviewFlaggedChunk(repoPath, label, chunk.text, reasonForLog)

    if (findings === null) {
      // Both local (maybe) and Sonnet failed for this chunk — genuinely zero review coverage
      // this cycle. Nothing to silently drop (unlike the old confirm/reject shape, local never
      // produced candidate findings to lose) — just log it loudly so the gap is visible rather
      // than indistinguishable from "reviewed, found nothing."
      console.error(`[NightlyCodeReview] ${label}: chunk ${outcome.chunkIndex + 1}/${chunks.length}: Sonnet review FAILED${outcome.classification === null ? " AND local had already failed — this chunk received NO review this cycle" : ""}`)
      appendEvalRow(label, outcome.chunkIndex, chunk.files, outcome.classification, null, dryRun)
      continue
    }

    appendEvalRow(label, outcome.chunkIndex, chunk.files, outcome.classification, findings.length, dryRun)

    for (const f of findings) {
      const attributedFile = attributeFile(f.file, chunk.files, outcome.chunkIndex)
      confirmed.push(toFinding({ ...f, file: attributedFile }, label))
    }
  }

  return { confirmed }
}

/** Eval-log row for the pre-filter pipeline shape. Replaces the old finding/verdict row (which
 * logged local's candidate finding + Sonnet's confirm/reject/downgrade verdict on it) with a
 * chunk/flag/reason + Sonnet's actual finding count on that chunk. This is the same measurability
 * discipline the old appendEvalRows existed for — the 381/34/15 breakdown that surfaced the 7.9%
 * confirm rate came from reading this file, and a future session needs the equivalent instrument
 * for the new shape: how often local flags (recall), and when it does, how many real findings
 * Sonnet actually reports on that chunk (precision of the routing, not of a judgment call).
 * `sonnetFindingCount` is null when this chunk was flagged/failed-local but Sonnet's own call
 * then failed too (no measurement possible, distinct from "Sonnet measured zero findings"). */
function appendEvalRow(
  label: string,
  chunkIndex: number,
  files: string[],
  classification: LocalFlagResult | null,
  sonnetFindingCount: number | null,
  dryRun = false
): void {
  const row = {
    repo: label,
    chunk_index: chunkIndex,
    files,
    local_call_failed: classification === null,
    flagged: classification?.flag ?? null,
    reason: classification?.reason ?? "local call failed for this chunk",
    sonnet_finding_count: sonnetFindingCount,
    created_at: new Date().toISOString(),
  }
  if (dryRun) {
    // In dry-run, emit the same eval rows to stdout so the operator can compare runs.
    console.log(JSON.stringify(row))
    return
  }
  mkdirSync(dirname(EVAL_PATH), { recursive: true })
  appendFileSync(EVAL_PATH, JSON.stringify(row) + "\n")
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
    { cwd: repoPath, encoding: "utf-8", stdio: "pipe", timeout: 600_000, env: claudeSubprocessEnv() }
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

  // DiffChunker (ISC-1..6, ISC-19, ISC-31, ISC-36): split the whole diff into file-bounded,
  // size-bounded chunks BEFORE any model sees it. Replaces the old single-shot 40K-char hard
  // truncation — MAX_DIFF_CHARS_FOR_LOCAL_REVIEW now bounds a chunk's size, not the whole diff.
  const { chunks, skippedFiles } = chunkDiff(diffText, MAX_DIFF_CHARS_FOR_LOCAL_REVIEW, MAX_CHUNKS)
  console.log(`[NightlyCodeReview] ${label}: diff split into ${chunks.length} chunk(s) (cap ${MAX_CHUNKS})${skippedFiles.length > 0 ? `, ${skippedFiles.length} file(s) SKIPPED (chunk-count ceiling reached — lowest priority by construction): ${skippedFiles.join(", ")}` : ""}`)

  if (chunks.length === 0) {
    console.log(`[NightlyCodeReview] ${label}: diff produced zero chunks (empty diff after noise exclusion), skipping`)
    return
  }

  console.log(`[NightlyCodeReview] ${label}: running local pre-filter classification (fast-tier your-inference-host, model=${localModel ?? OLLAMA_MODEL}, sequential, ${chunks.length} chunk(s)${dryRun ? ", DRY-RUN" : ""})`)
  const outcomes = await runLocalReview(repoPath, label, chunks, localModel)

  const allChunksFailed = outcomes.every((o) => o.classification === null)
  if (allChunksFailed) {
    console.error(`[NightlyCodeReview] ${label}: fast-tier your-inference-host unreachable for ALL chunks, falling back to direct Sonnet review`)
    const findings = runReview(repoPath, label)
    if (findings.length === 0) {
      console.error(`[NightlyCodeReview] ${label}: FALLBACK REVIEW PRODUCED NO FINDINGS — verify this is a genuinely clean diff, not a second failure (check stderr above for a runReview error)`)
    }
    appendFindings(findings)
    console.log(`[NightlyCodeReview] ${label}: ${findings.length} findings written (fallback path)`)
    return
  }

  const flaggedCount = outcomes.filter((o) => o.classification?.flag).length
  const failedCount = outcomes.filter((o) => o.classification === null).length
  console.log(`[NightlyCodeReview] ${label}: local classification complete — ${flaggedCount}/${outcomes.length} chunk(s) flagged as security-relevant${failedCount > 0 ? `, ${failedCount} chunk(s) had a FAILED local call (routed to Sonnet regardless)` : ""}`)

  // PreFilterReview: Sonnet reviews only flagged (or failed-local) chunks directly for real
  // defects — no confirm/reject/downgrade merge step anymore, Sonnet's own findings on the
  // flagged subset ARE the result.
  const { confirmed } = reviewChunks(repoPath, label, chunks, outcomes, dryRun)

  appendFindings(confirmed, dryRun)
  console.log(`[NightlyCodeReview] ${label}: ${confirmed.length} findings ${dryRun ? "would be written" : "written"} (from Sonnet review of ${flaggedCount + failedCount} flagged/failed-local chunk(s) out of ${outcomes.length} total)`)
}

main().catch((err) => {
  console.error(`[NightlyCodeReview] unhandled error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
