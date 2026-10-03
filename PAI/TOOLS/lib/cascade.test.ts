import { describe, expect, test } from "bun:test"
import type { InferenceOptions, InferenceResult } from "../Inference"
import { type Call, type Floor, type JobContract, loadFloors, localAllowed, runCascade } from "./cascade"

// A toy job: the model must return a JSON rating 1-10.
const contract: JobContract<string, number> = {
  job: "rate",
  build: (text) => ({ systemPrompt: "rate", userPrompt: text, expectJson: true }),
  verify: (out) => {
    try {
      const n = JSON.parse(out).rating
      return Number.isInteger(n) && n >= 1 && n <= 10 ? { ok: true, value: n } : { ok: false, reason: `rating out of range: ${n}` }
    } catch {
      return { ok: false, reason: "not JSON" }
    }
  },
  local: { model: "kat_coder_v25_apex", timeoutMs: 1000 },
  cloud: { level: "fast", timeoutMs: 1000 },
}

const ok = (output: string): InferenceResult => ({ success: true, output, latencyMs: 1, level: "fast" })
const fail = (error: string): InferenceResult => ({ success: false, output: "", error, latencyMs: 1, level: "fast" })

/** Scripted backend: local and cloud answers by backend. Records every call. */
function backend(local: InferenceResult | Error, cloud: InferenceResult | Error) {
  const calls: InferenceOptions[] = []
  const call: Call = async (o) => {
    calls.push(o)
    const r = o.backend === "ollama" ? local : cloud
    if (r instanceof Error) throw r
    return r
  }
  return { call, calls }
}

const FLOORS: Record<string, Floor> = { rate: { floor: 0.9, measured: 0.95 } }

describe("runCascade (ISC-20/21)", () => {
  test("verified local answer: no cloud call", async () => {
    const b = backend(ok('{"rating":7}'), ok('{"rating":3}'))
    const rows: Record<string, unknown>[] = []
    const r = await runCascade(contract, "x", { call: b.call, floors: FLOORS, log: (row) => rows.push(row) })
    expect(r).toMatchObject({ path: "local", value: 7 })
    expect(b.calls.map((c) => c.backend)).toEqual(["ollama"])
    expect(rows[0]).toMatchObject({ backend: "cascade", caller: "rate", cascade_path: "local", escalated_from_local: false })
  })

  test("local answers wrongly: verifier rejects, cloud answers, escalated_from_local logged", async () => {
    const b = backend(ok('```json\n{"rating":7}\n```'), ok('{"rating":6}'))
    const rows: Record<string, unknown>[] = []
    const r = await runCascade(contract, "x", { call: b.call, floors: FLOORS, log: (row) => rows.push(row) })
    expect(r).toMatchObject({ path: "escalated", value: 6 })
    expect(r.reasons).toEqual(["local rejected: not JSON"])
    expect(rows[0]).toMatchObject({ cascade_path: "escalated", escalated_from_local: true })
  })

  test("local errors or throws: escalates", async () => {
    for (const local of [fail("ECONNREFUSED"), new Error("socket hang up")]) {
      const r = await runCascade(contract, "x", { call: backend(local, ok('{"rating":5}')).call, floors: FLOORS })
      expect(r.path).toBe("escalated")
      expect(r.value).toBe(5)
    }
  })

  test("the cloud leg can never route back to local through config", async () => {
    const b = backend(ok("garbage"), ok('{"rating":5}'))
    await runCascade(contract, "x", { call: b.call, floors: FLOORS })
    expect(b.calls[1]).toMatchObject({ backend: "claude", level: "fast", localFirst: false, fallbackToOllama: false })
  })

  test("both fail: path failed, no value invented", async () => {
    const r = await runCascade(contract, "x", { call: backend(ok("nope"), ok('{"rating":99}')).call, floors: FLOORS })
    expect(r.path).toBe("failed")
    expect(r.value).toBeUndefined()
    expect(r.reasons).toEqual(["local rejected: not JSON", "cloud rejected: rating out of range: 99"])
  })
})

describe("floors (ISC-23)", () => {
  test("a below-floor job routes straight to cloud", async () => {
    const b = backend(ok('{"rating":7}'), ok('{"rating":4}'))
    const r = await runCascade(contract, "x", { call: b.call, floors: { rate: { floor: 0.9, measured: 0.8 } } })
    expect(r.path).toBe("cloud-only")
    expect(b.calls.map((c) => c.backend)).toEqual(["claude"])
    expect(r.reasons[0]).toBe("local skipped: measured 0.8 < floor 0.9")
  })
  test("no floor or no measurement means no local", () => {
    expect(localAllowed({}, "rate").ok).toBe(false)
    expect(localAllowed({ rate: { floor: 0.9, measured: null } }, "rate").ok).toBe(false)
    expect(localAllowed({ rate: { floor: 0.9, measured: 0.9 } }, "rate").ok).toBe(true)
  })
  test("missing or corrupt floors file yields no floors", () => {
    expect(loadFloors("/nonexistent/floors.json")).toEqual({})
  })
})

import { reasonClass, render, summarize } from "../CascadeReport"

describe("CascadeReport (ISC-22)", () => {
  const T = "2026-10-02T12:00:00Z"
  const row = (caller: string, cascade_path: string, reasons: string[] = []) => ({ timestamp: T, backend: "cascade", caller, cascade_path, reasons })
  test("escalation rate counts only runs where local tried", () => {
    const rows = [
      row("classify", "local"), row("classify", "local"), row("classify", "local"),
      row("classify", "escalated", ["local rejected: not JSON: ```json"]),
      row("classify", "cloud-only", ["local skipped: no floor declared for classify"]),
      row("rate", "failed", ["local error: ECONNREFUSED", "cloud error: timeout"]),
      { timestamp: T, backend: "local", caller: "classify", cascade_path: "x" },
      { ...row("classify", "local"), timestamp: "2026-09-01T00:00:00Z" },
    ]
    const [c, r] = summarize(rows, Date.parse("2026-10-01T00:00:00Z"))
    expect(c).toMatchObject({ job: "classify", runs: 5, local: 3, escalated: 1, cloudOnly: 1, escalationRate: 0.25 })
    expect(c.topReasons[0]).toEqual(["local rejected: not JSON", 1])
    expect(r).toMatchObject({ job: "rate", failed: 1, escalationRate: null })
    expect(render([c, r], 7)).toContain("25.0%")
  })
  test("reason classes drop the variable tail", () => {
    expect(reasonClass("local rejected: rating out of range: 99")).toBe("local rejected: rating out of range")
  })
})
