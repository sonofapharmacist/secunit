import { describe, expect, test } from "bun:test"
import { type AlertRow, type DigestInput, buildDigest, enabledJobs } from "./MorningDigest"

const NOW = Date.parse("2026-10-03T12:00:00Z") // 07:00 CDT
const base = (over: Partial<DigestInput> = {}): DigestInput => ({
  now: NOW, timeZone: "America/Chicago", alerts: [], failingJobs: [], reviewOpen: 3,
  reviewByStatus: { new: 3 }, diskPct: 37, docDrift: 86, results: [], ...over,
})
const row = (over: Partial<AlertRow>): AlertRow => ({ ts: "2026-10-03T09:00:00Z", title: "t", message: "m", severity: "P2", ...over })

describe("morning digest (ISC-17..20)", () => {
  test("empty day sends one line that names the state (ISC-20)", () => {
    const d = buildDigest(base({ alerts: [row({ source: "nightly-review", title: "Nightly review: pai-config", message: "0 finding(s)" })] }))
    expect(d.empty).toBe(true)
    expect(d.title).toBe("PAI digest 2026-10-03: quiet")
    expect(d.markdown.split("\n")).toHaveLength(1)
    expect(d.markdown).toContain("Nightly review ran (1 repo)")
    expect(d.markdown).toContain("disk 37%")
  })
  test("a quiet day with no review tally says the review did not report", () => {
    expect(buildDigest(base()).markdown).toContain("Nightly review did not report")
  })
  test("pushed and held alerts are listed with their governor outcome (ISC-17)", () => {
    const d = buildDigest(base({ alerts: [
      row({ severity: "P1", source: "nightly-review", title: "New high finding in pai", governor: "hold-quiet" }),
      row({ severity: "P0", source: "canary-inspector", title: "Canary token tripped", governor: "send" }),
      row({ severity: "P1", source: "x", title: "dup", governor: "dedup" }),
    ] }))
    expect(d.empty).toBe(false)
    expect(d.markdown).toContain("P1 nightly-review: New high finding in pai _(hold-quiet)_")
    expect(d.markdown).toContain("P0 canary-inspector: Canary token tripped")
    expect(d.markdown).not.toContain("dup")
  })
  test("includes review tally, failing jobs, results, disk and drift (ISC-18)", () => {
    const d = buildDigest(base({
      alerts: [row({ source: "nightly-review", title: "Nightly review: my-app", message: "2 finding(s): 1 new" }), row({ source: "cost-tracker", title: "cost" })],
      failingJobs: [{ name: "latency-drift-check", failures: 3, lastResult: "error" }],
      results: [{ path: "confirm-01/confirm-summary.jsonl", line: "CONFIRMED" }],
      diskPct: 85,
    }))
    expect(d.markdown).toContain("my-app: 2 finding(s): 1 new")
    expect(d.markdown).toContain("latency-drift-check: 3 consecutive")
    expect(d.markdown).toContain("confirm-01/confirm-summary.jsonl: CONFIRMED")
    expect(d.markdown).toContain("cost-tracker: 1")
    expect(d.markdown).toContain("disk 85%")
    expect(d.markdown).toContain("⚠ disk high")
    expect(d.markdown).toContain("doc drift 86")
  })
  test("prompt-title chatter alone is still a quiet day", () => {
    const d = buildDigest(base({ alerts: [row({ source: "prompt-title", title: "Working on", message: "x" })] }))
    expect(d.empty).toBe(true)
  })
})

describe("enabledJobs", () => {
  test("disabled jobs are excluded; comments and other tables ignored", () => {
    const toml = `[settings]\nname = "x"\n\n[[job]]\nname = "a"\nenabled = true\n\n# note\n[[job]]\nname = "tldr-scrape"\nenabled = false\n\n[[job]]\nname = "c"\n`
    expect([...enabledJobs(toml)]).toEqual(["a", "c"])
  })
  test("matches the live PULSE.toml: tldr-scrape off, morning-digest on", async () => {
    const live = enabledJobs(await Bun.file(new URL("./PULSE.toml", import.meta.url)).text())
    expect(live.has("tldr-scrape")).toBe(false)
    expect(live.has("morning-digest")).toBe(true)
  })
})
