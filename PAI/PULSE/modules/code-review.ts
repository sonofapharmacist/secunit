/**
 * Code Review Pulse Module
 *
 * Serves the nightly autopilot code-review queue (NightlyCodeReview.ts)
 * over HTTP. Report-only — findings are never auto-applied.
 *
 * Routes (all GET):
 *   /queue           → unresolved findings, newest first
 *   /queue/:repo     → unresolved findings for a specific repo label
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const HOME = process.env.HOME ?? ""
const QUEUE_PATH = join(HOME, ".claude", "PAI", "MEMORY", "STATE", "code-review-queue.jsonl")
const MODULE_NAME = "code-review"

interface Finding {
  id: string
  repo: string
  severity: "high" | "medium" | "low"
  file: string
  line: number | null
  description: string
  created_at: string
  resolved: boolean
}

interface ModuleState {
  running: boolean
  startedAt: Date | null
}

const state: ModuleState = {
  running: false,
  startedAt: null,
}

function loadQueue(): Finding[] {
  if (!existsSync(QUEUE_PATH)) return []
  let raw: string
  try {
    raw = readFileSync(QUEUE_PATH, "utf8")
  } catch (err) {
    console.warn(`[${MODULE_NAME}] failed to read queue: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Finding)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
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
}

export function health(): { status: string; details?: Record<string, unknown> } {
  return {
    status: state.running ? "healthy" : "stopped",
    details: {
      uptime: state.startedAt ? Math.floor((Date.now() - state.startedAt.getTime()) / 1000) : 0,
    },
  }
}

export async function handleRequest(
  path: string,
  _body: Record<string, unknown>
): Promise<Response> {
  const unresolved = loadQueue().filter((f) => !f.resolved)

  if (path === "/queue") {
    return Response.json(unresolved)
  }

  const repoMatch = path.match(/^\/queue\/(.+)$/)
  if (repoMatch) {
    const repo = repoMatch[1]
    return Response.json(unresolved.filter((f) => f.repo === repo))
  }

  return Response.json({ error: "Not found" }, { status: 404 })
}
