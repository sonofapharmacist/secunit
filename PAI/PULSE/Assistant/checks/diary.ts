#!/usr/bin/env bun
/**
 * Assistant Diary — check script (runs daily at 11pm)
 *
 * Reads today's observability signals and completed work, then writes
 * a structured diary entry to state/da/diary.jsonl.
 *
 * Output: NO_ACTION (diary write is fire-and-forget; no voice dispatch).
 */

import { join } from "path"
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "fs"

const HOME = process.env.HOME ?? "~"
const PAI_DIR = join(HOME, ".claude", "PAI")
const DIARY_PATH = join(PAI_DIR, "PULSE", "state", "da", "diary.jsonl")
const OBS_DIR = join(PAI_DIR, "MEMORY", "OBSERVABILITY")
const WORK_DIR = join(PAI_DIR, "MEMORY", "WORK")

interface DiaryEntry {
  date: string
  interaction_count: number
  topics: string[]
  mood: "positive" | "neutral" | "frustrated"
  avg_rating: number
  notable_moments: string[]
  learning: string | null
}

function getTodaysSessions(today: string): { count: number; topics: string[] } {
  const ppLog = join(OBS_DIR, "prompt-processing.jsonl")
  if (!existsSync(ppLog)) return { count: 0, topics: [] }

  const entries = readFileSync(ppLog, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter((e): e is Record<string, string> => e?.timestamp?.startsWith(today))

  const topics = [...new Set(
    entries
      .map(e => e.session_name ?? e.tab_title ?? "")
      .filter(Boolean)
      .map((s: string) => s.replace(/^\d{8}-\d{6}_/, "").replace(/-/g, " ").slice(0, 40))
  )].slice(0, 6)

  return { count: entries.length, topics }
}

function getTodaysWork(today: string): string[] {
  if (!existsSync(WORK_DIR)) return []
  try {
    const dirs = Bun.spawnSync(["ls", "-t", WORK_DIR], { stdout: "pipe" })
      .stdout.toString().split("\n").filter(Boolean)
    return dirs
      .filter(d => d.startsWith(today.replace(/-/g, "")))
      .map(d => d.replace(/^\d{8}-\d{6}_/, "").replace(/-/g, " "))
      .slice(0, 5)
  } catch { return [] }
}

async function summarizeDay(sessions: number, topics: string[], completedWork: string[]): Promise<string | null> {
  if (sessions === 0) return null

  const claudePath = Bun.which("claude") ?? join(HOME, ".local", "bin", "claude")
  const prompt = `Write one sentence (under 20 words) summarizing what was accomplished today in a PAI session. Be specific and concrete.

Sessions: ${sessions}
Topics discussed: ${topics.join(", ") || "various"}
Completed work: ${completedWork.join(", ") || "none"}

Output ONLY the single sentence, nothing else.`

  const env: Record<string, string> = { ...process.env, HOME: process.env.HOME ?? "" } as Record<string, string>
  delete env.ANTHROPIC_API_KEY

  const proc = Bun.spawn(
    [claudePath, "--print", "--model", "claude-haiku-4-5-20251001", "--tools", "", "--output-format", "text", "--setting-sources", "", "--system-prompt", ""],
    { stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", env }
  )

  const output = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  return output.slice(0, 200) || null
}

async function main() {
  const today = new Date().toISOString().slice(0, 10)

  // Don't write duplicate entries
  if (existsSync(DIARY_PATH)) {
    const existing = readFileSync(DIARY_PATH, "utf-8")
      .split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
    if (existing.some((e: Record<string, unknown>) => e.date === today)) {
      console.log("NO_ACTION")
      return
    }
  }

  const { count: sessions, topics } = getTodaysSessions(today)
  const completedWork = getTodaysWork(today)
  const notable = await summarizeDay(sessions, topics, completedWork)

  mkdirSync(join(PAI_DIR, "PULSE", "state", "da"), { recursive: true })

  const entry: DiaryEntry = {
    date: today,
    interaction_count: sessions,
    topics: topics.length ? topics : completedWork.slice(0, 3),
    mood: sessions > 5 ? "positive" : sessions > 0 ? "neutral" : "neutral",
    avg_rating: 0,
    notable_moments: notable ? [notable] : [],
    learning: null,
  }

  appendFileSync(DIARY_PATH, JSON.stringify(entry) + "\n")
  console.log("NO_ACTION")
}

main().catch(err => {
  console.error(`diary error: ${err}`)
  console.log("NO_ACTION")
})
