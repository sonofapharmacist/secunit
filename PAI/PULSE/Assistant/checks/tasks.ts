#!/usr/bin/env bun
/**
 * Assistant Tasks — check script (runs every minute)
 *
 * Reads scheduled-tasks.jsonl, fires any due tasks, updates statuses.
 * Output: notification text (voice) or NO_ACTION.
 */

import { join } from "path"
import { existsSync, readFileSync, writeFileSync } from "fs"

const HOME = process.env.HOME ?? "~"
const STATE_PATH = join(HOME, ".claude", "PAI", "PULSE", "state", "da", "scheduled-tasks.jsonl")

interface ScheduledTask {
  id: string
  created_at: string
  created_by: string
  description: string
  schedule: { type: string; cron?: string; at?: string }
  action: { type: string; message?: string; channel?: string }
  status: "active" | "completed" | "cancelled"
  last_fired?: string
  fire_count: number
  tags: string[]
}

function matchesCron(expression: string, now: Date): boolean {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return false

  function parseField(field: string, min: number, max: number): Set<number> | "any" {
    if (field === "*") return "any"
    const result = new Set<number>()
    for (const part of field.split(",")) {
      if (part.includes("/")) {
        const [range, step] = part.split("/")
        const stepN = parseInt(step)
        const start = range === "*" ? min : parseInt(range)
        for (let i = start; i <= max; i += stepN) result.add(i)
      } else if (part.includes("-")) {
        const [lo, hi] = part.split("-").map(Number)
        for (let i = lo; i <= hi; i++) result.add(i)
      } else {
        result.add(parseInt(part))
      }
    }
    return result
  }

  const fields = [
    parseField(parts[0], 0, 59),
    parseField(parts[1], 0, 23),
    parseField(parts[2], 1, 31),
    parseField(parts[3], 1, 12),
    parseField(parts[4], 0, 6),
  ]
  const actuals = [now.getMinutes(), now.getHours(), now.getDate(), now.getMonth() + 1, now.getDay()]
  return fields.every((f, i) => f === "any" || (f as Set<number>).has(actuals[i]))
}

function readTasks(): ScheduledTask[] {
  if (!existsSync(STATE_PATH)) return []
  return readFileSync(STATE_PATH, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean) as ScheduledTask[]
}

function writeTasks(tasks: ScheduledTask[]) {
  writeFileSync(STATE_PATH, tasks.map(t => JSON.stringify(t)).join("\n") + (tasks.length ? "\n" : ""))
}

function isDue(task: ScheduledTask, now: Date): boolean {
  if (task.status !== "active") return false
  const { schedule } = task

  if (schedule.type === "once" && schedule.at) {
    const at = new Date(schedule.at)
    // Due if at <= now and hasn't been fired
    return at <= now && !task.last_fired
  }

  if (schedule.type === "recurring" && schedule.cron) {
    if (!matchesCron(schedule.cron, now)) return false
    // Don't fire more than once per minute
    if (!task.last_fired) return true
    return Math.floor(now.getTime() / 60_000) > Math.floor(new Date(task.last_fired).getTime() / 60_000)
  }

  return false
}

async function main() {
  const now = new Date()
  const tasks = readTasks()
  const due = tasks.filter(t => isDue(t, now))

  if (due.length === 0) {
    console.log("NO_ACTION")
    return
  }

  const messages: string[] = []
  const updated = tasks.map(t => {
    const task = due.find(d => d.id === t.id)
    if (!task) return t

    const msg = task.action.message ?? task.description
    messages.push(msg)

    if (task.schedule.type === "once") {
      return { ...t, status: "completed" as const, last_fired: now.toISOString(), fire_count: t.fire_count + 1 }
    }
    return { ...t, last_fired: now.toISOString(), fire_count: t.fire_count + 1 }
  })

  writeTasks(updated)
  console.log(messages.join(". "))
}

main().catch(err => {
  console.error(`assistant-tasks error: ${err}`)
  console.log("NO_ACTION")
})
