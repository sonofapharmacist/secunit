#!/usr/bin/env bun
/**
 * add-frontmatter.ts
 * One-shot tool: prepend YAML frontmatter to USER/ files that lack it.
 * Run with: bun TOOLS/add-frontmatter.ts [--dry-run]
 */

import { readFileSync, writeFileSync } from "fs"
import { join } from "path"

const HOME = process.env.HOME ?? ""
const PAI_DIR = join(HOME, ".claude", "PAI")
const USER_DIR = join(PAI_DIR, "USER")
const DRY_RUN = process.argv.includes("--dry-run")
const DATE = "2026-05-05"

interface FM {
  category: string
  kind: string
  publish: string
  last_updated?: string
}

const FILES: Record<string, FM> = {
  // Root content files
  "AI_WRITING_PATTERNS.md":  { category: "voice",     kind: "reference",  publish: "false" },
  "ARCHITECTURE.md":         { category: "ops",        kind: "reference",  publish: "false" },
  "DEFINITIONS.md":          { category: "mind",       kind: "reference",  publish: "daemon" },
  "FEED.md":                 { category: "ops",        kind: "reference",  publish: "false" },
  "OPINIONS.md":             { category: "identity",   kind: "narrative",  publish: "false" },
  "OUR_STORY.md":            { category: "identity",   kind: "narrative",  publish: "false" },
  "PRONUNCIATIONS.md":       { category: "voice",      kind: "reference",  publish: "false" },
  "RHETORICALSTYLE.md":      { category: "voice",      kind: "narrative",  publish: "false" },
  "WRITINGSTYLE.md":         { category: "voice",      kind: "narrative",  publish: "false" },
  "README.md":               { category: "identity",   kind: "index",      publish: "false" },

  // BUSINESS
  "BUSINESS/AOS.md":         { category: "domain",     kind: "narrative",  publish: "false" },
  "BUSINESS/README.md":      { category: "domain",     kind: "index",      publish: "false" },

  // FINANCES
  "FINANCES/ACCOUNTS.md":    { category: "domain",     kind: "reference",  publish: "false" },
  "FINANCES/EXPENSES.md":    { category: "domain",     kind: "reference",  publish: "false" },
  "FINANCES/FINANCES.md":    { category: "domain",     kind: "narrative",  publish: "false" },
  "FINANCES/GOALS.md":       { category: "domain",     kind: "narrative",  publish: "false" },
  "FINANCES/INCOME.md":      { category: "domain",     kind: "reference",  publish: "false" },
  "FINANCES/INVESTMENTS.md": { category: "domain",     kind: "reference",  publish: "false" },
  "FINANCES/TAXES.md":       { category: "domain",     kind: "reference",  publish: "false" },

  // HEALTH
  "HEALTH/CONDITIONS.md":    { category: "shape",      kind: "narrative",  publish: "false" },
  "HEALTH/FITNESS.md":       { category: "shape",      kind: "narrative",  publish: "false" },
  "HEALTH/HISTORY.md":       { category: "shape",      kind: "reference",  publish: "false" },
  "HEALTH/MEDICATIONS.md":   { category: "shape",      kind: "reference",  publish: "false" },
  "HEALTH/METRICS.md":       { category: "shape",      kind: "metric",     publish: "false" },
  "HEALTH/NUTRITION.md":     { category: "shape",      kind: "narrative",  publish: "false" },
  "HEALTH/PROVIDERS.md":     { category: "shape",      kind: "reference",  publish: "false" },
  "HEALTH/routine.md":       { category: "shape",      kind: "narrative",  publish: "false" },

  // PROJECTS
  "PROJECTS/PROJECTS.md":    { category: "domain",     kind: "reference",  publish: "false" },

  // TELOS — use PRINCIPAL_TELOS sparingly (auto-generated)
  "TELOS/README.md":                { category: "domain", kind: "index",    publish: "false" },
  "TELOS/CURRENT_STATE/README.md":  { category: "domain", kind: "index",    publish: "false" },
  "TELOS/IDEAL_STATE/README.md":    { category: "domain", kind: "index",    publish: "false" },
  "TELOS/PRINCIPAL_TELOS.md":       { category: "domain", kind: "narrative", publish: "false" },

  // WORK
  "WORK/README.md":          { category: "ops",        kind: "index",      publish: "false" },
  "WORK/expenses.md":        { category: "ops",        kind: "reference",  publish: "false" },

  // Infrastructure READMEs — minimal index entries so scorer doesn't flag them
  "ACTIONS/README.md":         { category: "ops", kind: "index", publish: "false" },
  "ARTHUR/README.md":          { category: "ops", kind: "index", publish: "false" },
  "Config/README.md":          { category: "ops", kind: "index", publish: "false" },
  "Daemon/README.md":          { category: "ops", kind: "index", publish: "false" },
  "DA/README.md":              { category: "ops", kind: "index", publish: "false" },
  "FLOWS/README.md":           { category: "ops", kind: "index", publish: "false" },
  "PIPELINES/README.md":       { category: "ops", kind: "index", publish: "false" },
  "SECURITY/README.md":        { category: "ops", kind: "index", publish: "false" },
  "SHARED/README.md":          { category: "ops", kind: "index", publish: "false" },
  "SKILLCUSTOMIZATIONS/README.md": { category: "ops", kind: "index", publish: "false" },
  "TERMINAL/README.md":        { category: "ops", kind: "index", publish: "false" },
}

function buildFrontmatter(fm: FM): string {
  const lu = fm.last_updated ?? DATE
  return `---\ncategory: ${fm.category}\nkind: ${fm.kind}\npublish: ${fm.publish}\nlast_updated: ${lu}\n---\n`
}

function hasFrontmatter(content: string): boolean {
  return content.startsWith("---\n")
}

let updated = 0
let skipped = 0

for (const [relPath, fm] of Object.entries(FILES)) {
  const absPath = join(USER_DIR, relPath)
  let content: string
  try {
    content = readFileSync(absPath, "utf-8")
  } catch {
    console.warn(`  SKIP (not found): ${relPath}`)
    skipped++
    continue
  }

  if (hasFrontmatter(content)) {
    console.log(`  SKIP (has FM): ${relPath}`)
    skipped++
    continue
  }

  const newContent = buildFrontmatter(fm) + content
  if (DRY_RUN) {
    console.log(`  DRY-RUN: ${relPath} → category:${fm.category} kind:${fm.kind}`)
  } else {
    writeFileSync(absPath, newContent, "utf-8")
    console.log(`  WROTE: ${relPath} → category:${fm.category} kind:${fm.kind}`)
  }
  updated++
}

console.log(`\nDone — ${updated} updated, ${skipped} skipped${DRY_RUN ? " (dry-run)" : ""}`)
