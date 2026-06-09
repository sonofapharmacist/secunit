#!/usr/bin/env bun
/**
 * TLDRHarvest — fetch full article content for kept TLDR items and extract structured knowledge.
 *
 * Runs post-triage. Fetches the actual article URL for each kept+unharvested item, extracts
 * concrete knowledge via Inference.ts, and writes JSON entries to MEMORY/KNOWLEDGE/TLDR/.
 * Falls back to feed summary when article is unreachable (paywalled, 403, etc.).
 *
 * Usage:
 *   bun TLDRHarvest.ts                    # harvest today's kept items
 *   bun TLDRHarvest.ts --date 2026-05-11  # specific date
 *   bun TLDRHarvest.ts --all              # all kept+unharvested regardless of date
 *   bun TLDRHarvest.ts --dry-run          # print extractions, don't write
 *   bun TLDRHarvest.ts --help
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { parse as parseHtml } from "node-html-parser"
import { normalizeExternalContent } from "./NormalizeContent"

const HOME = process.env.HOME ?? ""
const PAI_DIR = join(HOME, ".claude", "PAI")
const FEED_JSONL = join(PAI_DIR, "MEMORY", "STATE", "tldr-feed.jsonl")
const FEED_TMP = `${FEED_JSONL}.tmp`
const KNOWLEDGE_ROOT = join(PAI_DIR, "MEMORY", "KNOWLEDGE", "TLDR")
const INFERENCE_PATH = join(PAI_DIR, "TOOLS", "Inference.ts")

const ARTICLE_FETCH_TIMEOUT_MS = 20000
const INFERENCE_TIMEOUT_MS = 120000
const ARTICLE_CONTENT_MAX_CHARS = 8000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type KnowledgeCategory = "work-security" | "work-ai" | "pai-development" | "industry-narrative"

interface KnowledgeEntry {
  id: string
  title: string
  url: string
  newsletter: string
  section: string
  date: string
  category: KnowledgeCategory
  key_findings: string[]
  work_application: string | null
  pai_relevance: string | null
  industry_context: string | null
  tags: string[]
  harvested_at: string
  fetch_source: "full-article" | "summary-fallback"
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

interface CliArgs {
  date: string | null
  all: boolean
  dryRun: boolean
  showHelp: boolean
}

const DEFAULT_EXTRACTION: Omit<KnowledgeEntry, "id" | "title" | "url" | "newsletter" | "section" | "date" | "harvested_at" | "fetch_source"> = {
  category: "industry-narrative",
  key_findings: [],
  work_application: null,
  pai_relevance: null,
  industry_context: null,
  tags: [],
}

function todayInChicago(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" })
}

function printHelp(): void {
  console.log([
    "TLDRHarvest — fetch article content and extract structured knowledge from kept TLDR items.",
    "",
    "Usage:",
    "  bun TLDRHarvest.ts [flags]",
    "",
    "Flags:",
    "  --date YYYY-MM-DD    Harvest kept items for a specific date (default: today)",
    "  --all                Harvest all kept+unharvested items regardless of date",
    "  --dry-run            Print extracted knowledge, don't write files or update feed",
    "  --help               Show this help and exit",
    "",
    `Feed:      ${FEED_JSONL}`,
    `Knowledge: ${KNOWLEDGE_ROOT}/YYYY-MM/{id}.json`,
  ].join("\n"))
}

function parseArgs(argv: string[]): CliArgs {
  let date: string | null = null
  let all = false
  let dryRun = false
  let showHelp = false

  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i]
    if (tok === "--help" || tok === "-h") { showHelp = true; continue }
    if (tok === "--all") { all = true; continue }
    if (tok === "--dry-run") { dryRun = true; continue }
    if (tok === "--date") {
      const v = argv[i + 1]
      if (!v) { console.error("[!] --date requires YYYY-MM-DD"); process.exit(2) }
      if (!DATE_RE.test(v)) { console.error(`[!] --date must match YYYY-MM-DD, got: ${v}`); process.exit(2) }
      date = v
      i += 1
      continue
    }
    console.error(`[!] unknown argument: ${tok}`)
    process.exit(2)
  }

  if (showHelp) return { date: null, all: false, dryRun: false, showHelp: true }
  if (!all && date === null) date = todayInChicago()
  return { date, all, dryRun, showHelp: false }
}

function log(level: "+" | "-" | "!", msg: string): void {
  console.log(`${new Date().toISOString()} [${level}] ${msg}`)
}

function loadFeed(): FeedItem[] {
  if (!existsSync(FEED_JSONL)) return []
  const lines = readFileSync(FEED_JSONL, "utf8").split("\n")
  const out: FeedItem[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t) as FeedItem) } catch { log("!", "skipping unparseable feed line") }
  }
  return out
}

function saveFeed(items: FeedItem[]): void {
  const body = items.map(i => JSON.stringify(i)).join("\n") + (items.length > 0 ? "\n" : "")
  writeFileSync(FEED_TMP, body, "utf8")
  renameSync(FEED_TMP, FEED_JSONL)
}

function selectTargets(items: FeedItem[], args: CliArgs): FeedItem[] {
  return items.filter(it => {
    if (it.kept !== true) return false
    if (it.harvested === true) return false
    if (!args.all && args.date !== null && it.date !== args.date) return false
    return true
  })
}

async function fetchWithTimeout(url: string, ms: number): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "PAI-TLDRHarvest/1.0 (+local)", "accept": "text/html" },
      redirect: "follow",
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const ct = res.headers.get("content-type") ?? ""
    if (!ct.toLowerCase().includes("html")) throw new Error(`non-html: ${ct}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

function htmlToText(html: string): string {
  try {
    const root = parseHtml(html)
    // Remove script and style elements.
    for (const el of root.querySelectorAll("script, style, nav, footer, header")) {
      el.remove()
    }
    return root.text.replace(/\s+/g, " ").trim()
  } catch {
    // Fallback: crude regex strip.
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  }
}

async function fetchArticleContent(url: string): Promise<{ text: string; source: "full-article" | "summary-fallback" }> {
  try {
    const html = await fetchWithTimeout(url, ARTICLE_FETCH_TIMEOUT_MS)
    const text = htmlToText(html)
    if (text.length < 200) throw new Error("content too short — likely a redirect page")
    return { text: text.slice(0, ARTICLE_CONTENT_MAX_CHARS), source: "full-article" }
  } catch (err) {
    log("-", `fetch failed (${err instanceof Error ? err.message : String(err)}) — using summary fallback`)
    return { text: "", source: "summary-fallback" }
  }
}

function buildExtractionPrompt(item: FeedItem, articleText: string, isFallback: boolean): [string, string] {
  const system = [
    "You are extracting structured knowledge from a newsletter article for a Sr. Cybersecurity Consultant.",
    "Your Name: your interests and focus areas here.",
    "He is also building PAI — a Personal AI Life OS on Claude Code.",
    "",
    "Extract CONCRETE AND SPECIFIC knowledge. Exact technique names, tool names, CVE numbers, data points.",
    "Not summaries. Not paraphrasing. Actual facts and insights a practitioner can act on.",
    "",
    "Return JSON only. No markdown fences. No explanation outside the JSON.",
    "category options: work-security | work-ai | pai-development | industry-narrative",
  ].join("\n")

  const content = isFallback
    ? `Summary from newsletter: ${item.summary}\nScore reason: ${item.reason}`
    : articleText

  const user = [
    `Title: ${item.title}`,
    `Newsletter: ${item.newsletter} / ${item.section}`,
    `Date: ${item.date}`,
    "",
    "Article content:",
    content,
    "",
    'Return JSON: {"category":"...","key_findings":["...","..."],"work_application":"... or null","pai_relevance":"... or null","industry_context":"... or null","tags":["..."]}',
  ].join("\n")

  return [system, user]
}

function validateExtraction(raw: unknown): typeof DEFAULT_EXTRACTION | null {
  if (typeof raw !== "object" || raw === null) return null
  const obj = raw as Record<string, unknown>
  const validCategories = new Set(["work-security", "work-ai", "pai-development", "industry-narrative"])
  const cat = obj.category
  if (typeof cat !== "string" || !validCategories.has(cat)) return null
  const findings = obj.key_findings
  if (!Array.isArray(findings)) return null
  return {
    category: cat as KnowledgeCategory,
    key_findings: findings.filter(f => typeof f === "string"),
    work_application: typeof obj.work_application === "string" ? obj.work_application : null,
    pai_relevance: typeof obj.pai_relevance === "string" ? obj.pai_relevance : null,
    industry_context: typeof obj.industry_context === "string" ? obj.industry_context : null,
    tags: Array.isArray(obj.tags) ? (obj.tags as unknown[]).filter((t): t is string => typeof t === "string") : [],
  }
}

async function extractKnowledge(
  item: FeedItem,
  articleText: string,
  isFallback: boolean,
): Promise<typeof DEFAULT_EXTRACTION> {
  const [systemPrompt, userPrompt] = buildExtractionPrompt(item, articleText, isFallback)

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(
      ["bun", INFERENCE_PATH, "--backend", "antigravity", "--level", "standard", "--json", systemPrompt, userPrompt],
      { stdout: "pipe", stderr: "pipe" },
    )
  } catch (err) {
    log("!", `inference spawn failed: ${err instanceof Error ? err.message : String(err)}`)
    return DEFAULT_EXTRACTION
  }

  let killed = false
  const timer = setTimeout(() => {
    killed = true
    try { proc.kill() } catch { /* already exited */ }
  }, INFERENCE_TIMEOUT_MS)

  try {
    const output = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
    await proc.exited
    if (killed) { log("!", "inference timed out"); return DEFAULT_EXTRACTION }
    const trimmed = output.trim()
    if (!trimmed) return DEFAULT_EXTRACTION
    try {
      return validateExtraction(JSON.parse(trimmed)) ?? DEFAULT_EXTRACTION
    } catch {
      const match = trimmed.match(/\{[\s\S]*\}/)
      if (match) {
        try { return validateExtraction(JSON.parse(match[0])) ?? DEFAULT_EXTRACTION } catch { /* fall through */ }
      }
      return DEFAULT_EXTRACTION
    }
  } finally {
    clearTimeout(timer)
  }
}

function knowledgeDirForDate(date: string): string {
  const ym = date.slice(0, 7) // YYYY-MM
  return join(KNOWLEDGE_ROOT, ym)
}

function writeKnowledgeEntry(entry: KnowledgeEntry, dryRun: boolean): void {
  if (dryRun) {
    console.log("\n" + JSON.stringify(entry, null, 2))
    return
  }
  const dir = knowledgeDirForDate(entry.date)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${entry.id}.json`)
  writeFileSync(path, JSON.stringify(entry, null, 2) + "\n", "utf8")
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Load knowledge entries — used by the Pulse module but exported here for convenience.
export function loadKnowledge(opts: { windowDays?: number } = {}): KnowledgeEntry[] {
  if (!existsSync(KNOWLEDGE_ROOT)) return []
  const cutoff = opts.windowDays
    ? new Date(Date.now() - opts.windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : null
  const entries: KnowledgeEntry[] = []
  for (const month of readdirSync(KNOWLEDGE_ROOT)) {
    const monthDir = join(KNOWLEDGE_ROOT, month)
    try {
      for (const file of readdirSync(monthDir)) {
        if (!file.endsWith(".json")) continue
        try {
          const entry = JSON.parse(readFileSync(join(monthDir, file), "utf8")) as KnowledgeEntry
          if (!cutoff || entry.date >= cutoff) entries.push(entry)
        } catch { /* skip corrupt file */ }
      }
    } catch { /* skip unreadable dir */ }
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.showHelp) { printHelp(); process.exit(0) }

  const feed = loadFeed()
  const targets = selectTargets(feed, args)

  if (targets.length === 0) {
    const scope = args.all ? "all dates" : `${args.date}`
    log("+", `no unharvested kept items for ${scope}`)
    process.exit(0)
  }

  const scope = args.all ? "all dates" : `${args.date}`
  log("+", `harvesting ${targets.length} items (${scope})${args.dryRun ? " [dry-run]" : ""}`)

  // Build url → feed index map for atomic updates.
  const urlToIdx = new Map<string, number>()
  for (let i = 0; i < feed.length; i += 1) urlToIdx.set(feed[i].url, i)

  let harvested = 0
  let fallbacks = 0

  for (let i = 0; i < targets.length; i += 1) {
    const item = targets[i]
    log("+", `[${i + 1}/${targets.length}] ${item.title}`)

    const { text, source } = await fetchArticleContent(item.url)
    const isFallback = source === "summary-fallback"
    if (isFallback) fallbacks += 1

    // Normalize article text before LLM ingestion — ISC-26,27
    let articleText = isFallback ? "" : text
    if (!isFallback && text) {
      const { normalized, transforms_fired } = normalizeExternalContent(text, { title: item.title, url: item.url })
      if (transforms_fired.length > 0) {
        log("!", `encoding normalization fired [${transforms_fired.join(", ")}] — title: "${item.title}" url: ${item.url}`)
      }
      articleText = normalized
    }

    const extraction = await extractKnowledge(
      item,
      articleText,
      isFallback,
    )

    const now = new Date().toISOString()
    const entry: KnowledgeEntry = {
      id: item.id,
      title: item.title,
      url: item.url,
      newsletter: item.newsletter,
      section: item.section,
      date: item.date,
      harvested_at: now,
      fetch_source: source,
      ...extraction,
    }

    writeKnowledgeEntry(entry, args.dryRun)
    log("+", `  [${entry.category}] ${entry.tags.join(", ")}`)

    // Only mark harvested if extraction produced real content — empty means inference timed out.
    if (!args.dryRun && entry.key_findings.length > 0) {
      const idx = urlToIdx.get(item.url)
      if (idx !== undefined) {
        feed[idx].harvested = true
        feed[idx].harvested_at = now
      }
    }

    harvested += 1
    // Rate limit — be polite to external sites.
    if (i < targets.length - 1) await sleep(1500)
  }

  if (!args.dryRun) saveFeed(feed)

  log("+", `done. harvested=${harvested} fallbacks=${fallbacks}`)
  if (fallbacks > 0) {
    log("-", `${fallbacks} items used summary fallback (paywalled or unreachable)`)
  }

  // Surface actionable project suggestions for the harvested batch.
  if (!args.dryRun && harvested > 0) {
    const surfaceArgs = args.all
      ? ["--all"]
      : ["--date", args.date ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" })]
    const surface = Bun.spawn(
      ["bun", join(PAI_DIR, "TOOLS", "TLDRSurface.ts"), ...surfaceArgs],
      { stdout: "inherit", stderr: "inherit" },
    )
    await surface.exited
  }
}

main().catch(err => {
  console.error(`[!] fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
