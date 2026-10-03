import { describe, expect, test } from "bun:test"
import type { Alert } from "./NotifyChannels"
import { DEFAULT_GOVERNOR, type GovernorConfig, decide, emptyState, inQuietHours, localMinutes, tick } from "./NotifyGovernor"

const cfg: GovernorConfig = { ...DEFAULT_GOVERNOR, quietHours: { start: "22:00", end: "07:00", timeZone: "America/Chicago" } }
// 2026-10-02 is CDT (UTC-5)
const T = (iso: string) => Date.parse(iso)
const DAY = T("2026-10-02T15:00:00Z") // 10:00 CDT
const NIGHT = T("2026-10-03T04:30:00Z") // 23:30 CDT
const MORNING = T("2026-10-03T12:05:00Z") // 07:05 CDT

const a = (over: Partial<Alert> = {}): Alert => ({ title: "New high finding", message: "m", severity: "P1", source: "nightly-review", ...over })

describe("quiet hours (ISC-10)", () => {
  test("window wraps midnight in the configured timezone", () => {
    expect(localMinutes(NIGHT, "America/Chicago")).toBe(23 * 60 + 30)
    expect(inQuietHours(NIGHT, cfg.quietHours)).toBe(true)
    expect(inQuietHours(T("2026-10-03T11:59:00Z"), cfg.quietHours)).toBe(true) // 06:59
    expect(inQuietHours(T("2026-10-03T12:00:00Z"), cfg.quietHours)).toBe(false) // 07:00
    expect(inQuietHours(DAY, cfg.quietHours)).toBe(false)
    expect(inQuietHours(NIGHT, null)).toBe(false)
  })
  test("P1 at night is held; P0 at night goes through", () => {
    const s = emptyState()
    expect(decide(a(), NIGHT, s, cfg).action).toBe("hold-quiet")
    expect(decide(a({ severity: "P0", source: "canary-inspector" }), NIGHT, s, cfg).action).toBe("send")
  })
  test("held P1s are released after 07:00 as one summary", () => {
    const s = emptyState()
    decide(a({ title: "one" }), NIGHT, s, cfg)
    decide(a({ title: "two", source: "llm-host" }), NIGHT + 60_000, s, cfg)
    expect(tick(NIGHT + 120_000, s, cfg)).toEqual([]) // still night
    const out = tick(MORNING, s, cfg)
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe("2 alerts held during quiet hours")
    expect(out[0].message).toContain("llm-host: two")
    expect(s.held).toHaveLength(0)
  })
  test("a single held alert is released as itself", () => {
    const s = emptyState()
    decide(a(), NIGHT, s, cfg)
    expect(tick(MORNING, s, cfg)[0].title).toBe("(held overnight) New high finding")
  })
})

describe("dedup (ISC-9)", () => {
  test("same P1 within 24h is dropped; different message is not", () => {
    const s = emptyState()
    expect(decide(a(), DAY, s, cfg).action).toBe("send")
    expect(decide(a(), DAY + 3_600_000, s, cfg).action).toBe("dedup")
    expect(decide(a({ message: "other" }), DAY + 3_600_000, s, cfg).action).toBe("send")
    expect(decide(a(), DAY + 25 * 3_600_000, s, cfg).action).toBe("send")
  })
  test("P0 re-pages after an hour", () => {
    const s = emptyState()
    const p0 = a({ severity: "P0", source: "canary-inspector" })
    expect(decide(p0, DAY, s, cfg).action).toBe("send")
    expect(decide(p0, DAY + 30 * 60_000, s, cfg).action).toBe("dedup")
    expect(decide(p0, DAY + 61 * 60_000, s, cfg).action).toBe("send")
  })
  test("a held alert also counts as seen, so it isn't held twice", () => {
    const s = emptyState()
    decide(a(), NIGHT, s, cfg)
    expect(decide(a(), NIGHT + 60_000, s, cfg).action).toBe("dedup")
    expect(s.held).toHaveLength(1)
  })
})

describe("flood (ISC-11)", () => {
  test("sixth P1 from one source in an hour is suppressed, then summarized", () => {
    const s = emptyState()
    for (let i = 0; i < 5; i++) expect(decide(a({ message: `m${i}` }), DAY + i * 1000, s, cfg).action).toBe("send")
    expect(decide(a({ message: "m5" }), DAY + 6000, s, cfg).action).toBe("hold-flood")
    expect(decide(a({ message: "m6" }), DAY + 7000, s, cfg).action).toBe("hold-flood")
    expect(decide(a({ message: "x", source: "other" }), DAY + 8000, s, cfg).action).toBe("send")
    expect(tick(DAY + 30 * 60_000, s, cfg)).toEqual([]) // hour not over
    const out = tick(DAY + 61 * 60_000, s, cfg)
    expect(out.map((o) => o.title)).toEqual(["2 more alerts from nightly-review"])
  })
  test("P0 is never flood-suppressed", () => {
    const s = emptyState()
    for (let i = 0; i < 8; i++) expect(decide(a({ severity: "P0", message: `m${i}` }), DAY + i, s, cfg).action).toBe("send")
  })
  test("a flood summary that comes due at night is held for the morning", () => {
    const s = emptyState()
    const eve = T("2026-10-03T02:30:00Z") // 21:30 CDT
    for (let i = 0; i < 6; i++) decide(a({ message: `m${i}` }), eve + i, s, cfg)
    expect(tick(eve + 61 * 60_000, s, cfg)).toEqual([]) // 22:31, quiet
    expect(tick(MORNING, s, cfg)[0].title).toBe("(held overnight) 1 more alert from nightly-review")
  })
})

describe("P2", () => {
  test("P2 is never held or flood-counted", () => {
    const s = emptyState()
    expect(decide(a({ severity: "P2" }), NIGHT, s, cfg).action).toBe("send")
    expect(s.pushes).toEqual({})
  })
})
