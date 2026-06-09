#!/usr/bin/env bun
/**
 * Assistant Heartbeat — check script (runs every 30 min)
 *
 * Two-layer evaluation:
 *   Layer 1 (free): gather context from local state files
 *   Layer 2 (~$0.001): Haiku decides act or NO_ACTION
 *
 * Output: notification text (voice) or HEARTBEAT_OK sentinel.
 */

import { join } from "path"
import { existsSync, readFileSync } from "fs"

const HOME = process.env.HOME ?? "~"
const PAI_DIR = join(HOME, ".claude", "PAI")
const DA_STATE = join(PAI_DIR, "PULSE", "state", "da")
const OBS_DIR = join(PAI_DIR, "MEMORY", "OBSERVABILITY")
const WORK_DIR = join(PAI_DIR, "MEMORY", "WORK")

// ── Layer 1: Context gathering ──

function getTodaysSessions(): number {
  const ppLog = join(OBS_DIR, "prompt-processing.jsonl")
  if (!existsSync(ppLog)) return 0
  const today = new Date().toISOString().slice(0, 10)
  return readFileSync(ppLog, "utf-8")
    .split("\n")
    .filter(Boolean)
    .filter(line => {
      try { return JSON.parse(line).timestamp?.startsWith(today) }
      catch { return false }
    }).length
}

function getLastInteractionHoursAgo(): number {
  const ppLog = join(OBS_DIR, "prompt-processing.jsonl")
  if (!existsSync(ppLog)) return 999
  const lines = readFileSync(ppLog, "utf-8").split("\n").filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i])
      if (entry.timestamp) {
        const diff = Date.now() - new Date(entry.timestamp).getTime()
        return diff / 3_600_000
      }
    } catch { /* skip */ }
  }
  return 999
}

function getActiveTasks(): number {
  const tasksPath = join(DA_STATE, "scheduled-tasks.jsonl")
  if (!existsSync(tasksPath)) return 0
  return readFileSync(tasksPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .filter(line => {
      try { return JSON.parse(line).status === "active" }
      catch { return false }
    }).length
}

function getRecentWork(): { title: string; hoursAgo: number } | null {
  if (!existsSync(WORK_DIR)) return null
  try {
    const dirs = Bun.spawnSync(["ls", "-t", WORK_DIR], { stdout: "pipe" })
      .stdout.toString().split("\n").filter(Boolean)
    if (!dirs.length) return null
    const slug = dirs[0]
    const isaPath = join(WORK_DIR, slug, "ISA.md")
    if (!existsSync(isaPath)) return null
    const stat = Bun.file(isaPath)
    const lastMod = (stat as any).lastModified ?? Date.now()
    return {
      title: slug.replace(/^\d{8}-\d{6}_/, "").replace(/-/g, " "),
      hoursAgo: (Date.now() - lastMod) / 3_600_000,
    }
  } catch { return null }
}

// ── Layer 2: Haiku evaluation ──

async function evaluateWithHaiku(context: object, daName: string, principalName: string): Promise<string> {
  const claudePath = Bun.which("claude") ?? join(HOME, ".local", "bin", "claude")

  const prompt = `You are ${daName}, ${principalName}'s AI assistant. Review this context and decide if you should proactively notify them.

RULES:
- Default to NO_ACTION. Only act when genuinely useful.
- DO notify for: stalled work (>48h with no activity), tasks due soon, important patterns.
- Do NOT notify for: routine status, normal gaps between sessions.
- Keep any notification under 20 words, natural spoken language.

Context:
${JSON.stringify(context, null, 2)}

Respond with ONLY one of:
{"action":"NO_ACTION"}
{"action":"notify","message":"<spoken text under 20 words>"}`

  const env: Record<string, string> = { ...process.env, HOME: process.env.HOME ?? "" } as Record<string, string>
  delete env.ANTHROPIC_API_KEY

  const proc = Bun.spawn(
    [claudePath, "--print", "--model", "claude-haiku-4-5-20251001", "--tools", "", "--output-format", "text", "--setting-sources", "", "--system-prompt", ""],
    { stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", env }
  )

  const output = (await new Response(proc.stdout).text()).trim()
  await proc.exited

  // Extract JSON from output
  const match = output.match(/\{[^}]+\}/)
  if (!match) return "NO_ACTION"

  try {
    const decision = JSON.parse(match[0])
    return decision.action === "notify" ? (decision.message ?? "NO_ACTION") : "NO_ACTION"
  } catch { return "NO_ACTION" }
}

async function main() {
  const context = {
    timestamp: new Date().toISOString(),
    todays_sessions: getTodaysSessions(),
    last_interaction_hours_ago: Math.round(getLastInteractionHoursAgo() * 10) / 10,
    active_tasks: getActiveTasks(),
    recent_work: getRecentWork(),
  }

  const result = await evaluateWithHaiku(context, "Munro", "GP")

  if (!result || result === "NO_ACTION") {
    console.log("HEARTBEAT_OK")
  } else {
    console.log(result)
  }
}

main().catch(err => {
  console.error(`heartbeat error: ${err}`)
  console.log("HEARTBEAT_OK")
})
