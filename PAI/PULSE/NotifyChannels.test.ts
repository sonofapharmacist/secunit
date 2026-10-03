import { describe, expect, test } from "bun:test"
import {
  type Alert, buildChannels, detectDesktop, dispatch, expandEnv, formatForNtfy,
  normalizeServer, ntfyChannel, parseSeverity, severityReaches,
} from "./NotifyChannels"

const alert = (over: Partial<Alert> = {}): Alert => ({
  title: "New high finding",
  message: "SQL injection in PAI/TOOLS/foo.ts:42",
  severity: "P1",
  source: "nightly-review",
  id: "f-123",
  ...over,
})

describe("severity", () => {
  test("unknown or missing severity defaults to P2", () => {
    expect(parseSeverity(undefined)).toBe("P2")
    expect(parseSeverity("urgent")).toBe("P2")
    expect(parseSeverity("p0")).toBe("P0")
  })
  test("P0 reaches a P1 channel, P2 does not", () => {
    expect(severityReaches("P0", "P1")).toBe(true)
    expect(severityReaches("P1", "P1")).toBe(true)
    expect(severityReaches("P2", "P1")).toBe(false)
  })
})

describe("ntfy payload (ISC-8)", () => {
  test("untrusted relay gets no message text, title text or path", () => {
    const m = formatForNtfy(alert(), false)
    const all = `${m.title} ${m.body}`
    expect(all).not.toContain("SQL injection")
    expect(all).not.toContain("foo.ts")
    expect(all).not.toContain("New high finding")
    expect(all).toContain("f-123")
    expect(m.priority).toBe(4)
  })
  test("trusted server gets full text", () => {
    const m = formatForNtfy(alert(), true)
    expect(m.body).toContain("SQL injection")
  })
  test("P0 maps to priority 5", () => {
    expect(formatForNtfy(alert({ severity: "P0" }), false).priority).toBe(5)
  })
})

describe("ntfy channel", () => {
  test("token goes in the Authorization header, never the URL (ISC-6)", async () => {
    let seenUrl = ""
    let seenHeaders: Record<string, string> = {}
    const fake = (async (url: string, init: RequestInit) => {
      seenUrl = url
      seenHeaders = init.headers as Record<string, string>
      return new Response("ok")
    }) as unknown as typeof fetch
    const ch = ntfyChannel({ server: "ntfy.example", topic: "${T}" }, { T: "my-alerts", NTFY_TOKEN: "tk_secret" }, fake)!
    await ch.send(alert())
    expect(seenUrl).toBe("https://ntfy.example/my-alerts")
    expect(seenUrl).not.toContain("tk_secret")
    expect(seenHeaders.Authorization).toBe("Bearer tk_secret")
  })
  test("unresolved topic placeholder means no channel", () => {
    expect(ntfyChannel({ topic: "${NTFY_TOPIC}" }, {})).toBeNull()
  })
  test("HTTP error surfaces as a failed delivery, not a throw", async () => {
    const fake = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch
    const ch = ntfyChannel({ topic: "t" }, {}, fake)!
    const [d] = await dispatch(alert(), [ch])
    expect(d.outcome).toBe("failed")
    expect(d.error).toContain("403")
  })
  test("P2 is not pushed (ISC-7)", async () => {
    let called = false
    const fake = (async () => { called = true; return new Response("ok") }) as unknown as typeof fetch
    const ch = ntfyChannel({ topic: "t" }, {}, fake)!
    const [d] = await dispatch(alert({ severity: "P2" }), [ch])
    expect(d.outcome).toBe("below-threshold")
    expect(called).toBe(false)
  })
})

describe("host detection", () => {
  test("headless Linux has no desktop", () => {
    expect(detectDesktop("linux", {}, "Linux version 7.0.0-generic", true)).toBe("none")
  })
  test("WSL is detected even though platform is linux", () => {
    expect(detectDesktop("linux", {}, "Linux version 6.6 microsoft-standard-WSL2", false)).toBe("wsl")
    expect(detectDesktop("linux", { WSL_DISTRO_NAME: "Ubuntu" }, "", false)).toBe("wsl")
  })
  test("Linux with a display needs notify-send", () => {
    expect(detectDesktop("linux", { DISPLAY: ":0" }, "", true)).toBe("linux-desktop")
    expect(detectDesktop("linux", { DISPLAY: ":0" }, "", false)).toBe("none")
  })
  test("macOS", () => {
    expect(detectDesktop("darwin", {}, "", false)).toBe("macos")
  })
})

describe("assembly", () => {
  test("headless box with no ntfy config has zero channels (ISC-3 surfaces this)", () => {
    expect(buildChannels({ ntfy: { enabled: true, topic: "${NTFY_TOPIC}", server: "ntfy.sh" } }, {}, "none")).toHaveLength(0)
  })
  test("desktop can be disabled; ntfy defaults to untrusted", () => {
    const chs = buildChannels({ desktop: { enabled: false }, ntfy: { topic: "t" } }, {}, "macos")
    expect(chs.map((c) => c.name)).toEqual(["ntfy (ids-only)"])
  })
  test("server normalization and env expansion", () => {
    expect(normalizeServer(undefined)).toBe("https://ntfy.sh")
    expect(normalizeServer("http://ntfy.example.net:2586/")).toBe("http://ntfy.example.net:2586")
    expect(expandEnv("${A}-x", { A: "a" })).toBe("a-x")
  })
})
