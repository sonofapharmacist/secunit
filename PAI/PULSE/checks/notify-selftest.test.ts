import { describe, expect, test } from "bun:test"
import { roundTrip } from "./notify-selftest"

// Fake ntfy: stores published bodies per URL; optionally hides them for the first N reads.
function fakeNtfy(opts: { pubStatus?: number; hideReads?: number } = {}) {
  const store = new Map<string, string[]>()
  let reads = 0
  const seen: Array<{ url: string; auth?: string }> = []
  const f = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    seen.push({ url, auth: headers.Authorization })
    if (init?.method === "POST") {
      if (opts.pubStatus && opts.pubStatus !== 200) return new Response("no", { status: opts.pubStatus })
      store.set(url, [...(store.get(url) ?? []), String(init.body)])
      return new Response("{}")
    }
    const base = url.split("/json")[0]
    const visible = reads++ >= (opts.hideReads ?? 0)
    return new Response(visible ? (store.get(base) ?? []).map((m) => JSON.stringify({ message: m })).join("\n") : "")
  }) as unknown as typeof fetch
  return { f, seen }
}

describe("notify self-test round trip (ISC-28)", () => {
  test("publish then read back the nonce passes; token goes in the header", async () => {
    const { f, seen } = fakeNtfy()
    const c = await roundTrip("http://h:2586", "pai-selftest", "tk_x", f, 0)
    expect(c.ok).toBe(true)
    expect(seen.every((s) => s.auth === "Bearer tk_x" && !s.url.includes("tk_x"))).toBe(true)
  })
  test("eventual consistency: passes when the message shows up on a later read", async () => {
    const { f } = fakeNtfy({ hideReads: 2 })
    expect((await roundTrip("ntfy.sh", "t", undefined, f, 0)).ok).toBe(true)
  })
  test("never visible fails after 3 reads", async () => {
    const { f } = fakeNtfy({ hideReads: 99 })
    const c = await roundTrip("ntfy.sh", "t", undefined, f, 0)
    expect(c.ok).toBe(false)
    expect(c.detail).toContain("3 reads")
  })
  test("auth failure on publish is reported", async () => {
    const { f } = fakeNtfy({ pubStatus: 401 })
    expect((await roundTrip("http://h", "t", "bad", f, 0)).detail).toBe("publish HTTP 401")
  })
})
