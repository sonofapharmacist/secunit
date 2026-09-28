#!/usr/bin/env bun

// Re-score feed items that got DEFAULT_SCORE ("parse error — defaulted") due to
// backend failure (Ollama down + claude not in cron PATH on 05-14/05-15).
//
// Reads feed.jsonl, re-scores items where reason="parse error — defaulted",
// writes back atomically. Items already scored successfully are untouched.
// Auto-triage is NOT re-applied — run TLDRCatchup after to pick up newly-scored items.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const HOME = process.env.HOME ?? ""
const PAI_DIR = join(HOME, ".claude", "PAI")
const FEED_JSONL = join(PAI_DIR, "MEMORY", "STATE", "tldr-feed.jsonl")
const FEED_TMP = `${FEED_JSONL}.tmp`
const INFERENCE_PATH = join(PAI_DIR, "TOOLS", "Inference.ts")
const INFERENCE_TIMEOUT_MS = 30_000

interface FeedItem {
  id: string
  title: string
  url: string
  summary: string
  section: string
  newsletter: string
  date: string
  relevance_score: number
  reason: string
  type: string
  evaluated: boolean
  created_at: string
  kept?: boolean
  harvested?: boolean
  harvested_at?: string
}

interface ScoreResult {
  relevance_score: number
  reason: string
  type: string
}

const DEFAULT_SCORE: ScoreResult = {
  relevance_score: 2,
  reason: "parse error — defaulted",
  type: "other",
}

const ALLOWED_TYPES = new Set(["tool", "research", "news", "vulnerability", "analysis", "other"])

function parseArgs(argv: string[]): { dryRun: boolean; dates: string[]; showHelp: boolean; limit: number | null } {
  let dryRun = false
  let showHelp = false
  let limit: number | null = null
  const dates: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === "--help" || tok === "-h") { showHelp = true; continue }
    if (tok === "--dry-run") { dryRun = true; continue }
    if (tok === "--limit") {
      const v = Number(argv[++i])
      if (!Number.isInteger(v) || v < 1) { console.error("--limit requires a positive integer"); process.exit(2) }
      limit = v
      continue
    }
    if (tok === "--date") {
      const v = argv[++i]
      if (!v) { console.error("--date requires a value"); process.exit(2) }
      dates.push(v)
      continue
    }
    console.error(`unknown arg: ${tok}`)
    process.exit(2)
  }

  return { dryRun, dates, showHelp, limit }
}

function printHelp(): void {
  console.log([
    "TLDRRescore — re-score feed items that got 'parse error — defaulted'.",
    "",
    "Usage:",
    "  bun TLDRRescore.ts [--date YYYY-MM-DD] [--limit N] [--dry-run]",
    "",
    "Flags:",
    "  --date YYYY-MM-DD   Restrict to items from this date (repeat for multiple dates)",
    "  --limit N           Rescore at most N items, newest first (TLDRCatchup uses this to cap agy quota use)",
    "  --dry-run           Show what would be rescored without writing",
    "  --help, -h          Show this help",
    "",
    "After rescoring, run TLDRCatchup.ts to apply auto-triage to the newly-scored items.",
  ].join("\n"))
}

function validateScore(raw: unknown): ScoreResult {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SCORE
  const { relevance_score: score, reason, type: t } = raw as Record<string, unknown>
  if (typeof score !== "number" || !Number.isFinite(score)) return DEFAULT_SCORE
  if (score < 1 || score > 5) return DEFAULT_SCORE
  if (typeof reason !== "string" || reason.trim().length === 0) return DEFAULT_SCORE
  if (typeof t !== "string" || !ALLOWED_TYPES.has(t)) return DEFAULT_SCORE
  return { relevance_score: score, reason: reason.trim(), type: t }
}

async function scoreArticle(title: string, text: string): Promise<ScoreResult> {
  const systemPrompt =
    "You are scoring TLDR newsletter articles for relevance to a Sr. Cybersecurity Consultant who specializes in offensive security, appsec, AI security, vulnerability management, and local LLM tooling. Score concisely."
  const userPrompt =
    `Score this article 1-5 for relevance to security work and AI/LLM interests.\n` +
    `1=not relevant, 2=tangential, 3=moderately relevant, 4=highly relevant, 5=directly applicable.\n\n` +
    `Title: ${title}\n` +
    `Text: ${text.slice(0, 600)}\n\n` +
    `Return JSON only: {"relevance_score": 1-5, "reason": "10-20 words", "type": "tool|research|news|vulnerability|analysis|other"}`

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(
      ["bun", INFERENCE_PATH, "--backend", "antigravity", "--level", "fast", "--json", systemPrompt, userPrompt],
      { stdout: "pipe", stderr: "pipe" },
    )
  } catch (err) {
    return DEFAULT_SCORE
  }

  let killed = false
  const timer = setTimeout(() => {
    killed = true
    try { proc.kill() } catch { }
  }, INFERENCE_TIMEOUT_MS)

  try {
    const stream = proc.stdout as ReadableStream<Uint8Array>
    const output = await new Response(stream).text()
    await proc.exited
    if (killed) return DEFAULT_SCORE
    const trimmed = output.trim()
    if (trimmed.length === 0) return DEFAULT_SCORE
    try {
      return validateScore(JSON.parse(trimmed))
    } catch {
      const match = trimmed.match(/\{[\s\S]*\}/)
      if (match) {
        try { return validateScore(JSON.parse(match[0])) } catch { }
      }
      return DEFAULT_SCORE
    }
  } finally {
    clearTimeout(timer)
  }
}

function loadFeed(): FeedItem[] {
  if (!existsSync(FEED_JSONL)) return []
  return readFileSync(FEED_JSONL, "utf8")
    .split("\n")
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as FeedItem } catch { return null } })
    .filter((item): item is FeedItem => item !== null)
}

function saveFeedAtomic(items: FeedItem[]): void {
  const body = items.length > 0 ? `${items.map(item => JSON.stringify(item)).join("\n")}\n` : ""
  writeFileSync(FEED_TMP, body, "utf8")
  renameSync(FEED_TMP, FEED_JSONL)
}

async function main(): Promise<void> {
  if (!HOME) throw new Error("$HOME is not set")

  const args = parseArgs(process.argv.slice(2))
  if (args.showHelp) { printHelp(); return }

  const dateFilter = args.dates.length > 0 ? new Set(args.dates) : null

  const items = loadFeed()
  // The feed can hold the same id more than once (a known duplication bug), and a defaulted copy
  // may sit beside a copy that was scored fine. Only rescore ids with no successful score, and
  // keep each candidate's array index so the write-back hits that exact row, not the first id match.
  const scoredIds = new Set(items.filter(i => i.reason !== "parse error — defaulted").map(i => i.id))
  const candidates = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) =>
      item.reason === "parse error — defaulted" &&
      !scoredIds.has(item.id) &&
      (dateFilter === null || dateFilter.has(item.date))
    )
    .sort((a, b) => b.item.date.localeCompare(a.item.date))
  const toRescore = args.limit === null ? candidates : candidates.slice(0, args.limit)

  console.log(`[rescore] ${toRescore.length} items to rescore${candidates.length > toRescore.length ? ` (of ${candidates.length} defaulted; --limit ${args.limit})` : ""}${dateFilter ? ` (dates: ${[...dateFilter].join(", ")})` : ""}`)

  if (toRescore.length === 0) {
    console.log("[rescore] nothing to do")
    return
  }

  if (args.dryRun) {
    for (const { item } of toRescore) {
      console.log(`[dry-run] would rescore: ${item.date} ${item.id} — ${item.title.slice(0, 60)}`)
    }
    return
  }

  let rescored = 0
  let stillDefaulted = 0

  const updatedItems = [...items]

  // Consecutive failures mean the backend is down (e.g. AI Pro quota exhausted), not that these
  // articles are unscoreable — stop spending timeouts and leave the rest for the next run.
  const MAX_CONSECUTIVE_FAILURES = 3
  let consecutiveFailures = 0

  for (const { item, index: idx } of toRescore) {
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.log(`[rescore] ${MAX_CONSECUTIVE_FAILURES} failures in a row — backend looks down; stopping, remaining items stay defaulted for the next run`)
      break
    }
    process.stdout.write(`[rescore] ${item.date} ${item.id} "${item.title.slice(0, 50)}"... `)
    const score = await scoreArticle(item.title, item.summary)

    if (score.reason === "parse error — defaulted") {
      stillDefaulted++
      consecutiveFailures++
      console.log(`still failed (score=${score.relevance_score})`)
      continue // unchanged item keeps its marker and evaluated state; nothing to write back
    }
    consecutiveFailures = 0
    rescored++
    console.log(`${score.relevance_score}/5 — ${score.reason}`)

    // Reset evaluated so TLDRCatchup will re-triage with the new score
    updatedItems[idx] = {
      ...updatedItems[idx],
      relevance_score: score.relevance_score,
      reason: score.reason,
      type: score.type,
      evaluated: false,
      kept: undefined,
    }
  }

  saveFeedAtomic(updatedItems)

  console.log(`\n[rescore] done — ${rescored} rescored, ${stillDefaulted} still defaulted`)
  if (rescored > 0) {
    console.log("[rescore] run TLDRCatchup.ts to apply auto-triage to the rescored items")
  }
}

main().catch(err => {
  console.error(`[rescore] fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
