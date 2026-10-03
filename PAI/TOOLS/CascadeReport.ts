#!/usr/bin/env bun
/**
 * Per-job cascade escalation report (local-first cascade F4, ISC-22).
 *
 * Reads the `backend: "cascade"` rows lib/cascade.ts writes to inference-calls.jsonl.
 * Escalation rate = escalated / (local + escalated): of the runs where local was
 * allowed to try, how often the verifier sent the job to cloud.
 *
 *   bun CascadeReport.ts            # last 7 days
 *   bun CascadeReport.ts --days 1
 *   bun CascadeReport.ts --json
 */

import { existsSync, readFileSync } from "fs"
import { INFERENCE_LOG_PATH } from "./lib/cascade"

export interface CascadeRow { timestamp: string; backend: string; caller: string; cascade_path: string; reasons?: string[] }

export interface JobStats {
  job: string
  runs: number
  local: number
  escalated: number
  cloudOnly: number
  failed: number
  /** null when local never got to try. */
  escalationRate: number | null
  topReasons: Array<[string, number]>
}

/** Collapse a reason to its class ("local rejected: not JSON: ```json…" → "local rejected: not JSON"). */
export function reasonClass(r: string): string {
  return r.split(":").slice(0, 2).join(":").trim()
}

export function summarize(rows: CascadeRow[], since: number): JobStats[] {
  const by = new Map<string, CascadeRow[]>()
  for (const r of rows) {
    if (r.backend !== "cascade" || Date.parse(r.timestamp) < since) continue
    by.set(r.caller, [...(by.get(r.caller) ?? []), r])
  }
  return [...by].map(([job, rs]) => {
    const n = (p: string) => rs.filter((r) => r.cascade_path === p).length
    const local = n("local"), escalated = n("escalated")
    const reasons = new Map<string, number>()
    for (const r of rs) for (const why of r.reasons ?? []) reasons.set(reasonClass(why), (reasons.get(reasonClass(why)) ?? 0) + 1)
    return {
      job, runs: rs.length, local, escalated, cloudOnly: n("cloud-only"), failed: n("failed"),
      escalationRate: local + escalated ? escalated / (local + escalated) : null,
      topReasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 3),
    }
  }).sort((a, b) => b.runs - a.runs)
}

export function render(stats: JobStats[], days: number): string {
  if (stats.length === 0) return `No cascade runs in the last ${days} day(s).`
  const pct = (x: number | null) => (x === null ? "  n/a" : `${(x * 100).toFixed(1).padStart(5)}%`)
  const lines = [`Cascade, last ${days} day(s)`, "job                          runs  local  esc  cloud  fail  esc-rate"]
  for (const s of stats) {
    lines.push(`${s.job.padEnd(28)} ${String(s.runs).padStart(4)} ${String(s.local).padStart(6)} ${String(s.escalated).padStart(4)} ${String(s.cloudOnly).padStart(6)} ${String(s.failed).padStart(5)}  ${pct(s.escalationRate)}`)
    for (const [why, c] of s.topReasons) lines.push(`    ${c}× ${why}`)
  }
  return lines.join("\n")
}

if (import.meta.main) {
  const i = process.argv.indexOf("--days")
  const days = i > -1 ? Number(process.argv[i + 1]) : 7
  const rows: CascadeRow[] = existsSync(INFERENCE_LOG_PATH)
    ? readFileSync(INFERENCE_LOG_PATH, "utf-8").split("\n").filter((l) => l.includes('"backend":"cascade"')).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
    : []
  const stats = summarize(rows, Date.now() - days * 86_400_000)
  console.log(process.argv.includes("--json") ? JSON.stringify(stats, null, 2) : render(stats, days))
}
