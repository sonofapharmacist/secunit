/**
 * TLDR Pulse Module
 *
 * Exposes the TLDR feed and knowledge corpus via HTTP.
 * Pulse routes /api/tldr/* to this module's handleRequest.
 *
 * Routes (all GET):
 *   /items              → JSON array of items in last 30 days, newest first
 *   /unread             → { count, latest_date } for unevaluated items with score >= 3
 *   /items/:date        → JSON array of items for a specific YYYY-MM-DD date
 *   /knowledge          → JSON array of knowledge entries in last 30 days, newest first
 *   /knowledge/:date    → JSON array of knowledge entries for a specific YYYY-MM-DD date
 *   /knowledge/stats    → { total, by_category, unharvested_kept }
 */

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

const HOME = process.env.HOME ?? ""
const PAI_DIR = join(HOME, ".claude", "PAI")
const FEED_JSONL = join(PAI_DIR, "MEMORY", "STATE", "tldr-feed.jsonl")
const KNOWLEDGE_ROOT = join(PAI_DIR, "MEMORY", "KNOWLEDGE", "TLDR")
const MODULE_NAME = "tldr"
const MIN_UNREAD_SCORE = 3
const ITEMS_WINDOW_DAYS = 30
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

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

interface KnowledgeEntry {
  id: string
  title: string
  url: string
  newsletter: string
  section: string
  date: string
  category: string
  key_findings: string[]
  work_application: string | null
  pai_relevance: string | null
  industry_context: string | null
  tags: string[]
  harvested_at: string
  fetch_source: string
}

interface ModuleState {
  running: boolean
  startedAt: Date | null
}

const state: ModuleState = {
  running: false,
  startedAt: null,
}

function loadFeed(): FeedItem[] {
  if (!existsSync(FEED_JSONL)) return []
  let raw: string
  try {
    raw = readFileSync(FEED_JSONL, "utf8")
  } catch (err) {
    console.warn(`[${MODULE_NAME}] failed to read feed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
  const lines = raw.split("\n")
  const out: FeedItem[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      out.push(JSON.parse(trimmed) as FeedItem)
    } catch {
      console.warn(`[${MODULE_NAME}] skipping unparseable feed line`)
    }
  }
  return out
}

function sortByDateDesc(items: FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
    return 0
  })
}

function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return false
  // Guard against e.g. 2026-02-31 round-tripping to March.
  const iso = d.toISOString().slice(0, 10)
  return iso === s
}

function withinLastNDays(dateStr: string, n: number): boolean {
  if (!validDate(dateStr)) return false
  const itemTime = new Date(`${dateStr}T00:00:00Z`).getTime()
  const now = Date.now()
  const cutoff = now - n * 24 * 60 * 60 * 1000
  return itemTime >= cutoff && itemTime <= now + 24 * 60 * 60 * 1000
}

function normalizePath(path: string): string {
  let p = path
  if (p.startsWith("/api/tldr")) p = p.slice("/api/tldr".length)
  if (!p.startsWith("/")) p = `/${p}`
  // Strip trailing slash except for root.
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1)
  return p
}

function loadKnowledge(opts: { windowDays?: number; date?: string } = {}): KnowledgeEntry[] {
  if (!existsSync(KNOWLEDGE_ROOT)) return []
  const cutoff = opts.windowDays
    ? new Date(Date.now() - opts.windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : null
  const entries: KnowledgeEntry[] = []
  let months: string[]
  try { months = readdirSync(KNOWLEDGE_ROOT) } catch { return [] }
  for (const month of months) {
    const monthDir = join(KNOWLEDGE_ROOT, month)
    let files: string[]
    try { files = readdirSync(monthDir) } catch { continue }
    for (const file of files) {
      if (!file.endsWith(".json")) continue
      try {
        const entry = JSON.parse(readFileSync(join(monthDir, file), "utf8")) as KnowledgeEntry
        if (opts.date && entry.date !== opts.date) continue
        if (cutoff && entry.date < cutoff) continue
        entries.push(entry)
      } catch { /* skip corrupt */ }
    }
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date))
}

function knowledgeStats(items: FeedItem[]): { total: number; by_category: Record<string, number>; unharvested_kept: number } {
  const all = loadKnowledge()
  const by_category: Record<string, number> = {}
  for (const e of all) by_category[e.category] = (by_category[e.category] ?? 0) + 1
  const unharvested_kept = items.filter(i => i.kept && !i.harvested).length
  return { total: all.length, by_category, unharvested_kept }
}

function unreadStats(items: FeedItem[]): { count: number; latest_date: string } {
  const filtered = items.filter(i => !i.evaluated && i.relevance_score >= MIN_UNREAD_SCORE)
  let latest = ""
  for (const it of filtered) {
    if (it.date > latest) latest = it.date
  }
  return { count: filtered.length, latest_date: latest }
}

export async function start(): Promise<void> {
  console.log(`[${MODULE_NAME}] Starting...`)
  state.running = true
  state.startedAt = new Date()
  console.log(`[${MODULE_NAME}] Started`)
}

export async function stop(): Promise<void> {
  console.log(`[${MODULE_NAME}] Stopping...`)
  state.running = false
  state.startedAt = null
  console.log(`[${MODULE_NAME}] Stopped`)
}

export function health(): { status: string; details?: Record<string, unknown> } {
  const items = loadFeed()
  const { count: unread } = unreadStats(items)
  const unharvested_kept = items.filter(i => i.kept && !i.harvested).length
  const knowledge_total = loadKnowledge().length
  return {
    status: state.running ? "healthy" : "stopped",
    details: {
      feed_items: items.length,
      unread,
      knowledge_entries: knowledge_total,
      unharvested_kept,
    },
  }
}

export async function handleRequest(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  // `body` is part of the Pulse module contract; unused for GET routes.
  void body

  const route = normalizePath(path)
  const items = loadFeed()

  if (route === "/items") {
    const recent = items.filter(i => withinLastNDays(i.date, ITEMS_WINDOW_DAYS))
    return Response.json(sortByDateDesc(recent))
  }

  if (route === "/unread") {
    return Response.json(unreadStats(items))
  }

  const itemsDateMatch = route.match(/^\/items\/(.+)$/)
  if (itemsDateMatch) {
    const dateStr = itemsDateMatch[1]
    if (!validDate(dateStr)) {
      return Response.json({ error: "invalid date; expected YYYY-MM-DD" }, { status: 400 })
    }
    const forDate = items.filter(i => i.date === dateStr)
    return Response.json(sortByDateDesc(forDate))
  }

  if (route === "/knowledge") {
    return Response.json(loadKnowledge({ windowDays: ITEMS_WINDOW_DAYS }))
  }

  if (route === "/knowledge/stats") {
    return Response.json(knowledgeStats(items))
  }

  const knowledgeDateMatch = route.match(/^\/knowledge\/(.+)$/)
  if (knowledgeDateMatch) {
    const dateStr = knowledgeDateMatch[1]
    if (!validDate(dateStr)) {
      return Response.json({ error: "invalid date; expected YYYY-MM-DD" }, { status: 400 })
    }
    return Response.json(loadKnowledge({ date: dateStr }))
  }

  return Response.json({ error: "Not found" }, { status: 404 })
}
