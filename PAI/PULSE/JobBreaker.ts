/**
 * PAI Pulse — job circuit breaker (alerting ISA ISC-23).
 *
 * After MAX_FAILURES consecutive failures a job stops running. The old breaker
 * never reopened, so a job broken once stayed dead until someone edited state by
 * hand (latency-drift-check: tripped 2026-06-22, silently skipped for 14 weeks).
 * Now the breaker is half-open: one probe at the next scheduled run, at most once per PROBE_INTERVAL.
 * Every transition produces an alert payload for /notify.
 */

import type { Alert } from "./NotifyChannels"

export const MAX_FAILURES = 3
export const PROBE_INTERVAL_MS = 24 * 60 * 60_000

export interface BreakerState {
  lastRun?: number
  lastResult?: string
  consecutiveFailures?: number
}

export type BreakerAction = "run" | "probe" | "skip"

export function breakerAction(s: BreakerState | undefined, now: number): BreakerAction {
  const failures = s?.consecutiveFailures ?? 0
  if (failures < MAX_FAILURES) return "run"
  return now - (s?.lastRun ?? 0) >= PROBE_INTERVAL_MS ? "probe" : "skip"
}

/** Alert for a state transition, or null when nothing changed that GP needs to hear. */
export function transitionAlert(job: string, before: number, after: number, error?: string): Alert | null {
  if (after >= MAX_FAILURES && before < MAX_FAILURES) {
    return {
      title: `Pulse job stopped: ${job}`,
      message: `${job} failed ${after} times in a row and is paused. It retries at its next scheduled run (at most once a day) and resumes on the first success. Last error: ${(error ?? "unknown").replace(/\s+/g, " ").slice(0, 300)}`,
      severity: "P1",
      source: "pulse-breaker",
      id: `breaker-${job}`,
    }
  }
  if (after === 0 && before >= MAX_FAILURES) {
    return {
      title: `Pulse job recovered: ${job}`,
      message: `${job} succeeded on a retry after ${before} consecutive failures and is running on schedule again.`,
      severity: "P2",
      source: "pulse-breaker",
      id: `breaker-${job}`,
    }
  }
  return null
}
