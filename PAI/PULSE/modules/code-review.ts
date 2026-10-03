/**
 * Code Review Pulse Module
 *
 * Serves the nightly autopilot code-review queue (NightlyCodeReview.ts)
 * over HTTP. Report-only — findings are never auto-applied.
 *
 * Routes (all GET):
 *   /queue           → open findings (new, recurring, resurfaced, confirmed), newest first
 *   /queue/:repo     → open findings for a specific repo label
 *   /summary         → finding counts by status, overall and per repo
 *
 * Status lifecycle and legacy-row handling live in TOOLS/lib/review-queue.ts.
 */

import { join } from "node:path"
import { countByStatus, isOpen, loadQueue as loadQueueFile, type Finding } from "../../TOOLS/lib/review-queue"

const HOME = process.env.HOME ?? ""
const QUEUE_PATH = join(HOME, ".claude", "PAI", "MEMORY", "STATE", "code-review-queue.jsonl")
const MODULE_NAME = "code-review"

interface ModuleState {
  running: boolean
  startedAt: Date | null
}

const state: ModuleState = {
  running: false,
  startedAt: null,
}

function loadQueue(): Finding[] {
  try {
    return loadQueueFile(QUEUE_PATH).sort((a, b) => b.last_seen.localeCompare(a.last_seen))
  } catch (err) {
    console.warn(`[${MODULE_NAME}] failed to read queue: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
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
  const all = loadQueue()
  const unresolved = all.filter((f) => isOpen(f.status))

  if (path === "/summary") {
    const repos = [...new Set(all.map((f) => f.repo))]
    return Response.json({ total: countByStatus(all), byRepo: Object.fromEntries(repos.map((r) => [r, countByStatus(all.filter((f) => f.repo === r))])) })
  }

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
