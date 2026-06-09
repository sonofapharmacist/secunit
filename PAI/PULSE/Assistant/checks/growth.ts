#!/usr/bin/env bun
/**
 * Assistant Growth — check script (runs weekly, Sunday 4am)
 *
 * Reads recent diary entries and observability signals, then updates
 * opinions.yaml with any new patterns worth recording.
 *
 * Output: NO_ACTION (growth is background; no voice dispatch).
 */

import { join } from "path"
import { existsSync, readFileSync, appendFileSync } from "fs"

const HOME = process.env.HOME ?? "~"
const PAI_DIR = join(HOME, ".claude", "PAI")
const DIARY_PATH = join(PAI_DIR, "PULSE", "state", "da", "diary.jsonl")
const GROWTH_PATH = join(PAI_DIR, "PULSE", "state", "da", "growth.jsonl")
const OPINIONS_PATH = join(PAI_DIR, "USER", "OPINIONS.md")

interface DiaryEntry {
  date: string
  interaction_count: number
  topics: string[]
  mood: "positive" | "neutral" | "frustrated"
  avg_rating: number
  notable_moments: string[]
  learning: string | null
}

function recentDiary(days = 7): DiaryEntry[] {
  if (!existsSync(DIARY_PATH)) return []
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  return readFileSync(DIARY_PATH, "utf-8")
    .split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter((e): e is DiaryEntry => e?.date >= cutoff)
}

async function extractInsights(entries: DiaryEntry[]): Promise<string | null> {
  if (!entries.length) return null

  const claudePath = Bun.which("claude") ?? join(HOME, ".local", "bin", "claude")
  const summary = entries.map(e =>
    `${e.date}: ${e.interaction_count} sessions, topics: ${e.topics.join(", ")}, mood: ${e.mood}`
  ).join("\n")

  const prompt = `Review this week's work diary entries and identify ONE specific pattern or preference worth noting. Be concrete.

Diary:
${summary}

If there's a clear pattern, output it as:
PATTERN: <one sentence under 25 words>

If nothing notable, output:
NO_PATTERN`

  const env: Record<string, string> = { ...process.env, HOME: process.env.HOME ?? "" } as Record<string, string>
  delete env.ANTHROPIC_API_KEY

  const proc = Bun.spawn(
    [claudePath, "--print", "--model", "claude-haiku-4-5-20251001", "--tools", "", "--output-format", "text", "--setting-sources", "", "--system-prompt", ""],
    { stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", env }
  )

  const output = (await new Response(proc.stdout).text()).trim()
  await proc.exited

  const match = output.match(/^PATTERN:\s*(.+)/)
  return match ? match[1].trim() : null
}

async function main() {
  const entries = recentDiary(7)
  const insight = await extractInsights(entries)

  if (insight) {
    const growthEvent = {
      timestamp: new Date().toISOString(),
      type: "observation",
      details: insight,
    }
    appendFileSync(GROWTH_PATH, JSON.stringify(growthEvent) + "\n")

    // Append to the Forming Opinions section of OPINIONS.md
    if (existsSync(OPINIONS_PATH)) {
      const current = readFileSync(OPINIONS_PATH, "utf-8")
      const marker = "## Forming opinions"
      if (current.includes(marker)) {
        const updated = current.replace(
          marker,
          `${marker}\n\n- ${insight} (${new Date().toISOString().slice(0, 10)})`
        )
        await Bun.write(OPINIONS_PATH, updated)
      }
    }
  }

  console.log("NO_ACTION")
}

main().catch(err => {
  console.error(`growth error: ${err}`)
  console.log("NO_ACTION")
})
