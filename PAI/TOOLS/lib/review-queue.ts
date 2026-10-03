/**
 * review-queue.ts: lifecycle for NightlyCodeReview findings in MEMORY/STATE/code-review-queue.jsonl.
 *
 * A boolean `resolved` could not say whether a finding was new, seen again, back after a
 * fix, or closed as fixed vs risk-accepted vs a false positive. Status replaces it (2026-09-29);
 * `resolved` is kept, derived from status, for any reader that still checks it.
 *
 * Matching is done by the reviewer, not here. It sees the diff plus prior findings on the
 * same files and names the prior id a finding repeats (`matches`), because repeat reports
 * are paraphrased: "unit-less dollar amounts are stored raw" and "salary parsed as literal
 * dollars" are the same bug with almost no shared words. This module only validates that
 * claim and applies the transition rules, deterministically.
 *
 * The claim comes from a model reading an untrusted diff, so it is never allowed to make a
 * report disappear (finding 53c26d94, 2026-09-30). A report matched to a false_positive or
 * risk_accepted finding is suppressed only when it is not high severity and no more severe
 * than that finding; even then its own text is kept on the prior row (suppressed_reports)
 * and printed in the run log. Otherwise it is a new row linked to the prior.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs"
import { randomUUID } from "crypto"

export const OPEN_STATUSES = ["new", "recurring", "resurfaced", "confirmed"] as const
export const CLOSED_STATUSES = ["fixed", "risk_accepted", "false_positive", "duplicate", "obsolete", "closed"] as const
export type OpenStatus = (typeof OPEN_STATUSES)[number]
export type ClosedStatus = (typeof CLOSED_STATUSES)[number]
export type Status = OpenStatus | ClosedStatus
export type Severity = "high" | "medium" | "low"

export interface Resolution {
  at: string
  by: string
  reason?: string
  commit?: string
}

/** A report the reviewer matched to a false_positive/risk_accepted finding, kept verbatim so a
 * wrong or steered match stays visible instead of vanishing into a count. */
export interface SuppressedReport {
  at: string
  severity: Severity
  line: number | null
  description: string
}

/** Most recent suppressed reports kept per finding. */
export const SUPPRESSED_REPORTS_KEPT = 20

export interface Finding {
  id: string
  repo: string
  severity: Severity
  file: string
  line: number | null
  description: string
  created_at: string
  status: Status
  /** Kept in sync with status for readers that predate it: true iff status is closed. */
  resolved: boolean
  first_seen: string
  last_seen: string
  times_seen: number
  /** resurfaced → the fixed finding it repeats; duplicate → the canonical finding. */
  related_id?: string
  resolution?: Resolution
  suppressed_reports?: SuppressedReport[]
}

/** A finding as a reviewer returns it, before it has an id or a status. */
export interface IncomingFinding {
  severity: Severity
  file: string
  line: number | null
  description: string
  /** Id of a prior finding this repeats, per the reviewer. Validated before use. */
  matches?: string | null
}

export type Outcome =
  | { kind: "new"; id: string }
  | { kind: "recurring"; id: string }
  | { kind: "resurfaced"; id: string; of: string }
  | { kind: "suppressed"; id: string; status: ClosedStatus; description: string }

/** Payload for Pulse /notify (see PULSE/Notify.ts). */
export interface ReviewAlert {
  title: string
  message: string
  severity: "P1" | "P2"
  source: "nightly-review"
  id: string
}

/**
 * Alerts for one applied run (alerting ISA ISC-22): a P1 per high finding that is new or
 * resurfaced, plus one P2 tally for the digest. Recurring and suppressed rows are not
 * news; the tally still counts them. `outcomes[i]` belongs to `incoming[i]`.
 */
export function alertsForRun(repo: string, incoming: IncomingFinding[], outcomes: Outcome[]): ReviewAlert[] {
  const out: ReviewAlert[] = []
  for (const [i, f] of incoming.entries()) {
    const o = outcomes[i]
    if (f.severity !== "high" || !o || (o.kind !== "new" && o.kind !== "resurfaced")) continue
    const where = `${f.file}:${f.line ?? "?"}`
    out.push({
      title: o.kind === "new" ? `New high finding in ${repo}` : `Resurfaced finding in ${repo}`,
      message: `${where} — ${f.description}`.slice(0, 400) + ` [${o.id.slice(0, 8)}]`,
      severity: "P1",
      source: "nightly-review",
      id: o.id.slice(0, 8),
    })
  }
  const n = (k: Outcome["kind"]) => outcomes.filter((o) => o.kind === k).length
  out.push({
    title: `Nightly review: ${repo}`,
    message: `${incoming.length} finding(s): ${n("new")} new, ${n("recurring")} recurring, ${n("resurfaced")} resurfaced, ${n("suppressed")} suppressed.`,
    severity: "P2",
    source: "nightly-review",
    id: `tally-${repo}`.slice(0, 60),
  })
  return out
}

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 }
const REASON_REQUIRED: ReadonlySet<Status> = new Set(["risk_accepted", "false_positive"])

export function isOpen(status: Status): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status)
}

export function isStatus(s: string): s is Status {
  return (OPEN_STATUSES as readonly string[]).includes(s) || (CLOSED_STATUSES as readonly string[]).includes(s)
}

/** Rows written before 2026-09-29 have only `resolved`. Their closed disposition was never
 * recorded, so they become `closed`, not `fixed`: that would claim something nobody checked. */
export function normalize(raw: Record<string, any>): Finding {
  if (typeof raw.status === "string" && isStatus(raw.status)) {
    return { ...raw, resolved: !isOpen(raw.status) } as Finding
  }
  const closed = raw.resolved === true
  return {
    ...(raw as Finding),
    status: closed ? "closed" : "new",
    resolved: closed,
    first_seen: raw.created_at,
    last_seen: raw.created_at,
    times_seen: 1,
    ...(closed ? { resolution: { at: raw.created_at, by: "legacy", reason: "resolved=true before statuses existed; disposition not recorded" } } : {}),
  }
}

export function loadQueue(path: string): Finding[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim()).map((l) => normalize(JSON.parse(l)))
}

/** Whole-file rewrite through a temp file and rename, so a reader never sees half a queue. */
export function saveQueue(path: string, queue: Finding[]): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, queue.map((f) => JSON.stringify(f)).join("\n") + (queue.length ? "\n" : ""))
  renameSync(tmp, path)
}

/** Follows duplicate links to the canonical finding. Stops on a missing target or a cycle. */
function canonical(byId: Map<string, Finding>, f: Finding): Finding {
  const seen = new Set<string>()
  let cur = f
  while (cur.status === "duplicate" && cur.related_id && !seen.has(cur.id)) {
    seen.add(cur.id)
    const next = byId.get(cur.related_id)
    if (!next) break
    cur = next
  }
  return cur
}

/** Prior findings the reviewer should see for these files: open ones plus closed ones it
 * might repeat (fixed → would resurface; false_positive/risk_accepted → would be suppressed).
 * Duplicates are left out since their canonical row is listed. Newest first, capped. */
export function priorFindingsFor(queue: Finding[], repo: string, files: string[], limit = 25): Finding[] {
  const fileSet = new Set(files)
  return queue
    .filter((f) => f.repo === repo && fileSet.has(f.file) && f.status !== "duplicate" && f.status !== "closed")
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen))
    .slice(0, limit)
}

/** Applies one run's findings to the queue. `matches` counts only if it names a real prior
 * finding in the same repo and file; anything else (hallucinated id, wrong file) is new. */
export function applyIncoming(queue: Finding[], repo: string, incoming: IncomingFinding[], now: string): { queue: Finding[]; outcomes: Outcome[] } {
  const next = queue.map((f) => ({ ...f }))
  const byId = new Map(next.map((f) => [f.id, f]))
  const outcomes: Outcome[] = []

  const append = (inc: IncomingFinding, status: OpenStatus, related?: string): Finding => {
    const f: Finding = {
      id: randomUUID(), repo, severity: inc.severity, file: inc.file, line: inc.line ?? null,
      description: inc.description, created_at: now, status, resolved: false,
      first_seen: now, last_seen: now, times_seen: 1, ...(related ? { related_id: related } : {}),
    }
    next.push(f)
    byId.set(f.id, f)
    return f
  }

  // A run that reports the same prior defect twice (two chunks, or two phrasings) saw it once.
  const bumpedThisRun = new Set<string>()

  for (const inc of incoming) {
    const claimed = inc.matches ? byId.get(inc.matches) : undefined
    const prior = claimed && claimed.repo === repo && claimed.file === inc.file ? canonical(byId, claimed) : undefined

    if (!prior || prior.status === "obsolete" || prior.status === "closed") {
      const f = append(inc, "new", prior?.id)
      outcomes.push({ kind: "new", id: f.id })
      continue
    }
    if (prior.status === "fixed") {
      const f = append(inc, "resurfaced", prior.id)
      outcomes.push({ kind: "resurfaced", id: f.id, of: prior.id })
      continue
    }
    const dismissedAs = prior.status === "false_positive" || prior.status === "risk_accepted" ? prior.status : null
    // A dismissal can hide a repeat, never an escalation: a high report, or one more severe than
    // what was dismissed, is a new row linked to the prior, and doesn't count as a sighting of it.
    if (dismissedAs && (inc.severity === "high" || SEVERITY_RANK[inc.severity] > SEVERITY_RANK[prior.severity])) {
      const f = append(inc, "new", prior.id)
      outcomes.push({ kind: "new", id: f.id })
      continue
    }
    if (!bumpedThisRun.has(prior.id)) {
      prior.times_seen += 1
      prior.last_seen = now
      bumpedThisRun.add(prior.id)
    }
    if (dismissedAs) {
      const report: SuppressedReport = { at: now, severity: inc.severity, line: inc.line ?? null, description: inc.description }
      prior.suppressed_reports = [...(prior.suppressed_reports ?? []), report].slice(-SUPPRESSED_REPORTS_KEPT)
      outcomes.push({ kind: "suppressed", id: prior.id, status: dismissedAs, description: inc.description })
      continue
    }
    // Open. `new` becomes `recurring`; `resurfaced` and `confirmed` already say more, so they stay.
    if (prior.status === "new") prior.status = "recurring"
    if (SEVERITY_RANK[inc.severity] > SEVERITY_RANK[prior.severity]) prior.severity = inc.severity
    outcomes.push({ kind: "recurring", id: prior.id })
  }
  return { queue: next, outcomes }
}

/** Exact id, or a unique prefix of at least 8 characters (what the queue listings print). */
function findById(queue: Finding[], id: string): Finding {
  const exact = queue.find((f) => f.id === id)
  if (exact) return exact
  const hits = id.length >= 8 ? queue.filter((f) => f.id.startsWith(id)) : []
  if (hits.length === 1) return hits[0]
  throw new Error(hits.length > 1 ? `id prefix ${id} is ambiguous (${hits.length} findings)` : `no finding with id ${id}`)
}

export interface ResolveOptions {
  by: string
  reason?: string
  commit?: string
  /** Required for `duplicate`: the canonical finding's id. */
  of?: string
}

/** Moves a finding to a new status. Throws on anything that would leave a closure
 * unexplained: an unknown id, a risk_accepted/false_positive without a reason, or a
 * duplicate without a real target. */
export function setStatus(queue: Finding[], id: string, status: Status, opts: ResolveOptions, now: string): Finding[] {
  const next = queue.map((f) => ({ ...f }))
  const target = findById(next, id)
  if (REASON_REQUIRED.has(status) && !opts.reason) throw new Error(`${status} needs --reason`)
  if (status === "duplicate") {
    const of = opts.of ? findById(next, opts.of) : undefined
    if (!of || of.id === target.id) throw new Error("duplicate needs --of <a different, existing finding id>")
    target.related_id = of.id
  }
  target.status = status
  target.resolved = !isOpen(status)
  if (isOpen(status)) {
    delete target.resolution
  } else {
    target.resolution = { at: now, by: opts.by, ...(opts.reason ? { reason: opts.reason } : {}), ...(opts.commit ? { commit: opts.commit } : {}) }
  }
  return next
}

export function countByStatus(queue: Finding[]): Record<Status, number> {
  const out = Object.fromEntries([...OPEN_STATUSES, ...CLOSED_STATUSES].map((s) => [s, 0])) as Record<Status, number>
  for (const f of queue) out[f.status]++
  return out
}
