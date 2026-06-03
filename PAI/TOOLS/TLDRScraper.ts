#!/usr/bin/env bun
/**
 * TLDRScraper — scrape TLDR.tech newsletters, LLM-score articles, append to JSONL feed.
 *
 * Targets ALL sections (not just tools). Skips sponsor articles and Jobs/Career sections.
 * Calls Inference.ts as a subprocess for LLM scoring (never imports @anthropic-ai/sdk).
 *
 * Usage:
 *   bun TLDRScraper.ts                              # scrape today, all default newsletters
 *   bun TLDRScraper.ts --today                      # explicit today
 *   bun TLDRScraper.ts --date 2026-05-09            # specific date
 *   bun TLDRScraper.ts --newsletters tech,ai        # override newsletters
 *   bun TLDRScraper.ts --dry-run                    # print items, don't write
 *   bun TLDRScraper.ts --help
 */

import { mkdirSync, existsSync, readFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { parse as parseHtml } from "node-html-parser"

const HOME = process.env.HOME ?? ""
const PAI_DIR = join(HOME, ".claude", "PAI")
const FEED_DIR = join(PAI_DIR, "MEMORY", "STATE")
const FEED_JSONL = join(FEED_DIR, "tldr-feed.jsonl")
const INFERENCE_PATH = join(PAI_DIR, "TOOLS", "Inference.ts")

const DEFAULT_NEWSLETTERS = ["tech", "ai", "infosec", "dev", "devops", "fintech", "it", "data", "design"]
const SPONSOR_KEYWORDS = ["sponsor", "demo", "register", "summit", "cato", "webinar"]
const ALLOWED_TYPES = new Set(["tool", "research", "news", "vulnerability", "analysis", "other"])
const FETCH_TIMEOUT_MS = 15000
const INFERENCE_TIMEOUT_MS = 30000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface ScoreResult {
  relevance_score: number
  reason: string
  type: string
}

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

interface ParsedArticle {
  title: string
  url: string
  text: string
  section: string
}

interface CliArgs {
  date: string
  newsletters: string[]
  dryRun: boolean
  showHelp: boolean
}

interface NewsletterStats {
  added: number
  skipped: number
}

const DEFAULT_SCORE: ScoreResult = {
  relevance_score: 2,
  reason: "parse error — defaulted",
  type: "other",
}

function todayInChicago(): string {
  // en-CA locale formats as YYYY-MM-DD; America/Chicago matches user timezone.
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" })
}

function printHelp(): void {
  const help = [
    "TLDRScraper — scrape TLDR.tech newsletters and append scored items to JSONL feed.",
    "",
    "Usage:",
    "  bun TLDRScraper.ts [flags]",
    "",
    "Flags:",
    "  --today                  Scrape today's newsletters (default if no date given)",
    "  --date YYYY-MM-DD        Scrape a specific date",
    "  --newsletters a,b,c      Override newsletters (default: tech,ai,infosec)",
    "  --dry-run                Print items without writing to JSONL",
    "  --help                   Show this help and exit",
    "",
    `Feed: ${FEED_JSONL}`,
  ].join("\n")
  console.log(help)
}

function parseArgs(argv: string[]): CliArgs {
  let date = ""
  let newsletters: string[] = []
  let dryRun = false
  let showHelp = false
  let sawToday = false

  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i]
    if (tok === "--help" || tok === "-h") {
      showHelp = true
      continue
    }
    if (tok === "--today") {
      sawToday = true
      continue
    }
    if (tok === "--dry-run") {
      dryRun = true
      continue
    }
    if (tok === "--date") {
      const v = argv[i + 1]
      if (!v) {
        console.error("[!] --date requires a value (YYYY-MM-DD)")
        process.exit(2)
      }
      date = v
      i += 1
      continue
    }
    if (tok === "--newsletters") {
      const v = argv[i + 1]
      if (!v) {
        console.error("[!] --newsletters requires a comma-separated value")
        process.exit(2)
      }
      newsletters = v.split(",").map(s => s.trim()).filter(s => s.length > 0)
      i += 1
      continue
    }
    console.error(`[!] unknown argument: ${tok}`)
    process.exit(2)
  }

  if (showHelp) {
    return { date: "", newsletters: [], dryRun: false, showHelp: true }
  }

  if (date.length === 0) {
    // --today is the default behavior; sawToday is accepted but not required.
    void sawToday
    date = todayInChicago()
  } else if (!DATE_RE.test(date)) {
    console.error(`[!] --date must match YYYY-MM-DD, got: ${date}`)
    process.exit(2)
  } else {
    const parsed = new Date(`${date}T00:00:00Z`)
    if (Number.isNaN(parsed.getTime())) {
      console.error(`[!] --date is not a valid calendar date: ${date}`)
      process.exit(2)
    }
  }

  if (newsletters.length === 0) {
    newsletters = [...DEFAULT_NEWSLETTERS]
  }

  return { date, newsletters, dryRun, showHelp: false }
}

function log(level: "+" | "-" | "!", msg: string): void {
  const ts = new Date().toISOString()
  console.log(`${ts} [${level}] ${msg}`)
}

function hashId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 12)
}

function isSponsor(text: string): boolean {
  const lower = text.toLowerCase()
  for (const kw of SPONSOR_KEYWORDS) {
    if (lower.includes(kw)) return true
  }
  return false
}

function isJobsSection(header: string): boolean {
  const lower = header.toLowerCase()
  return lower.includes("job") || lower.includes("career")
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "PAI-TLDRScraper/1.0 (+local)" },
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`)
    }
    const ct = res.headers.get("content-type") ?? ""
    if (!ct.toLowerCase().startsWith("text/html")) {
      throw new Error(`unexpected content-type: ${ct}`)
    }
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

function findSectionHeader(section: ReturnType<typeof parseHtml>): string {
  // First try descendants.
  const headerEl = section.querySelector("h2, h3")
  if (headerEl) {
    const text = headerEl.text.trim()
    if (text.length > 0) return text
  }
  // Walk previous-sibling chain on the section node looking for h2/h3.
  // node-html-parser exposes parentNode/childNodes — find this section among siblings.
  const parent = section.parentNode
  if (parent) {
    const siblings = parent.childNodes
    const idx = siblings.indexOf(section)
    if (idx > 0) {
      for (let i = idx - 1; i >= 0; i -= 1) {
        const sib = siblings[i] as ReturnType<typeof parseHtml>
        // Some nodes are text nodes without `tagName`; guard.
        const tag = (sib as { tagName?: string }).tagName
        if (tag === "H2" || tag === "H3") {
          const text = (sib as { text?: string }).text?.trim() ?? ""
          if (text.length > 0) return text
        }
      }
    }
  }
  return "Uncategorized"
}

function parseArticles(html: string): ParsedArticle[] {
  const root = parseHtml(html)
  const sections = root.querySelectorAll("section")
  const out: ParsedArticle[] = []
  for (const section of sections) {
    const header = findSectionHeader(section)
    const articles = section.querySelectorAll("article.mt-3")
    for (const article of articles) {
      const anchor = article.querySelector("a")
      const h3 = article.querySelector("h3")
      if (!anchor || !h3) continue
      const href = anchor.getAttribute("href") ?? ""
      if (href.length === 0) continue
      const title = h3.text.trim()
      if (title.length === 0) continue
      const text = article.text.replace(/\s+/g, " ").trim()
      out.push({ title, url: href, text, section: header })
    }
  }
  return out
}

function validateScore(raw: unknown): ScoreResult {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SCORE
  const obj = raw as Record<string, unknown>
  const score = obj.relevance_score
  const reason = obj.reason
  const t = obj.type
  if (typeof score !== "number" || !Number.isFinite(score)) return DEFAULT_SCORE
  if (score < 1 || score > 5) return DEFAULT_SCORE
  if (typeof reason !== "string" || reason.trim().length === 0) return DEFAULT_SCORE
  if (typeof t !== "string" || !ALLOWED_TYPES.has(t)) return DEFAULT_SCORE
  return { relevance_score: Math.round(score), reason: reason.trim(), type: t }
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
    log("!", `inference spawn failed: ${err instanceof Error ? err.message : String(err)}`)
    return DEFAULT_SCORE
  }

  let killed = false
  const timer = setTimeout(() => {
    killed = true
    try {
      proc.kill()
    } catch {
      // Process already exited — nothing to kill. Intentional no-op.
    }
  }, INFERENCE_TIMEOUT_MS)

  try {
    // proc.stdout is a ReadableStream when stdout: "pipe"; assert to satisfy strict typing.
    const stream = proc.stdout as ReadableStream<Uint8Array>
    const output = await new Response(stream).text()
    await proc.exited
    if (killed) {
      log("!", `inference timed out after ${INFERENCE_TIMEOUT_MS}ms`)
      return DEFAULT_SCORE
    }
    const trimmed = output.trim()
    if (trimmed.length === 0) return DEFAULT_SCORE
    try {
      return validateScore(JSON.parse(trimmed))
    } catch {
      // Inference.ts may emit a JSON-in-string wrapper; try one level of extraction.
      const match = trimmed.match(/\{[\s\S]*\}/)
      if (match) {
        try {
          return validateScore(JSON.parse(match[0]))
        } catch {
          return DEFAULT_SCORE
        }
      }
      return DEFAULT_SCORE
    }
  } finally {
    clearTimeout(timer)
  }
}

function loadExistingUrls(): Set<string> {
  const urls = new Set<string>()
  if (!existsSync(FEED_JSONL)) return urls
  const raw = readFileSync(FEED_JSONL, "utf8")
  const lines = raw.split("\n")
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const obj = JSON.parse(trimmed) as { url?: unknown }
      if (typeof obj.url === "string" && obj.url.length > 0) {
        urls.add(obj.url)
      }
    } catch {
      // Corrupt line — log and continue; don't poison the dedup set.
      log("!", `skipping unparseable feed line during dedup load`)
    }
  }
  return urls
}

function appendFeedItem(item: FeedItem): void {
  appendFileSync(FEED_JSONL, JSON.stringify(item) + "\n", "utf8")
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function scrapeNewsletter(
  newsletter: string,
  date: string,
  seenUrls: Set<string>,
  dryRun: boolean,
): Promise<NewsletterStats> {
  const url = `https://tldr.tech/${newsletter}/${date}`
  log("+", `fetching ${url}`)
  let html: string
  try {
    html = await fetchWithTimeout(url, FETCH_TIMEOUT_MS)
  } catch (err) {
    log("!", `fetch failed for ${newsletter} ${date}: ${err instanceof Error ? err.message : String(err)}`)
    return { added: 0, skipped: 0 }
  }

  let articles: ParsedArticle[]
  try {
    articles = parseArticles(html)
  } catch (err) {
    log("!", `parse failed for ${newsletter} ${date}: ${err instanceof Error ? err.message : String(err)}`)
    return { added: 0, skipped: 0 }
  }

  log("+", `parsed ${articles.length} articles from ${newsletter} ${date}`)
  let added = 0
  let skipped = 0
  for (const art of articles) {
    if (isJobsSection(art.section)) {
      log("-", `skip jobs section: ${art.title}`)
      skipped += 1
      continue
    }
    if (isSponsor(art.text)) {
      log("-", `skip sponsor: ${art.title}`)
      skipped += 1
      continue
    }
    if (seenUrls.has(art.url)) {
      log("-", `skip duplicate: ${art.title}`)
      skipped += 1
      continue
    }

    const score = await scoreArticle(art.title, art.text)
    const item: FeedItem = {
      id: hashId(art.url),
      title: art.title,
      url: art.url,
      summary: art.text.slice(0, 400),
      section: art.section,
      newsletter,
      date,
      relevance_score: score.relevance_score,
      reason: score.reason,
      type: score.type,
      evaluated: false,
      created_at: new Date().toISOString(),
    }

    if (dryRun) {
      log("+", `[dry-run] ${score.relevance_score}/5 ${score.type} | ${item.title}`)
    } else {
      appendFeedItem(item)
      log("+", `added ${score.relevance_score}/5 ${score.type} | ${item.title}`)
    }
    seenUrls.add(art.url)
    added += 1
  }
  return { added, skipped }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.showHelp) {
    printHelp()
    process.exit(0)
  }

  mkdirSync(FEED_DIR, { recursive: true })
  const seenUrls = loadExistingUrls()
  log("+", `starting scrape for ${args.date} | newsletters=${args.newsletters.join(",")} | dryRun=${args.dryRun} | existing=${seenUrls.size}`)

  let totalAdded = 0
  let totalSkipped = 0
  for (let i = 0; i < args.newsletters.length; i += 1) {
    const nl = args.newsletters[i]
    const stats = await scrapeNewsletter(nl, args.date, seenUrls, args.dryRun)
    totalAdded += stats.added
    totalSkipped += stats.skipped
    const isLast = i === args.newsletters.length - 1
    if (!isLast) {
      await sleep(1000)
    }
  }

  log("+", `done. added=${totalAdded} skipped=${totalSkipped}`)
}

main().catch(err => {
  log("!", `fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
