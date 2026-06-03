#!/usr/bin/env bun

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const HOME = process.env.HOME ?? ""
const PAI_DIR = join(HOME, ".claude", "PAI")
const FEED_JSONL = join(PAI_DIR, "MEMORY", "STATE", "tldr-feed.jsonl")
const FEED_TMP = `${FEED_JSONL}.tmp`
const TOOLS_DIR = join(PAI_DIR, "TOOLS")
const SCRAPER = join(TOOLS_DIR, "TLDRScraper.ts")
const HARVEST = join(TOOLS_DIR, "TLDRHarvest.ts")
const SURFACE = join(TOOLS_DIR, "TLDRSurface.ts")
const PULSE_URL = "http://localhost:31337/notify"

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

interface CliArgs {
  minScore: number
  windowDays: number
  dryRun: boolean
  showHelp: boolean
}

interface FeedDateInfo {
  dates: Set<string>
  lastDate: string | null
}

interface AutoTriageResult {
  items: FeedItem[]
  autoTriagedCount: number
  keptCount: number
  skippedCount: number
}

function todayInChicago(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" })
}

function printHelp(): void {
  const lines = [
    "TLDRCatchup — automate TLDR backfill, triage, harvest, surface, and Pulse notify.",
    "",
    "Usage:",
    "  bun TLDRCatchup.ts [flags]",
    "",
    "Flags:",
    "  --min-score N      Auto-keep threshold for relevance_score (1-5, default: 4)",
    "  --window-days N    Surface entries from last N days (positive integer, default: 3)",
    "  --dry-run          Log planned actions without subprocess side effects, writes, or Pulse POST",
    "  --help, -h         Show this help and exit",
    "",
    `Feed: ${FEED_JSONL}`,
  ]
  console.log(lines.join("\n"))
}

function exitUsageError(message: string): never {
  console.error(`[catchup] ${message}`)
  process.exit(2)
}

function readFlagValue(argv: string[], index: number, flag: "--min-score" | "--window-days"): string {
  const value = argv[index + 1]
  if (value === undefined || value === "--help" || value === "-h" || value.startsWith("--")) {
    exitUsageError(`${flag} requires a value`)
  }
  return value
}

function parseInteger(value: string, flag: "--min-score" | "--window-days"): number {
  if (!/^-?\d+$/.test(value)) {
    exitUsageError(`${flag} must be an integer, got: ${value}`)
  }
  return parseInt(value, 10)
}

function parseArgs(argv: string[]): CliArgs {
  let minScore = 4
  let windowDays = 3
  let dryRun = false
  let showHelp = false

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === "--help" || token === "-h") {
      showHelp = true
      continue
    }
    if (token === "--dry-run") {
      dryRun = true
      continue
    }
    if (token === "--min-score") {
      const value = readFlagValue(argv, i, "--min-score")
      const parsed = parseInteger(value, "--min-score")
      if (parsed < 1 || parsed > 5) {
        exitUsageError(`--min-score must be an integer from 1 to 5, got: ${value}`)
      }
      minScore = parsed
      i += 1
      continue
    }
    if (token === "--window-days") {
      const value = readFlagValue(argv, i, "--window-days")
      const parsed = parseInteger(value, "--window-days")
      if (parsed < 1) {
        exitUsageError(`--window-days must be a positive integer, got: ${value}`)
      }
      windowDays = parsed
      i += 1
      continue
    }
    exitUsageError(`unknown argument: ${token}`)
  }

  return { minScore, windowDays, dryRun, showHelp }
}

function loadFeed(): FeedItem[] {
  if (!existsSync(FEED_JSONL)) {
    return []
  }

  const content = readFileSync(FEED_JSONL, "utf8")
  const items: FeedItem[] = []
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    try {
      items.push(JSON.parse(line) as FeedItem)
    } catch {
      console.error("[catchup] skipping unparseable feed line")
    }
  }
  return items
}

function saveFeedAtomic(items: FeedItem[]): void {
  const body = items.length > 0 ? `${items.map((item: FeedItem): string => JSON.stringify(item)).join("\n")}\n` : ""
  writeFileSync(FEED_TMP, body, "utf8")
  renameSync(FEED_TMP, FEED_JSONL)
}

function getFeedDateInfo(items: FeedItem[]): FeedDateInfo {
  const dates = new Set<string>()
  let lastDate: string | null = null

  for (const item of items) {
    dates.add(item.date)
    if (lastDate === null || item.date > lastDate) {
      lastDate = item.date
    }
  }

  return { dates, lastDate }
}

function addDays(date: string, days: number): string {
  const base = new Date(`${date}T12:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

function isWeekend(date: string): boolean {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay()
  return day === 0 || day === 6
}

function findMissingWeekdays(dateSet: Set<string>, lastDate: string | null, today: string): string[] {
  if (lastDate === null) {
    return []
  }

  const missingDays: string[] = []
  let cursor = addDays(lastDate, 1)
  while (cursor <= today) {
    if (!dateSet.has(cursor) && !isWeekend(cursor)) {
      missingDays.push(cursor)
    }
    cursor = addDays(cursor, 1)
  }
  return missingDays
}

function countUnevaluated(items: FeedItem[]): number {
  return items.filter((item: FeedItem): boolean => item.evaluated === false).length
}

function countKeptUnharvested(items: FeedItem[]): number {
  return items.filter((item: FeedItem): boolean => item.kept === true && item.harvested !== true).length
}

function runScraper(missingDays: string[], dryRun: boolean): number {
  let scrapedCount = 0

  for (const date of missingDays) {
    if (dryRun) {
      console.log(`[scrape] [dry-run] would scrape ${date}`)
      scrapedCount += 1
      continue
    }

    const result = spawnSync("bun", [SCRAPER, "--date", date], {
      stdio: "pipe",
      encoding: "utf-8",
    })

    if (result.status !== 0) {
      console.error(`[scrape] failed for ${date}: ${result.stderr?.slice(0, 300) ?? ""}`)
      continue
    }

    scrapedCount += 1
  }

  if (missingDays.length === 0) {
    console.log("[scrape] no missing weekdays to scrape")
  }

  return scrapedCount
}

function autoTriageFeed(items: FeedItem[], minScore: number, dryRun: boolean): AutoTriageResult {
  let autoTriagedCount = 0
  let keptCount = 0
  let skippedCount = 0

  const updatedItems = items.map((item: FeedItem): FeedItem => {
    if (item.evaluated !== false) {
      return item
    }

    autoTriagedCount += 1
    if (item.relevance_score >= minScore) {
      keptCount += 1
      return { ...item, evaluated: true, kept: true }
    }

    skippedCount += 1
    return { ...item, evaluated: true, kept: false }
  })

  if (autoTriagedCount === 0) {
    console.log("[triage] no un-evaluated items")
    return { items: updatedItems, autoTriagedCount, keptCount, skippedCount }
  }

  if (dryRun) {
    console.log(`[triage] [dry-run] would auto-triage ${autoTriagedCount} item(s): ${keptCount} kept, ${skippedCount} skipped`)
    return { items: updatedItems, autoTriagedCount, keptCount, skippedCount }
  }

  saveFeedAtomic(updatedItems)
  console.log(`[triage] auto-triaged ${autoTriagedCount} item(s): ${keptCount} kept, ${skippedCount} skipped`)
  return { items: updatedItems, autoTriagedCount, keptCount, skippedCount }
}

function runHarvest(dryRun: boolean): void {
  if (dryRun) {
    console.log("[harvest] [dry-run] would harvest kept items")
    return
  }

  const result = spawnSync("bun", [HARVEST, "--all"], {
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 3_600_000, // 1h — each item can take up to 140s (fetch + inference)
  })

  if (result.status !== 0) {
    console.error(`[harvest] failed: ${result.stderr?.slice(0, 300) ?? ""}`)
    return
  }

  if (result.stdout) {
    console.log(result.stdout.trimEnd())
  }
}

function runSurface(windowDays: number, dryRun: boolean): number {
  if (dryRun) {
    console.log(`[surface] [dry-run] would run TLDRSurface.ts --window-days ${windowDays} (skipped to avoid writes)`)
    return 0
  }

  const surfaceArgs = [SURFACE, "--window-days", String(windowDays), "--save"]

  const result = spawnSync("bun", surfaceArgs, {
    stdio: "pipe",
    encoding: "utf-8",
  })

  if (result.status !== 0) {
    console.error(`[surface] failed: ${result.stderr?.slice(0, 300) ?? ""}`)
  }

  if (result.stdout) {
    console.log(result.stdout.trimEnd())
  }

  let surfacedCount = 0
  if (result.stdout) {
    const match = result.stdout.match(/\|\s+(\d+)\s+actionable/)
    if (match) {
      surfacedCount = parseInt(match[1], 10)
    }
  }

  return surfacedCount
}

async function postPulseNotify(message: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`[notify] [dry-run] would POST: ${message}`)
    return
  }

  try {
    const response = await fetch(PULSE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, voice_enabled: false }),
    })
    if (!response.ok) {
      console.error(`[notify] failed: HTTP ${response.status}`)
    }
  } catch {
    console.log("[notify] Pulse not available — skipping")
  }
}

function printSummary(date: string, dryRun: boolean, scrapedCount: number, triage: AutoTriageResult, surfacedCount: number): void {
  const header = dryRun ? "════ TLDR CATCHUP [dry-run] ══════════════" : "════ TLDR CATCHUP ════════════════════════"
  const lines = [
    header,
    `📅 Date:           ${date} (Chicago)`,
    `🌐 Days scraped:   ${scrapedCount}`,
    `📥 Auto-triaged:   ${triage.autoTriagedCount} items (${triage.keptCount} kept, ${triage.skippedCount} skipped)`,
    "📚 Harvested:      (see harvest output)",
    `✅ Surfaced:       ${surfacedCount} suggestions`,
  ]
  console.log(lines.join("\n"))
}

async function main(): Promise<void> {
  if (HOME.length === 0) {
    throw new Error("$HOME is not set")
  }

  const args = parseArgs(process.argv.slice(2))
  if (args.showHelp) {
    printHelp()
    return
  }

  const today = todayInChicago()
  const initialFeed = loadFeed()
  const initialDateInfo = getFeedDateInfo(initialFeed)

  if (initialFeed.length === 0) {
    console.log("[catchup] feed empty — nothing to backfill")
  }

  const missingDays = findMissingWeekdays(initialDateInfo.dates, initialDateInfo.lastDate, today)
  const initialUnevaluated = countUnevaluated(initialFeed)
  const initialKeptUnharvested = countKeptUnharvested(initialFeed)

  if (missingDays.length === 0 && initialUnevaluated === 0 && initialKeptUnharvested === 0) {
    console.log("[catchup] no missing weekdays, no un-evaluated items, and no kept items awaiting harvest")
    printSummary(today, args.dryRun, 0, { items: initialFeed, autoTriagedCount: 0, keptCount: 0, skippedCount: 0 }, 0)
    return
  }

  const scrapedCount = runScraper(missingDays, args.dryRun)
  const feedAfterScrape = missingDays.length > 0 && !args.dryRun ? loadFeed() : initialFeed
  const triage = autoTriageFeed(feedAfterScrape, args.minScore, args.dryRun)
  const keptUnharvested = countKeptUnharvested(triage.items)

  if (keptUnharvested > 0) {
    runHarvest(args.dryRun)
  } else {
    console.log("[harvest] no kept unharvested items")
  }

  const shouldRunSurface = missingDays.length > 0 || triage.autoTriagedCount > 0 || keptUnharvested > 0
  const surfacedCount = shouldRunSurface ? runSurface(args.windowDays, args.dryRun) : 0
  if (!shouldRunSurface) {
    console.log("[surface] nothing new to surface")
  }

  const message = `TLDR catchup done — ${scrapedCount} day(s) scraped, ${triage.keptCount} kept, ${surfacedCount} surfaced`
  await postPulseNotify(message, args.dryRun)

  printSummary(today, args.dryRun, scrapedCount, triage, surfacedCount)
}

main().catch((error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[catchup] fatal: ${message}`)
  process.exit(1)
})
