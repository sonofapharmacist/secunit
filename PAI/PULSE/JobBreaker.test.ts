import { describe, expect, test } from "bun:test"
import { MAX_FAILURES, PROBE_INTERVAL_MS, breakerAction, transitionAlert } from "./JobBreaker"

const NOW = Date.parse("2026-10-02T15:00:00Z")

describe("breakerAction", () => {
  test("healthy or below the limit runs", () => {
    expect(breakerAction(undefined, NOW)).toBe("run")
    expect(breakerAction({ consecutiveFailures: MAX_FAILURES - 1, lastRun: NOW }, NOW)).toBe("run")
  })
  test("tripped skips until a day has passed, then probes once", () => {
    expect(breakerAction({ consecutiveFailures: 3, lastRun: NOW - 60_000 }, NOW)).toBe("skip")
    expect(breakerAction({ consecutiveFailures: 3, lastRun: NOW - PROBE_INTERVAL_MS }, NOW)).toBe("probe")
  })
  test("a job tripped 14 weeks ago probes immediately (latency-drift-check)", () => {
    expect(breakerAction({ consecutiveFailures: 3, lastRun: Date.parse("2026-06-22T14:00:29Z") }, NOW)).toBe("probe")
  })
})

describe("transitionAlert (ISC-23)", () => {
  test("tripping sends P1 with the last error", () => {
    const a = transitionAlert("latency-drift-check", 2, 3, "Error: Map keys must be unique\n at line 651")!
    expect(a.severity).toBe("P1")
    expect(a.title).toBe("Pulse job stopped: latency-drift-check")
    expect(a.message).toContain("Map keys must be unique at line 651")
  })
  test("recovery from tripped sends P2", () => {
    const a = transitionAlert("latency-drift-check", 3, 0)!
    expect(a.severity).toBe("P2")
    expect(a.title).toBe("Pulse job recovered: latency-drift-check")
  })
  test("ordinary failures, repeat failures while tripped, and normal successes are silent", () => {
    expect(transitionAlert("j", 0, 1, "e")).toBeNull()
    expect(transitionAlert("j", 3, 4, "e")).toBeNull()
    expect(transitionAlert("j", 1, 0)).toBeNull()
    expect(transitionAlert("j", 0, 0)).toBeNull()
  })
})
