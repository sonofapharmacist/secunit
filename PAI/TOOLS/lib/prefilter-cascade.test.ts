import { describe, expect, test } from "bun:test"
import { runCascade } from "./cascade"
import { prefilterCall, prefilterContract, verifyPrefilter } from "./prefilter-cascade"

const floors = { "review-prefilter": { floor: 0.9, measured: 0.95 } }
const input = { repoPath: "/r", label: "pai", diffText: "+x" }

function fakeFetch(content: string | null, status = 200): typeof fetch {
  return (async () => {
    if (content === null) throw new Error("ECONNREFUSED")
    return new Response(JSON.stringify({ choices: [{ message: { content, reasoning_content: '{"flag": false, "reason": "scratch"}' } }] }), { status })
  }) as unknown as typeof fetch
}

const cloud = (output: string, success = true) => async () => ({ success, output, latencyMs: 1, level: "fast" as const })

describe("verifyPrefilter", () => {
  test("accepts the object, fenced or with the flagged drift", () => {
    expect(verifyPrefilter('{"flag": true, "reason": "auth"}')).toEqual({ ok: true, value: { flag: true, reason: "auth" } })
    expect(verifyPrefilter('```json\n{"flagged": false, "reason": "docs"}\n```')).toEqual({ ok: true, value: { flag: false, reason: "docs" } })
  })
  test("rejects missing reason, string flags and empty content", () => {
    expect(verifyPrefilter('{"flag": true}').ok).toBe(false)
    expect(verifyPrefilter('{"flag": "yes", "reason": "x"}').ok).toBe(false)
    expect(verifyPrefilter("")).toEqual({ ok: false, reason: "empty content" })
  })
})

describe("pre-filter cascade", () => {
  test("a verified local answer stays local and scores content, never reasoning_content", async () => {
    const r = await runCascade(prefilterContract("kat"), input, { call: prefilterCall("http://x", cloud("unused"), fakeFetch('{"flag": true, "reason": "token header"}')), floors })
    expect(r.path).toBe("local")
    expect(r.value).toEqual({ flag: true, reason: "token header" })
  })

  test("empty local content (reasoning budget exhausted) escalates to cloud", async () => {
    const r = await runCascade(prefilterContract("kat"), input, { call: prefilterCall("http://x", cloud('{"flag": false, "reason": "docs"}'), fakeFetch("")), floors })
    expect(r.path).toBe("escalated")
    expect(r.value?.flag).toBe(false)
    expect(r.reasons[0]).toContain("empty content")
  })

  test("local host down escalates; both failing returns no value, so the caller sends the chunk to Sonnet", async () => {
    const down = await runCascade(prefilterContract("kat"), input, { call: prefilterCall("http://x", cloud('{"flag": true, "reason": "x"}'), fakeFetch(null)), floors })
    expect(down.path).toBe("escalated")
    const both = await runCascade(prefilterContract("kat"), input, { call: prefilterCall("http://x", cloud("", false), fakeFetch(null)), floors })
    expect(both.path).toBe("failed")
    expect(both.value).toBeUndefined()
  })

  test("HTTP error from llama-server is a local failure, not an answer", async () => {
    const r = await runCascade(prefilterContract("kat"), input, { call: prefilterCall("http://x", cloud('{"flag": true, "reason": "x"}'), fakeFetch("{}", 503)), floors })
    expect(r.path).toBe("escalated")
    expect(r.reasons[0]).toContain("HTTP 503")
  })
})
