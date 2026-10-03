/**
 * PAI Pulse — notification governor (alerting ISA F3).
 *
 * Sits between /notify and the channels. Pure decisions over explicit state
 * and an injected clock, so every rule is unit-testable:
 *   - Dedup: same fingerprint (severity + source + title + message) inside the
 *     window is dropped. P0 re-pages after 1 h; P1/P2 stay quiet for 24 h.
 *   - Quiet hours: P1 inside the window is held and released at the window's
 *     end as one summary push. P0 always goes through. P2 never pushes anyway.
 *   - Flood: more than `floodLimit` pushes from one source in an hour → the
 *     rest are counted, not sent, and reported as one summary when the hour ends.
 *
 * Governor-held alerts still reach local channels (desktop, alerts.jsonl);
 * only the push is deferred.
 */

import { createHash } from "crypto"
import type { Alert } from "./NotifyChannels"

export interface QuietHours {
  start: string // "HH:MM", local to timeZone
  end: string
  timeZone: string
}

export interface GovernorConfig {
  quietHours: QuietHours | null
  floodLimit: number
  dedupMs: { P0: number; P1: number; P2: number }
}

export const DEFAULT_GOVERNOR: Omit<GovernorConfig, "quietHours"> = {
  floodLimit: 5,
  dedupMs: { P0: 60 * 60_000, P1: 24 * 60 * 60_000, P2: 24 * 60 * 60_000 },
}

export interface HeldAlert { at: number; alert: Alert }

export interface GovernorState {
  seen: Record<string, number> // fingerprint → last-sent epoch ms
  pushes: Record<string, number[]> // source → push timestamps in the last hour
  floodSuppressed: Record<string, number> // source → count suppressed this hour
  held: HeldAlert[] // P1s held by quiet hours
}

export const emptyState = (): GovernorState => ({ seen: {}, pushes: {}, floodSuppressed: {}, held: [] })

export type Decision =
  | { action: "send" }
  | { action: "dedup" }
  | { action: "hold-quiet" }
  | { action: "hold-flood" }

export function fingerprint(a: Alert): string {
  return createHash("sha256").update([a.severity, a.source ?? "", a.title, a.message].join("\u0000")).digest("hex").slice(0, 16)
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + (m || 0)
}

export function localMinutes(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return get("hour") * 60 + get("minute")
}

export function inQuietHours(now: number, q: QuietHours | null): boolean {
  if (!q) return false
  const t = localMinutes(now, q.timeZone)
  const s = minutesOf(q.start)
  const e = minutesOf(q.end)
  return s <= e ? t >= s && t < e : t >= s || t < e // window may wrap midnight
}

const HOUR = 60 * 60_000

/** Decide what happens to one alert. Mutates state for the chosen action. */
export function decide(alert: Alert, now: number, state: GovernorState, cfg: GovernorConfig): Decision {
  const fp = fingerprint(alert)
  const last = state.seen[fp]
  if (last !== undefined && now - last < cfg.dedupMs[alert.severity]) return { action: "dedup" }

  if (alert.severity === "P1" && inQuietHours(now, cfg.quietHours)) {
    state.seen[fp] = now
    state.held.push({ at: now, alert })
    return { action: "hold-quiet" }
  }

  if (alert.severity !== "P2") {
    const src = alert.source ?? "unknown"
    const recent = (state.pushes[src] ?? []).filter((t) => now - t < HOUR)
    if (alert.severity === "P1" && recent.length >= cfg.floodLimit) {
      state.pushes[src] = recent
      state.floodSuppressed[src] = (state.floodSuppressed[src] ?? 0) + 1
      state.seen[fp] = now
      return { action: "hold-flood" }
    }
    state.pushes[src] = [...recent, now]
  }

  state.seen[fp] = now
  return { action: "send" }
}

/**
 * Periodic housekeeping. Returns summary alerts to push now:
 *   - held quiet-hours P1s once the window is over (one summary),
 *   - flood counts for sources whose hour has rolled off.
 * Also prunes dedup entries older than the longest window.
 */
export function tick(now: number, state: GovernorState, cfg: GovernorConfig): Alert[] {
  const out: Alert[] = []

  if (state.held.length && !inQuietHours(now, cfg.quietHours)) {
    const held = state.held
    state.held = []
    if (held.length === 1) {
      out.push({ ...held[0].alert, title: `(held overnight) ${held[0].alert.title}` })
    } else {
      const lines = held.map((h) => `- ${h.alert.source ?? "unknown"}: ${h.alert.title}`)
      out.push({
        title: `${held.length} alerts held during quiet hours`,
        message: lines.join("\n").slice(0, 480),
        severity: "P1",
        source: "notify-governor",
        id: `quiet-${held.length}`,
      })
    }
  }

  for (const [src, count] of Object.entries(state.floodSuppressed)) {
    const recent = (state.pushes[src] ?? []).filter((t) => now - t < HOUR)
    if (recent.length === 0 && count > 0) {
      const summary: Alert = {
        title: `${count} more alert${count === 1 ? "" : "s"} from ${src}`,
        message: `${src} exceeded ${cfg.floodLimit} pushes in an hour; ${count} further alerts were logged to alerts.jsonl but not pushed.`,
        severity: "P1",
        source: "notify-governor",
        id: `flood-${src}`,
      }
      // A flood summary is a P1 like any other: it waits out quiet hours.
      if (inQuietHours(now, cfg.quietHours)) state.held.push({ at: now, alert: summary })
      else out.push(summary)
      delete state.floodSuppressed[src]
    }
    state.pushes[src] = recent
  }

  const maxWindow = Math.max(cfg.dedupMs.P0, cfg.dedupMs.P1, cfg.dedupMs.P2)
  for (const [fp, t] of Object.entries(state.seen)) if (now - t >= maxWindow) delete state.seen[fp]

  return out
}
