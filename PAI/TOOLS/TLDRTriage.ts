#!/usr/bin/env bun
/**
 * TLDRTriage — interactive CLI for reviewing scored TLDR feed items.
 *
 * Default: show unevaluated items with relevance_score >= 3, newest first.
 * Updates evaluated/kept fields and writes atomically back to the JSONL.
 *
 * Usage:
 *   bun TLDRTriage.ts                            # default triage
 *   bun TLDRTriage.ts --all                      # include evaluated items
 *   bun TLDRTriage.ts --min-score 4              # raise threshold
 *   bun TLDRTriage.ts --newsletter infosec       # filter newsletter
 *   bun TLDRTriage.ts --help
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createInterface, type Interface as ReadlineInterface } from "node:readline"

const HOME = process.env.HOME ?? ""
const PAI_DIR = join(HOME, ".claude", "PAI")
const FEED_JSONL = join(PAI_DIR, "MEMORY", "STATE", "tldr-feed.jsonl")
const HARVEST_TOOL = join(PAI_DIR, "TOOLS", "TLDRHarvest.ts")
const FEED_TMP = `${FEED_JSONL}.tmp`

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
  all: boolean
  minScore: number
  newsletter: string | null
  showHelp: boolean
}

function printHelp(): void {
  const help = [
    "TLDRTriage — review and decide on scored TLDR feed items.",
    "",
    "Usage:",
    "  bun TLDRTriage.ts [flags]",
    "",
    "Flags:",
    "  --all                    Include already-evaluated items",
    "  --min-score N            Minimum relevance_score to show (1-5, default 3)",
    "  --newsletter NAME        Filter by newsletter (tech, ai, infosec, ...)",
    "  --help                   Show this help and exit",
    "",
    "Keys during triage:",
    "  y  keep (evaluated=true, kept=true)",
    "  n  skip (evaluated=true, kept=false)",
    "  s  skip all remaining (mark them evaluated=true, kept=false)",
    "  q  quit without changing remaining items",
    "",
    `Feed: ${FEED_JSONL}`,
  ].join("\n")
  console.log(help)
}

function parseArgs(argv: string[]): CliArgs {
  let all = false
  let minScore = 3
  let newsletter: string | null = null
  let showHelp = false

  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i]
    if (tok === "--help" || tok === "-h") {
      showHelp = true
      continue
    }
    if (tok === "--all") {
      all = true
      continue
    }
    if (tok === "--min-score") {
      const v = argv[i + 1]
      if (!v) {
        console.error("[!] --min-score requires an integer 1-5")
        process.exit(2)
      }
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        console.error(`[!] --min-score must be integer 1-5, got: ${v}`)
        process.exit(2)
      }
      minScore = n
      i += 1
      continue
    }
    if (tok === "--newsletter") {
      const v = argv[i + 1]
      if (!v) {
        console.error("[!] --newsletter requires a value")
        process.exit(2)
      }
      newsletter = v
      i += 1
      continue
    }
    console.error(`[!] unknown argument: ${tok}`)
    process.exit(2)
  }

  return { all, minScore, newsletter, showHelp }
}

function loadFeed(): FeedItem[] {
  if (!existsSync(FEED_JSONL)) return []
  const raw = readFileSync(FEED_JSONL, "utf8")
  const lines = raw.split("\n")
  const out: FeedItem[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const obj = JSON.parse(trimmed) as FeedItem
      out.push(obj)
    } catch {
      console.error("[!] skipping unparseable feed line")
    }
  }
  return out
}

function saveFeed(items: FeedItem[]): void {
  const body = items.map(i => JSON.stringify(i)).join("\n") + (items.length > 0 ? "\n" : "")
  writeFileSync(FEED_TMP, body, "utf8")
  renameSync(FEED_TMP, FEED_JSONL)
}

function filterItems(items: FeedItem[], args: CliArgs): FeedItem[] {
  const filtered = items.filter(it => {
    if (!args.all && it.evaluated) return false
    if (it.relevance_score < args.minScore) return false
    if (args.newsletter !== null && it.newsletter !== args.newsletter) return false
    return true
  })
  filtered.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
    return 0
  })
  return filtered
}

function formatItem(item: FeedItem, index: number, total: number): string {
  const sep = "─────────────────────────────────────────────"
  return [
    sep,
    `[${index}/${total}] Score: ${item.relevance_score}/5 | ${item.type} | ${item.newsletter} — ${item.date}`,
    `Title: ${item.title}`,
    `URL: ${item.url}`,
    `Reason: ${item.reason}`,
    `Summary: ${item.summary}`,
    "",
    "[y] keep  [n] skip  [q] quit  [s] skip all remaining",
    sep,
  ].join("\n")
}

let rawModeActive = false

function enableRawMode(): void {
  if (!process.stdin.isTTY) return
  if (typeof process.stdin.setRawMode !== "function") return
  process.stdin.setRawMode(true)
  process.stdin.resume()
  rawModeActive = true
}

function disableRawMode(): void {
  if (!rawModeActive) return
  if (typeof process.stdin.setRawMode === "function") {
    try {
      process.stdin.setRawMode(false)
    } catch {
      // Stdin may already be closed; safe to ignore on shutdown.
    }
  }
  try {
    process.stdin.pause()
  } catch {
    // Stdin already paused/closed — intentional no-op.
  }
  rawModeActive = false
}

async function readKeyTTY(): Promise<string> {
  return new Promise<string>(resolve => {
    const onData = (buf: Buffer): void => {
      process.stdin.removeListener("data", onData)
      // Ctrl+C = 0x03
      if (buf.length > 0 && buf[0] === 0x03) {
        disableRawMode()
        process.exit(130)
      }
      const ch = buf.toString("utf8").charAt(0).toLowerCase()
      resolve(ch)
    }
    process.stdin.on("data", onData)
  })
}

async function readKeyLine(rl: ReadlineInterface): Promise<string> {
  return new Promise<string>(resolve => {
    rl.question("> ", answer => {
      const ch = answer.trim().toLowerCase().charAt(0)
      resolve(ch)
    })
  })
}

async function promptKey(rl: ReadlineInterface | null): Promise<string> {
  if (process.stdin.isTTY) {
    return readKeyTTY()
  }
  if (rl === null) {
    throw new Error("readline required for non-TTY input but was not initialized")
  }
  return readKeyLine(rl)
}

function installSigintHandler(): void {
  process.on("SIGINT", () => {
    disableRawMode()
    process.exit(130)
  })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.showHelp) {
    printHelp()
    process.exit(0)
  }

  const items = loadFeed()
  if (items.length === 0) {
    console.log("0 items to triage")
    process.exit(0)
  }

  const view = filterItems(items, args)
  if (view.length === 0) {
    console.log("0 items to triage")
    process.exit(0)
  }

  // Map url -> index into the canonical items[] for in-place updates.
  const urlToIndex = new Map<string, number>()
  for (let i = 0; i < items.length; i += 1) {
    urlToIndex.set(items[i].url, i)
  }

  installSigintHandler()
  const rl: ReadlineInterface | null = process.stdin.isTTY
    ? null
    : createInterface({ input: process.stdin, output: process.stdout })
  enableRawMode()

  let triaged = 0
  let kept = 0
  let quitEarly = false
  let skipAllRemaining = false

  for (let i = 0; i < view.length; i += 1) {
    if (quitEarly) break

    const current = view[i]
    if (skipAllRemaining) {
      const idx = urlToIndex.get(current.url)
      if (idx !== undefined) {
        items[idx].evaluated = true
        items[idx].kept = false
        triaged += 1
      }
      continue
    }

    console.log(formatItem(current, i + 1, view.length))

    let decided = false
    while (!decided) {
      const key = await promptKey(rl)
      if (key === "y") {
        const idx = urlToIndex.get(current.url)
        if (idx !== undefined) {
          items[idx].evaluated = true
          items[idx].kept = true
          triaged += 1
          kept += 1
        }
        decided = true
      } else if (key === "n") {
        const idx = urlToIndex.get(current.url)
        if (idx !== undefined) {
          items[idx].evaluated = true
          items[idx].kept = false
          triaged += 1
        }
        decided = true
      } else if (key === "q") {
        quitEarly = true
        decided = true
      } else if (key === "s") {
        const idx = urlToIndex.get(current.url)
        if (idx !== undefined) {
          items[idx].evaluated = true
          items[idx].kept = false
          triaged += 1
        }
        skipAllRemaining = true
        decided = true
      } else {
        // Unknown key — in TTY mode, re-prompt without advancing; in piped mode same.
        console.log("(use y / n / q / s)")
      }
    }
  }

  disableRawMode()
  if (rl !== null) rl.close()

  saveFeed(items)
  console.log(`${triaged} items triaged, ${kept} kept.`)
  if (kept > 0 && !quitEarly) {
    console.log(`\nTo extract knowledge from kept articles:`)
    console.log(`  bun ${HARVEST_TOOL}`)
  }
}

main().catch(err => {
  disableRawMode()
  console.error(`[!] fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
