#!/usr/bin/env bun
/**
 * CodeReviewStatus — one-command check on the nightly-code-review cron job
 *
 * Why this exists:
 *   2026-07-08: nightly-code-review silently skipped for 8 days after tripping
 *   Pulse's 3-failure circuit breaker (spawnScript's 60s default timeout killed
 *   a job whose real work takes up to ~840s). There was no single command to
 *   see "is this actually running, and did it find anything" — just curl +
 *   jq against two different Pulse routes. This closes that gap.
 *
 * Usage:
 *   bun PAI/TOOLS/CodeReviewStatus.ts
 *   bun PAI/TOOLS/CodeReviewStatus.ts --repo pai-config
 */

import { join } from "path"
import { loadQueue } from "./lib/review-queue"

const PULSE_BASE = process.env.PULSE_URL ?? "http://localhost:31337"
const QUEUE_PATH = join(process.env.HOME ?? "", ".claude", "PAI", "MEMORY", "STATE", "code-review-queue.jsonl")
const SUPPRESSED_WINDOW_DAYS = 7

interface Finding {
  id: string
  repo: string
  severity: "high" | "medium" | "low"
  file: string
  line: number | null
  description: string
  created_at: string
  resolved: boolean
  /** Absent only if Pulse is still running a pre-2026-09-29 code-review module. */
  status?: string
  times_seen?: number
}

interface JobHealth {
  name: string
  lastRun: string
  agoMs: number
  result: "ok" | "error"
  failures: number
}

function fmtAgo(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const repoIdx = args.indexOf("--repo")
  const repoFilter = repoIdx !== -1 ? args[repoIdx + 1] : undefined

  let health: { subsystems: { cron: { jobs: JobHealth[] } } }
  try {
    const res = await fetch(`${PULSE_BASE}/healthz`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    health = await res.json()
  } catch (err) {
    console.error(`Cannot reach Pulse at ${PULSE_BASE} — is it running? (${err instanceof Error ? err.message : String(err)})`)
    process.exit(1)
  }

  const job = health.subsystems.cron.jobs.find((j) => j.name === "nightly-code-review")
  if (!job) {
    console.error("nightly-code-review job not found in Pulse's cron state — check PULSE.toml")
    process.exit(1)
  }

  console.log("=== nightly-code-review ===")
  console.log(`Last run:   ${fmtAgo(job.agoMs)} (${job.lastRun})`)
  console.log(`Result:     ${job.result}`)
  console.log(`Failures:   ${job.failures}${job.failures >= 3 ? "  ⚠ CIRCUIT BREAKER TRIPPED — job is being skipped" : ""}`)

  const queueUrl = repoFilter ? `${PULSE_BASE}/api/code-review/queue/${repoFilter}` : `${PULSE_BASE}/api/code-review/queue`
  let findings: Finding[]
  try {
    const res = await fetch(queueUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    findings = await res.json()
  } catch (err) {
    console.error(`\nCannot reach code-review queue (${err instanceof Error ? err.message : String(err)})`)
    process.exit(1)
  }

  const bySeverity = { high: 0, medium: 0, low: 0 }
  for (const f of findings) bySeverity[f.severity]++

  console.log(`\nOpen findings: ${findings.length} (high: ${bySeverity.high}, medium: ${bySeverity.medium}, low: ${bySeverity.low})`)
  try {
    const res = await fetch(`${PULSE_BASE}/api/code-review/summary`)
    if (res.ok) {
      const { total, byRepo } = (await res.json()) as { total: Record<string, number>; byRepo: Record<string, Record<string, number>> }
      const counts = repoFilter ? byRepo[repoFilter] ?? {} : total
      console.log(`By status:     ${Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ")}`)
    }
  } catch { /* summary is optional: older Pulse modules lack the route */ }

  if (findings.length > 0) {
    console.log()
    for (const f of findings.slice(0, 10)) {
      const loc = f.line !== null ? `${f.file}:${f.line}` : f.file
      const seen = f.times_seen && f.times_seen > 1 ? ` ×${f.times_seen}` : ""
      console.log(`  [${f.severity}] [${f.status ?? "?"}${seen}] ${f.repo} ${loc}  (${f.id.slice(0, 8)})`)
      console.log(`    ${f.description}`)
    }
    if (findings.length > 10) console.log(`  ... and ${findings.length - 10} more`)
  }

  // Reports the reviewer matched to a false_positive/risk_accepted finding. The match is its
  // claim about an untrusted diff, so show the reports themselves (finding 53c26d94).
  const since = new Date(Date.now() - SUPPRESSED_WINDOW_DAYS * 86_400_000).toISOString()
  const suppressed = loadQueue(QUEUE_PATH)
    .filter((f) => !repoFilter || f.repo === repoFilter)
    .flatMap((f) => (f.suppressed_reports ?? []).filter((r) => r.at >= since).map((r) => ({ f, r })))
  if (suppressed.length > 0) {
    console.log(`\nSuppressed in the last ${SUPPRESSED_WINDOW_DAYS} days (matched to a dismissed finding; check the match is right):`)
    for (const { f, r } of suppressed) {
      console.log(`  [${r.severity}] → ${f.id.slice(0, 8)} (${f.status}) ${f.repo} ${f.file}:${r.line ?? "?"}`)
      console.log(`    ${r.description}`)
    }
  }
}

main()
