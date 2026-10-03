#!/usr/bin/env bun
/**
 * PAI Pulse — morning digest (alerting ISA F5).
 *
 * One message at 07:00 covering the last 24 h: alerts by severity and source,
 * the nightly review tally plus the open queue, Pulse job failures, disk, the
 * doc-drift backlog, and climb/confirm results. An empty day still sends one
 * line, so a missing digest means something broke.
 *
 * Delivery: email when SMTP is configured (D3), otherwise a silent ntfy
 * message at priority 2. The digest is also written to
 * MEMORY/OBSERVABILITY/digests/YYYY-MM-DD.md.
 *
 *   bun MorningDigest.ts             # gather, deliver, archive
 *   bun MorningDigest.ts --dry-run   # print only
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { join } from "path"
import { spawnSync } from "child_process"
import { loadNotificationSettings, ntfyChannel } from "./NotifyChannels"
import { countByStatus, isOpen, loadQueue, type Status } from "../TOOLS/lib/review-queue"

const DAY = 24 * 60 * 60_000

export interface AlertRow {
  ts: string
  title: string
  message: string
  severity: "P0" | "P1" | "P2"
  source?: string
  governor?: string
}

export interface DigestInput {
  now: number
  timeZone: string
  alerts: AlertRow[] // already limited to the last 24 h
  failingJobs: Array<{ name: string; failures: number; lastResult: string }>
  reviewOpen: number
  reviewByStatus: Record<string, number>
  diskPct: number | null
  docDrift: number | null
  results: Array<{ path: string; line: string }> // climb/confirm summaries written in the window
  pulseUrl?: string
}

export interface Digest {
  title: string
  markdown: string
  empty: boolean
}

const DISK_WARN = 80
/** Sources that are activity, not news: logged, never summarized. */
export const CHATTER_SOURCES = new Set(["prompt-title"])

export function buildDigest(d: DigestInput): Digest {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: d.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d.now))
  const pushed = d.alerts.filter((a) => a.severity !== "P2" && a.governor !== "dedup")
  const p2 = d.alerts.filter((a) => a.severity === "P2" && a.governor !== "dedup" && !CHATTER_SOURCES.has(a.source ?? ""))
  const tallies = p2.filter((a) => a.source === "nightly-review")
  const otherP2 = p2.filter((a) => a.source !== "nightly-review")

  const notable =
    pushed.length > 0 || otherP2.length > 0 || d.failingJobs.length > 0 || d.results.length > 0 ||
    (d.diskPct !== null && d.diskPct >= DISK_WARN)

  const status = [
    d.diskPct !== null ? `disk ${d.diskPct}%` : "disk ?",
    `review queue ${d.reviewOpen} open`,
    d.docDrift !== null ? `doc drift ${d.docDrift}` : null,
  ].filter(Boolean).join(" · ")

  if (!notable) {
    const ran = tallies.length ? ` Nightly review ran (${tallies.length} repo${tallies.length === 1 ? "" : "s"}), nothing new.` : " Nightly review did not report."
    return { title: `PAI digest ${date}: quiet`, markdown: `Nothing needed you in the last 24 h.${ran} ${status}.`, empty: true }
  }

  const out: string[] = []
  if (pushed.length) {
    out.push(`**Pushed or held (${pushed.length})**`)
    for (const a of pushed.slice(0, 15)) out.push(`- ${a.severity} ${a.source ?? "?"}: ${a.title}${a.governor && a.governor !== "send" ? ` _(${a.governor})_` : ""}`)
    if (pushed.length > 15) out.push(`- …and ${pushed.length - 15} more`)
    out.push("")
  }
  out.push("**Nightly review**")
  if (tallies.length) for (const t of tallies) out.push(`- ${t.title.replace(/^Nightly review: /, "")}: ${t.message}`)
  else out.push("- No run reported in the window.")
  const statusCounts = Object.entries(d.reviewByStatus).filter(([k, n]) => n > 0 && isOpen(k as Status)).map(([k, n]) => `${k} ${n}`).join(", ")
  out.push(`- Queue: ${d.reviewOpen} open${statusCounts ? ` (${statusCounts})` : ""}`)
  out.push("")
  if (d.failingJobs.length) {
    out.push("**Pulse jobs failing**")
    for (const j of d.failingJobs) out.push(`- ${j.name}: ${j.failures} consecutive (${j.lastResult})`)
    out.push("")
  }
  if (d.results.length) {
    out.push("**Results**")
    for (const r of d.results.slice(0, 8)) out.push(`- ${r.path}: ${r.line}`)
    out.push("")
  }
  if (otherP2.length) {
    const bySource = new Map<string, number>()
    for (const a of otherP2) {
      const key = a.source ?? `"${a.title.slice(0, 40)}"`
      bySource.set(key, (bySource.get(key) ?? 0) + 1)
    }
    out.push(`**Other notices (${otherP2.length})**`)
    for (const [src, n] of [...bySource].sort((x, y) => y[1] - x[1]).slice(0, 10)) out.push(`- ${src}: ${n}`)
    out.push("")
  }
  out.push(`_${status}${d.diskPct !== null && d.diskPct >= DISK_WARN ? " ⚠ disk high" : ""}_`)
  if (d.pulseUrl) out.push(`[Pulse](${d.pulseUrl})`)
  return { title: `PAI digest ${date}`, markdown: out.join("\n"), empty: false }
}

// ── gathering (impure) ──

const PAI = process.env.PAI_DIR ?? join(process.env.HOME ?? "~", ".claude", "PAI")

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const rows: T[] = []
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* skip torn line */ }
  }
  return rows
}

function diskPct(): number | null {
  const r = spawnSync("df", ["--output=pcent", "/"], { encoding: "utf-8", stdio: "pipe" })
  const m = r.stdout?.match(/(\d+)%/)
  return m ? Number(m[1]) : null
}

function recentResults(since: number): Array<{ path: string; line: string }> {
  const out: Array<{ path: string; line: string }> = []
  const work = join(PAI, "MEMORY", "WORK")
  if (!existsSync(work)) return out
  for (const isa of readdirSync(work)) {
    const dir = join(work, isa)
    let subs: string[] = []
    try { subs = readdirSync(dir) } catch { continue }
    for (const sub of subs) {
      for (const name of ["confirm-summary.jsonl", "proposals.jsonl"]) {
        const p = join(dir, sub, name)
        if (!existsSync(p) || statSync(p).mtimeMs < since) continue
        const last = readJsonl<Record<string, unknown>>(p).at(-1)
        const verdict = last ? String(last.verdict ?? last.reason ?? last.summary ?? "").slice(0, 200) : ""
        out.push({ path: `${sub}/${name}`, line: verdict || "updated" })
      }
    }
  }
  return out
}

/** Names of [[job]] blocks not set to enabled = false. Only the two keys matter here. */
export function enabledJobs(toml: string): Set<string> {
  const out = new Set<string>()
  for (const block of toml.split(/^\[\[job\]\]\s*$/m).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1]
    if (name && !/^enabled\s*=\s*false\b/m.test(block)) out.add(name)
  }
  return out
}

export function gather(now: number): DigestInput {
  const since = now - DAY
  const alerts = readJsonl<AlertRow>(join(PAI, "MEMORY", "OBSERVABILITY", "alerts.jsonl")).filter((a) => Date.parse(a.ts) >= since)

  let failingJobs: DigestInput["failingJobs"] = []
  try {
    const state = JSON.parse(readFileSync(join(PAI, "PULSE", "state", "state.json"), "utf-8"))
    // Disabled jobs keep stale failure counts in state; only enabled ones are news.
    const enabled = enabledJobs(readFileSync(join(PAI, "PULSE", "PULSE.toml"), "utf-8"))
    failingJobs = Object.entries<any>(state.jobs ?? {})
      .filter(([name, j]) => enabled.has(name) && (j.consecutiveFailures ?? 0) > 0)
      .map(([name, j]) => ({ name, failures: j.consecutiveFailures, lastResult: String(j.lastResult ?? "?") }))
  } catch { /* no state yet */ }

  const queue = loadQueue(join(PAI, "MEMORY", "STATE", "code-review-queue.jsonl"))
  const byStatus = countByStatus(queue) as Record<string, number>

  let docDrift: number | null = null
  try {
    const q = JSON.parse(readFileSync(join(PAI, "MEMORY", "STATE", "doc-semantic-queue.json"), "utf-8"))
    docDrift = Array.isArray(q) ? q.length : null
  } catch { /* none */ }

  return {
    now,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    alerts,
    failingJobs,
    reviewOpen: queue.filter((f) => isOpen(f.status)).length,
    reviewByStatus: byStatus,
    diskPct: diskPct(),
    docDrift,
    results: recentResults(since),
    pulseUrl: process.env.PAI_PULSE_URL,
  }
}

// ── delivery ──

async function deliver(d: Digest): Promise<string> {
  // Email (D3) lands here once SMTP is configured; until then, silent ntfy.
  const ntfy = ntfyChannel(loadNotificationSettings().ntfy ?? {}, process.env)
  if (!ntfy) return "none (no channel configured; archived only)"
  await ntfy.send({ title: d.title, message: d.markdown, severity: "P2", source: "morning-digest", id: "digest", markdown: true })
  return ntfy.name
}

if (import.meta.main) {
  const now = Date.now()
  const digest = buildDigest(gather(now))
  if (process.argv.includes("--dry-run")) {
    console.log(`${digest.title}\n\n${digest.markdown}`)
    process.exit(0)
  }
  const dir = join(PAI, "MEMORY", "OBSERVABILITY", "digests")
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${digest.title.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "undated"}.md`)
  writeFileSync(file, `# ${digest.title}\n\n${digest.markdown}\n`)
  const via = await deliver(digest)
  console.log(`[MorningDigest] ${digest.empty ? "quiet day" : "digest"} → ${via}; archived ${file}`)
}
