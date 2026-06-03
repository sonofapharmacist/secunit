#!/usr/bin/env bun
/**
 * TLDRSurface — surface actionable project suggestions from TLDR knowledge corpus.
 *
 * Reads KnowledgeEntry files extracted by TLDRHarvest.ts, filters to entries
 * with work_application or pai_relevance, routes to active projects, and
 * outputs grouped suggestions to stdout. Nothing is written to PROJECTS_TODO.md —
 * output is for human review; cherry-pick what's worth promoting.
 *
 * Usage:
 *   bun TLDRSurface.ts                    # today's entries
 *   bun TLDRSurface.ts --date 2026-05-11  # specific date
 *   bun TLDRSurface.ts --window-days 7    # last 7 days
 *   bun TLDRSurface.ts --all              # entire corpus
 *   bun TLDRSurface.ts --project asa      # filter to ASA only
 *   bun TLDRSurface.ts --project pai      # filter to PAI Infrastructure only
 *   bun TLDRSurface.ts --save             # also append to MEMORY/STATE/tldr-suggestions.md
 *   bun TLDRSurface.ts --help
 */

import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const HOME = process.env.HOME ?? ""
const PAI_DIR = join(HOME, ".claude", "PAI")
const KNOWLEDGE_ROOT = join(PAI_DIR, "MEMORY", "KNOWLEDGE", "TLDR")
const STATE_DIR = join(PAI_DIR, "MEMORY", "STATE")
const SUGGESTIONS_FILE = join(STATE_DIR, "tldr-suggestions.md")
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type KnowledgeCategory = "work-security" | "work-ai" | "pai-development" | "industry-narrative"
type ProjectKey = "ASA" | "PAI"

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

interface CliArgs {
  date: string | null
  windowDays: number | null
  all: boolean
  project: ProjectKey | null
  save: boolean
  showHelp: boolean
}

interface SurfaceItem {
  entry: KnowledgeEntry
  projects: ProjectKey[]
}

function todayInChicago(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" })
}

function printHelp(): void {
  console.log([
    "TLDRSurface — surface actionable project suggestions from TLDR knowledge corpus.",
    "",
    "Usage:",
    "  bun TLDRSurface.ts [flags]",
    "",
    "Flags:",
    "  --date YYYY-MM-DD    Entries for a specific date (default: today)",
    "  --window-days N      Entries from last N days",
    "  --all                Entire corpus regardless of date",
    "  --project asa|pai    Filter to a specific project",
    "  --save               (no-op — always saves to MEMORY/STATE/tldr-suggestions.md)",
    "  --help               Show this help and exit",
    "",
    `Knowledge: ${KNOWLEDGE_ROOT}/YYYY-MM/{id}.json`,
    `Staging:   ${SUGGESTIONS_FILE}`,
    "",
    "Nothing is written to PROJECTS_TODO.md — review and cherry-pick manually.",
  ].join("\n"))
}

function parseArgs(argv: string[]): CliArgs {
  let date: string | null = null
  let windowDays: number | null = null
  let all = false
  let project: ProjectKey | null = null
  let save = false
  let showHelp = false

  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i]
    if (tok === "--help" || tok === "-h") { showHelp = true; continue }
    if (tok === "--all") { all = true; continue }
    if (tok === "--save") { save = true; continue }
    if (tok === "--date") {
      const v = argv[i + 1]
      if (!v) { console.error("[!] --date requires YYYY-MM-DD"); process.exit(2) }
      if (!DATE_RE.test(v)) { console.error(`[!] --date must match YYYY-MM-DD, got: ${v}`); process.exit(2) }
      date = v; i += 1; continue
    }
    if (tok === "--window-days") {
      const v = argv[i + 1]
      if (!v) { console.error("[!] --window-days requires a number"); process.exit(2) }
      const n = parseInt(v, 10)
      if (!Number.isFinite(n) || n < 1) { console.error(`[!] --window-days must be a positive integer, got: ${v}`); process.exit(2) }
      windowDays = n; i += 1; continue
    }
    if (tok === "--project") {
      const v = argv[i + 1]?.toLowerCase()
      if (!v) { console.error("[!] --project requires asa or pai"); process.exit(2) }
      if (v === "asa") { project = "ASA"; i += 1; continue }
      if (v === "pai") { project = "PAI"; i += 1; continue }
      console.error(`[!] --project must be asa or pai, got: ${v}`); process.exit(2)
    }
    console.error(`[!] unknown argument: ${tok}`); process.exit(2)
  }

  if (showHelp) return { date: null, windowDays: null, all: false, project: null, save: false, showHelp: true }
  if (!all && windowDays === null && date === null) date = todayInChicago()
  return { date, windowDays, all, project, save, showHelp: false }
}

function cutoffDate(args: CliArgs): string | null {
  if (args.windowDays !== null) {
    return new Date(Date.now() - args.windowDays * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10)
  }
  return null
}

function loadEntries(args: CliArgs): KnowledgeEntry[] {
  if (!existsSync(KNOWLEDGE_ROOT)) return []
  const entries: KnowledgeEntry[] = []
  const cutoff = cutoffDate(args)

  for (const month of readdirSync(KNOWLEDGE_ROOT).sort()) {
    const monthDir = join(KNOWLEDGE_ROOT, month)
    try {
      for (const file of readdirSync(monthDir)) {
        if (!file.endsWith(".json")) continue
        try {
          const entry = JSON.parse(readFileSync(join(monthDir, file), "utf8")) as KnowledgeEntry
          if (args.all) {
            entries.push(entry)
          } else if (args.date !== null) {
            if (entry.date === args.date) entries.push(entry)
          } else if (cutoff !== null) {
            if (entry.date >= cutoff) entries.push(entry)
          }
        } catch { /* skip corrupt file */ }
      }
    } catch { /* skip unreadable dir */ }
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date))
}

function routeEntry(entry: KnowledgeEntry): ProjectKey[] {
  const projects = new Set<ProjectKey>()
  switch (entry.category) {
    case "work-security":
      projects.add("ASA")
      break
    case "work-ai":
      projects.add("ASA") // vibe scanner IS ASA
      if (entry.pai_relevance !== null) projects.add("PAI")
      break
    case "pai-development":
      projects.add("PAI")
      if (entry.work_application !== null) projects.add("ASA")
      break
    case "industry-narrative":
      if (entry.work_application !== null) projects.add("ASA")
      if (entry.pai_relevance !== null) projects.add("PAI")
      break
  }
  return [...projects]
}

function isText(v: string | null): v is string {
  return v !== null && v !== "null" && v.trim().length > 0
}

function isActionable(entry: KnowledgeEntry): boolean {
  return isText(entry.work_application) || isText(entry.pai_relevance)
}

function actionText(entry: KnowledgeEntry, project: ProjectKey): string {
  const wa = entry.work_application
  const pr = entry.pai_relevance
  if (project === "ASA" && isText(wa)) return wa
  if (project === "PAI" && isText(pr)) return pr
  if (isText(wa)) return wa
  if (isText(pr)) return pr
  return ""
}

function renderOutput(items: SurfaceItem[], args: CliArgs, dateLabel: string): string {
  const lines: string[] = []
  const projectFilter = args.project

  const byProject = new Map<ProjectKey, Array<{ item: SurfaceItem; action: string }>>()
  for (const item of items) {
    for (const proj of item.projects) {
      if (projectFilter !== null && proj !== projectFilter) continue
      if (!byProject.has(proj)) byProject.set(proj, [])
      byProject.get(proj)!.push({ item, action: actionText(item.entry, proj) })
    }
  }

  const totalDisplayed = [...byProject.values()].reduce((n, arr) => n + arr.length, 0)

  lines.push("════ TLDR SURFACE ═══════════════════════")
  lines.push(`📅 ${dateLabel}  |  ${totalDisplayed} actionable entries\n`)

  if (totalDisplayed === 0) {
    lines.push("No actionable entries for this scope.")
    lines.push("(entries need work_application or pai_relevance set by harvest)")
    return lines.join("\n")
  }

  const order: ProjectKey[] = ["ASA", "PAI"]
  for (const proj of order) {
    const bucket = byProject.get(proj)
    if (!bucket || bucket.length === 0) continue

    const label = proj === "ASA" ? "ASA" : "PAI INFRASTRUCTURE"
    lines.push(`── ${label} ${"─".repeat(Math.max(0, 38 - label.length))}`)

    for (const { item, action } of bucket) {
      const { entry } = item
      const tagStr = entry.tags.slice(0, 4).join(", ")
      lines.push(`- [ ] [${entry.category}] ${entry.title}`)
      if (tagStr) lines.push(`      ${tagStr}`)
      lines.push(`      → ${action}`)
      lines.push("")
    }
  }

  lines.push("─".repeat(41))
  lines.push("[ ] unreviewed  [x] promoted → PROJECTS_TODO  [-] not promoting")
  lines.push("Saved to tldr-suggestions.md — cherry-pick to PROJECTS_TODO.md.")
  return lines.join("\n")
}

function saveToFile(content: string, dateLabel: string): void {
  mkdirSync(STATE_DIR, { recursive: true })
  const header = `\n## ${dateLabel}\n\n`
  appendFileSync(SUGGESTIONS_FILE, header + content + "\n", "utf8")
  console.error(`[+] saved → ${SUGGESTIONS_FILE}`)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.showHelp) { printHelp(); process.exit(0) }

  const entries = loadEntries(args)
  const actionable = entries.filter(isActionable)

  const items: SurfaceItem[] = []
  for (const entry of actionable) {
    const projects = routeEntry(entry)
    if (args.project !== null && !projects.includes(args.project)) continue
    if (projects.length > 0) items.push({ entry, projects })
  }

  let dateLabel: string
  if (args.all) {
    dateLabel = "all dates"
  } else if (args.windowDays !== null) {
    dateLabel = `last ${args.windowDays} days`
  } else {
    dateLabel = args.date ?? todayInChicago()
  }

  const output = renderOutput(items, args, dateLabel)
  console.log(output)

  saveToFile(output, dateLabel)
}

main()
