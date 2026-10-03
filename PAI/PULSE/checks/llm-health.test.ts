import { describe, expect, test } from "bun:test"
import { DOWN_ALERT_MS, parseTiers, step } from "./llm-health"

const T0 = Date.parse("2026-10-02T15:00:00Z")
const down = { ok: false, error: "connect ECONNREFUSED" }
const up = { ok: true }

describe("llm-health (ISC-24)", () => {
  test("a blip under 10 minutes is silent", () => {
    let s = step("prod", {}, down, T0)
    expect(s.alert).toBeNull()
    s = step("prod", s.next, down, T0 + DOWN_ALERT_MS - 60_000)
    expect(s.alert).toBeNull()
    s = step("prod", s.next, up, T0 + DOWN_ALERT_MS - 30_000)
    expect(s.alert).toBeNull()
    expect(s.next).toEqual({})
  })
  test("down for 10 minutes sends one P1, then one P2 on recovery", () => {
    let s = step("fast", {}, down, T0)
    s = step("fast", s.next, down, T0 + DOWN_ALERT_MS)
    expect(s.alert?.severity).toBe("P1")
    expect(s.alert?.title).toBe("Local LLM down: fast")
    expect(s.alert?.message).toContain("10 min")
    s = step("fast", s.next, down, T0 + 2 * DOWN_ALERT_MS)
    expect(s.alert).toBeNull() // no repeat while still down
    s = step("fast", s.next, up, T0 + 3 * DOWN_ALERT_MS)
    expect(s.alert?.severity).toBe("P2")
    expect(s.alert?.message).toContain("30 min")
    expect(s.next).toEqual({})
  })
  test("tiers parse with optional alias; empty spec means no tiers", () => {
    expect(parseTiers("prod|http://h:11434/|qwen3_next_80b_a3b, fast|http://h:11436")).toEqual([
      { name: "prod", url: "http://h:11434", alias: "qwen3_next_80b_a3b" },
      { name: "fast", url: "http://h:11436", alias: undefined },
    ])
    expect(parseTiers(undefined)).toEqual([])
  })
})
