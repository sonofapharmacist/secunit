import { describe, test, expect } from "bun:test"
import { alertsForRun, applyIncoming, normalize, priorFindingsFor, setStatus, countByStatus, SUPPRESSED_REPORTS_KEPT, type Finding, type IncomingFinding, type Outcome } from "./review-queue"

const T0 = "2026-09-01T00:00:00.000Z"
const T1 = "2026-09-02T00:00:00.000Z"

function row(over: Partial<Finding> & { id: string }): Finding {
  return {
    repo: "r", severity: "medium", file: "a.ts", line: 1, description: "d", created_at: T0,
    status: "new", resolved: false, first_seen: T0, last_seen: T0, times_seen: 1, ...over,
  }
}
const inc = (over: Partial<IncomingFinding> = {}): IncomingFinding => ({ severity: "medium", file: "a.ts", line: 3, description: "again", ...over })

describe("normalize legacy rows", () => {
  test("resolved=false → new, seen once at created_at", () => {
    const f = normalize({ id: "x", repo: "r", severity: "low", file: "a", line: null, description: "d", created_at: T0, resolved: false })
    expect(f).toMatchObject({ status: "new", resolved: false, first_seen: T0, last_seen: T0, times_seen: 1 })
  })
  test("resolved=true → closed (not fixed: disposition was never recorded)", () => {
    const f = normalize({ id: "x", repo: "r", severity: "low", file: "a", line: null, description: "d", created_at: T0, resolved: true })
    expect(f.status).toBe("closed")
    expect(f.resolution?.by).toBe("legacy")
  })
  test("resolved is re-derived from status, not trusted", () => {
    expect(normalize({ ...row({ id: "x" }), status: "fixed", resolved: false }).resolved).toBe(true)
  })
})

describe("applyIncoming transitions", () => {
  test("no match → new row", () => {
    const { queue, outcomes } = applyIncoming([], "r", [inc()], T1)
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ status: "new", times_seen: 1, first_seen: T1 })
    expect(outcomes[0].kind).toBe("new")
  })

  test("matches an open finding → recurring, no new row, seen count and last_seen bump", () => {
    const { queue, outcomes } = applyIncoming([row({ id: "p" })], "r", [inc({ matches: "p" })], T1)
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ status: "recurring", times_seen: 2, last_seen: T1, first_seen: T0 })
    expect(outcomes[0]).toEqual({ kind: "recurring", id: "p" })
  })

  test("recurrence raises severity, never lowers it", () => {
    const up = applyIncoming([row({ id: "p", severity: "low" })], "r", [inc({ matches: "p", severity: "high" })], T1)
    expect(up.queue[0].severity).toBe("high")
    const down = applyIncoming([row({ id: "p", severity: "high" })], "r", [inc({ matches: "p", severity: "low" })], T1)
    expect(down.queue[0].severity).toBe("high")
  })

  test("resurfaced and confirmed keep their status on recurrence", () => {
    for (const s of ["resurfaced", "confirmed"] as const) {
      const { queue } = applyIncoming([row({ id: "p", status: s })], "r", [inc({ matches: "p" })], T1)
      expect(queue[0].status).toBe(s)
    }
  })

  test("matches a fixed finding → new resurfaced row linked to it; the fixed row stays closed", () => {
    const fixed = row({ id: "p", status: "fixed", resolved: true })
    const { queue, outcomes } = applyIncoming([fixed], "r", [inc({ matches: "p" })], T1)
    expect(queue).toHaveLength(2)
    expect(queue[0].status).toBe("fixed")
    expect(queue[1]).toMatchObject({ status: "resurfaced", related_id: "p", resolved: false })
    expect(outcomes[0].kind).toBe("resurfaced")
  })

  test("matches false_positive or risk_accepted → suppressed, no new row, report text kept on the prior", () => {
    for (const s of ["false_positive", "risk_accepted"] as const) {
      const { queue, outcomes } = applyIncoming([row({ id: "p", status: s, resolved: true })], "r", [inc({ matches: "p" })], T1)
      expect(queue).toHaveLength(1)
      expect(queue[0]).toMatchObject({ status: s, times_seen: 2, last_seen: T1 })
      expect(queue[0].suppressed_reports).toEqual([{ at: T1, severity: "medium", line: 3, description: "again" }])
      expect(outcomes[0]).toEqual({ kind: "suppressed", id: "p", status: s, description: "again" })
    }
  })

  // Finding 53c26d94: `matches` comes from a model reading an untrusted diff, so a dismissal
  // must not be able to swallow a worse defect.
  test("a high report is never suppressed, even against a high dismissal", () => {
    const { queue, outcomes } = applyIncoming([row({ id: "p", status: "false_positive", severity: "high", resolved: true })], "r",
      [inc({ matches: "p", severity: "high", description: "injected: new RCE" })], T1)
    expect(queue).toHaveLength(2)
    expect(queue[1]).toMatchObject({ status: "new", related_id: "p", severity: "high", description: "injected: new RCE" })
    expect(outcomes[0].kind).toBe("new")
  })

  test("a report more severe than the dismissed finding becomes a new linked row, and isn't counted as a sighting", () => {
    const { queue, outcomes } = applyIncoming([row({ id: "p", status: "risk_accepted", severity: "low", resolved: true })], "r",
      [inc({ matches: "p", severity: "medium" })], T1)
    expect(queue).toHaveLength(2)
    expect(queue[0]).toMatchObject({ times_seen: 1, last_seen: T0 })
    expect(queue[0].suppressed_reports).toBeUndefined()
    expect(queue[1]).toMatchObject({ status: "new", related_id: "p", severity: "medium" })
    expect(outcomes[0].kind).toBe("new")
  })

  test("suppressed reports are capped at the most recent SUPPRESSED_REPORTS_KEPT", () => {
    const prior = row({ id: "p", status: "false_positive", resolved: true,
      suppressed_reports: Array.from({ length: SUPPRESSED_REPORTS_KEPT }, (_, i) => ({ at: T0, severity: "low" as const, line: i, description: `old ${i}` })) })
    const { queue } = applyIncoming([prior], "r", [inc({ matches: "p", severity: "low", description: "newest" })], T1)
    const kept = queue[0].suppressed_reports!
    expect(kept).toHaveLength(SUPPRESSED_REPORTS_KEPT)
    expect(kept[0].description).toBe("old 1")
    expect(kept.at(-1)!.description).toBe("newest")
  })

  test("matches an obsolete or legacy-closed finding → new, linked", () => {
    for (const s of ["obsolete", "closed"] as const) {
      const { queue } = applyIncoming([row({ id: "p", status: s, resolved: true })], "r", [inc({ matches: "p" })], T1)
      expect(queue[1]).toMatchObject({ status: "new", related_id: "p" })
    }
  })

  test("matches a duplicate → follows to the canonical finding", () => {
    const q = [row({ id: "canon" }), row({ id: "dup", status: "duplicate", resolved: true, related_id: "canon" })]
    const { queue, outcomes } = applyIncoming(q, "r", [inc({ matches: "dup" })], T1)
    expect(queue).toHaveLength(2)
    expect(queue[0]).toMatchObject({ id: "canon", status: "recurring", times_seen: 2 })
    expect(outcomes[0]).toEqual({ kind: "recurring", id: "canon" })
  })

  test("duplicate cycle does not hang", () => {
    const q = [row({ id: "a", status: "duplicate", resolved: true, related_id: "b" }), row({ id: "b", status: "duplicate", resolved: true, related_id: "a" })]
    expect(() => applyIncoming(q, "r", [inc({ matches: "a" })], T1)).not.toThrow()
  })

  test("a hallucinated id, another file, or another repo is ignored → new", () => {
    const q = [row({ id: "p" })]
    expect(applyIncoming(q, "r", [inc({ matches: "nope" })], T1).outcomes[0].kind).toBe("new")
    expect(applyIncoming(q, "r", [inc({ matches: "p", file: "b.ts" })], T1).outcomes[0].kind).toBe("new")
    expect(applyIncoming(q, "other", [inc({ matches: "p" })], T1).outcomes[0].kind).toBe("new")
  })

  test("two findings in one run matching the same prior count as one sighting", () => {
    const { queue, outcomes } = applyIncoming([row({ id: "p" })], "r", [inc({ matches: "p" }), inc({ matches: "p", line: 9 })], T1)
    expect(queue).toHaveLength(1)
    expect(queue[0].times_seen).toBe(2)
    expect(outcomes.map((o) => o.kind)).toEqual(["recurring", "recurring"])
  })

  test("does not mutate the input queue", () => {
    const q = [row({ id: "p" })]
    applyIncoming(q, "r", [inc({ matches: "p" })], T1)
    expect(q[0]).toMatchObject({ status: "new", times_seen: 1 })
  })
})

describe("setStatus", () => {
  test("fixed records commit and closes", () => {
    const [f] = setStatus([row({ id: "abcdef1234" })], "abcdef12", "fixed", { by: "t", commit: "d942ba7b" }, T1)
    expect(f).toMatchObject({ status: "fixed", resolved: true, resolution: { by: "t", commit: "d942ba7b", at: T1 } })
  })
  test("risk_accepted and false_positive require a reason", () => {
    expect(() => setStatus([row({ id: "p" })], "p", "risk_accepted", { by: "t" }, T1)).toThrow(/reason/)
    expect(() => setStatus([row({ id: "p" })], "p", "false_positive", { by: "t" }, T1)).toThrow(/reason/)
  })
  test("duplicate requires a real, different target", () => {
    const q = [row({ id: "p" }), row({ id: "q" })]
    expect(() => setStatus(q, "p", "duplicate", { by: "t" }, T1)).toThrow()
    expect(() => setStatus(q, "p", "duplicate", { by: "t", of: "p" }, T1)).toThrow()
    expect(setStatus(q, "p", "duplicate", { by: "t", of: "q" }, T1)[0]).toMatchObject({ status: "duplicate", related_id: "q" })
  })
  test("reopening to an open status clears the resolution", () => {
    const closed = setStatus([row({ id: "p" })], "p", "fixed", { by: "t" }, T1)
    const [f] = setStatus(closed, "p", "confirmed", { by: "t" }, T1)
    expect(f).toMatchObject({ status: "confirmed", resolved: false })
    expect(f.resolution).toBeUndefined()
  })
  test("unknown or ambiguous id throws", () => {
    expect(() => setStatus([row({ id: "p" })], "zzzzzzzz", "fixed", { by: "t" }, T1)).toThrow(/no finding/)
    expect(() => setStatus([row({ id: "aaaaaaaa1" }), row({ id: "aaaaaaaa2" })], "aaaaaaaa", "fixed", { by: "t" }, T1)).toThrow(/ambiguous/)
  })
})

describe("priorFindingsFor", () => {
  test("same repo and files only; skips duplicate and legacy-closed; newest first", () => {
    const q = [
      row({ id: "old", last_seen: T0 }), row({ id: "newer", last_seen: T1 }),
      row({ id: "dup", status: "duplicate" }), row({ id: "leg", status: "closed" }),
      row({ id: "fp", status: "false_positive" }), row({ id: "other", file: "z.ts" }), row({ id: "or", repo: "x" }),
    ]
    expect(priorFindingsFor(q, "r", ["a.ts"]).map((f) => f.id)).toEqual(["newer", "old", "fp"])
  })
})

test("countByStatus covers every status", () => {
  const c = countByStatus([row({ id: "a" }), row({ id: "b", status: "fixed" })])
  expect(c.new).toBe(1)
  expect(c.fixed).toBe(1)
  expect(c.risk_accepted).toBe(0)
})

describe("alertsForRun (alerting ISA ISC-22)", () => {
  const inc = (severity: "high" | "medium" | "low", description = "d"): IncomingFinding => ({ severity, file: "PAI/TOOLS/x.ts", line: 7, description })
  test("P1 only for high new/resurfaced; P2 tally always", () => {
    const incoming = [inc("high", "new one"), inc("high", "again"), inc("high", "old"), inc("medium", "meh"), inc("high", "fp")]
    const outcomes: Outcome[] = [
      { kind: "new", id: "aaaaaaaa1111" },
      { kind: "resurfaced", id: "bbbbbbbb2222", of: "cccccccc" },
      { kind: "recurring", id: "dddddddd3333" },
      { kind: "new", id: "eeeeeeee4444" },
      { kind: "suppressed", id: "ffffffff5555", status: "false_positive", description: "fp" },
    ]
    const alerts = alertsForRun("pai", incoming, outcomes)
    const p1 = alerts.filter((a) => a.severity === "P1")
    expect(p1.map((a) => a.title)).toEqual(["New high finding in pai", "Resurfaced finding in pai"])
    expect(p1[0].message).toBe("PAI/TOOLS/x.ts:7 — new one [aaaaaaaa]")
    expect(p1[0].id).toBe("aaaaaaaa")
    const p2 = alerts.filter((a) => a.severity === "P2")
    expect(p2).toHaveLength(1)
    expect(p2[0].message).toBe("5 finding(s): 2 new, 1 recurring, 1 resurfaced, 1 suppressed.")
  })
  test("empty run still sends the tally, so a silent night is visible", () => {
    const alerts = alertsForRun("pai", [], [])
    expect(alerts).toHaveLength(1)
    expect(alerts[0].message).toBe("0 finding(s): 0 new, 0 recurring, 0 resurfaced, 0 suppressed.")
  })
  test("message stays under the /notify 500-char limit", () => {
    const [a] = alertsForRun("pai", [inc("high", "x".repeat(2000))], [{ kind: "new", id: "aaaaaaaa1111" }])
    expect(a.message.length).toBeLessThanOrEqual(500)
  })
})
