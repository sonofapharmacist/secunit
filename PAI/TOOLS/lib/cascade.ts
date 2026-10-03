/**
 * Local-first cascade with a verifier (F4, ISC-20/21/23).
 *
 * Inference.ts's `localFirst` escalates only when the local call errors. A local
 * model that answers *wrongly* (bad JSON, a fenced YAML block, an out-of-range
 * rating) sailed through. Here every job declares a deterministic verifier, and
 * a verified local answer is the only way to skip the cloud:
 *
 *   floor met?  ──no──▶ cloud only
 *       │yes
 *   local call ─▶ verify ─ok─▶ done (path "local")
 *       │fail / error
 *   cloud call ─▶ verify ─ok─▶ done (path "escalated")
 *       │fail / error
 *   failed (caller keeps its own fail-safe; the cascade never invents an answer)
 *
 * One `backend: "cascade"` row per run goes to inference-calls.jsonl, next to
 * the per-call rows inference() already writes, so escalation rates per job are
 * one jq away (CascadeReport.ts).
 */

import { appendFileSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import type { InferenceLevel, InferenceOptions, InferenceResult } from "../Inference"

export type Verdict<O> = { ok: true; value: O } | { ok: false; reason: string }

export interface JobContract<I, O> {
  /** Stable id; the floors-file key and the `caller` in logs. */
  job: string
  build(input: I): { systemPrompt: string; userPrompt: string; expectJson?: boolean; maxTokens?: number }
  /** Deterministic, no model calls. */
  verify(output: string): Verdict<O>
  local: { model: string; timeoutMs: number }
  cloud: { level: InferenceLevel; timeoutMs: number }
}

export type Path = "local" | "escalated" | "cloud-only" | "failed"

export interface CascadeResult<O> {
  path: Path
  value?: O
  /** Why local was skipped or rejected, and why cloud failed if it did. */
  reasons: string[]
  latencyMs: number
}

export type Call = (o: InferenceOptions) => Promise<InferenceResult>

export interface Floor { floor: number; measured: number | null; source?: string }

/** ISC-23: local-first only when a measured held-out pass rate meets the declared floor. */
export function localAllowed(floors: Record<string, Floor>, job: string): { ok: boolean; reason: string } {
  const f = floors[job]
  if (!f) return { ok: false, reason: `no floor declared for ${job}` }
  if (f.measured === null || f.measured === undefined) return { ok: false, reason: `${job} has no measured pass rate` }
  return f.measured >= f.floor
    ? { ok: true, reason: `measured ${f.measured} >= floor ${f.floor}` }
    : { ok: false, reason: `measured ${f.measured} < floor ${f.floor}` }
}

export async function runCascade<I, O>(
  contract: JobContract<I, O>,
  input: I,
  deps: { call: Call; floors: Record<string, Floor>; log?: (row: Record<string, unknown>) => void; now?: () => number },
): Promise<CascadeResult<O>> {
  const now = deps.now ?? Date.now
  const t0 = now()
  const reasons: string[] = []
  const prompt = contract.build(input)
  const base = { systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt, expectJson: prompt.expectJson, maxTokens: prompt.maxTokens }

  const attempt = async (opts: InferenceOptions, label: string): Promise<Verdict<O>> => {
    try {
      const r = await deps.call(opts)
      if (!r.success) return { ok: false, reason: `${label} error: ${(r.error ?? "unknown").slice(0, 160)}` }
      const v = contract.verify(r.output)
      return v.ok ? v : { ok: false, reason: `${label} rejected: ${v.reason}` }
    } catch (e) {
      return { ok: false, reason: `${label} threw: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  let path: Path
  let value: O | undefined
  const gate = localAllowed(deps.floors, contract.job)
  let triedLocal = false

  if (gate.ok) {
    triedLocal = true
    const v = await attempt({ ...base, backend: "ollama", model: contract.local.model, timeout: contract.local.timeoutMs }, "local")
    if (v.ok) {
      path = "local"
      value = v.value
    } else reasons.push(v.reason)
  } else reasons.push(`local skipped: ${gate.reason}`)

  if (value === undefined) {
    // localFirst/fallbackToOllama false: the escalation must not route back to local via config.
    const v = await attempt(
      { ...base, backend: "claude", level: contract.cloud.level, timeout: contract.cloud.timeoutMs, localFirst: false, fallbackToOllama: false },
      "cloud",
    )
    if (v.ok) {
      path = triedLocal ? "escalated" : "cloud-only"
      value = v.value
    } else {
      path = "failed"
      reasons.push(v.reason)
    }
  }

  const result: CascadeResult<O> = { path: path!, value, reasons, latencyMs: now() - t0 }
  deps.log?.({
    timestamp: new Date(t0).toISOString(),
    backend: "cascade",
    caller: contract.job,
    cascade_path: result.path,
    escalated_from_local: result.path === "escalated",
    latency_ms: result.latencyMs,
    reasons: reasons.map((r) => r.slice(0, 200)),
  })
  return result
}

// ── production wiring ──

const PAI = process.env.PAI_DIR ?? join(process.env.HOME ?? "~", ".claude", "PAI")
export const FLOORS_PATH = join(PAI, "USER", "Config", "cascade-floors.json")
// Same file as Inference.ts INFERENCE_LOG (built from HOME there, not PAI_DIR), so rows sit side by side.
export const INFERENCE_LOG_PATH = join(process.env.HOME || process.env.USERPROFILE || "", ".claude", "PAI", "MEMORY", "OBSERVABILITY", "inference-calls.jsonl")

/** Missing or unreadable floors file → no job runs local (fail toward quality). */
export function loadFloors(path = FLOORS_PATH): Record<string, Floor> {
  try {
    if (!existsSync(path)) return {}
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { jobs?: Record<string, Floor> }
    return raw.jobs ?? {}
  } catch {
    return {}
  }
}

export function appendCascadeRow(row: Record<string, unknown>): void {
  try {
    appendFileSync(INFERENCE_LOG_PATH, JSON.stringify(row) + "\n")
  } catch {
    // logging must never fail the job
  }
}
