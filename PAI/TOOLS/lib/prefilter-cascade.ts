/**
 * Nightly review pre-filter as a cascade job (local-first cascade F4, job 2/2).
 *
 * The fast tier answers one bounded question per diff chunk: does it touch security-relevant
 * surface? Before the cascade, an unparseable local answer was silently defaulted to flag=true
 * and a transport failure sent the chunk to Sonnet, so neither showed up in any metric. Now an
 * unusable local answer escalates to Haiku, and only when both fail does the caller fall back
 * to its old fail-toward-review path (null → Sonnet reviews the chunk).
 *
 * The local leg keeps the pipeline's direct llama-server call (json_schema response_format,
 * 4000-token budget for KAT's reasoning trace); Inference.ts's ollama path supports neither.
 */

import type { Call, JobContract, Verdict } from "./cascade"
import type { InferenceOptions, InferenceResult } from "../Inference"

export interface PrefilterResult { flag: boolean; reason: string }

export const PREFILTER_JOB = "review-prefilter"

export const PREFILTER_SYSTEM_PROMPT =
  "You are a fast triage classifier for a code review pipeline. You are NOT judging whether " +
  "code is well-written or whether a change is a good idea — you are answering ONE bounded " +
  "question: does this diff chunk touch security-relevant surface? " +
  "Security-relevant surface means: authentication, authorization/permission checks, secrets " +
  "or credential handling, input validation, injection-prone patterns (SQL/shell/command/path), " +
  "network egress or new external calls, cryptography, or access-control logic. " +
  "Plain content edits (docs, JSON data/knowledge files, comments, formatting, tag renames, " +
  "prose rewording) are NOT security-relevant even if the wording changes meaning — flag=false. " +
  "If genuinely unsure, prefer flag=true (this is a recall task — false positives cost a Sonnet " +
  "read, false negatives skip review entirely). " +
  "Respond with ONLY a JSON object, no prose, no markdown fences."

export function prefilterUserPrompt(repoPath: string, label: string, diffText: string): string {
  return (
    `CONTEXT\n  Repo: ${label} (${repoPath})\n\n` +
    `THE DIFF (a portion of the last 24h of commits — other files are classified in separate calls)\n` +
    `\`\`\`diff\n${diffText}\n\`\`\`\n\n` +
    `Return strict JSON matching this shape:\n` +
    `{"flag": true|false, "reason": "one sentence: what security-relevant surface (if any) this chunk touches, or why it doesn't"}`
  )
}

export const CLASSIFICATION_SCHEMA = {
  type: "object",
  properties: { flag: { type: "boolean" }, reason: { type: "string" } },
  required: ["flag", "reason"],
}

/** Accepts the first {...} span or the whole text; tolerates the "flagged" field-name drift. */
export function verifyPrefilter(output: string): Verdict<PrefilterResult> {
  const candidates = [output.match(/\{[\s\S]*\}/)?.[0], output].filter((c): c is string => typeof c === "string")
  for (const c of candidates) {
    let o: Record<string, unknown>
    try { o = JSON.parse(c) } catch { continue }
    if (!o || typeof o !== "object") continue
    const flag = o.flag ?? o.flagged
    if (typeof flag === "boolean" && typeof o.reason === "string") return { ok: true, value: { flag, reason: o.reason } }
  }
  return { ok: false, reason: output.trim() ? "no {flag, reason} object" : "empty content" }
}

export function prefilterContract(localModel: string): JobContract<{ repoPath: string; label: string; diffText: string }, PrefilterResult> {
  return {
    job: PREFILTER_JOB,
    build: (i) => ({ systemPrompt: PREFILTER_SYSTEM_PROMPT, userPrompt: prefilterUserPrompt(i.repoPath, i.label, i.diffText), expectJson: true }),
    verify: verifyPrefilter,
    // 120 s is the old direct-call budget; nothing waits on the nightly job.
    local: { model: localModel, timeoutMs: 120_000 },
    cloud: { level: "fast", timeoutMs: 60_000 },
  }
}

/**
 * Local leg → direct llama-server call with the JSON schema; cloud leg → `cloud` (inference()).
 * `content` only: KAT also returns reasoning_content, which must never be scored.
 */
export function prefilterCall(baseUrl: string, cloud: Call, fetchImpl: typeof fetch = fetch): Call {
  return async (o: InferenceOptions): Promise<InferenceResult> => {
    if (o.backend !== "ollama") return cloud(o)
    const t0 = Date.now()
    const fail = (error: string): InferenceResult => ({ success: false, output: "", error, latencyMs: Date.now() - t0, level: "fast" })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), o.timeout ?? 120_000)
    try {
      const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: o.model,
          messages: [{ role: "system", content: o.systemPrompt }, { role: "user", content: o.userPrompt }],
          temperature: 0.2,
          max_tokens: 4000,
          response_format: { type: "json_schema", json_schema: { name: "classification", schema: CLASSIFICATION_SCHEMA } },
        }),
        signal: controller.signal,
      })
      if (!res.ok) return fail(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
      return { success: true, output: body.choices[0]?.message?.content ?? "", latencyMs: Date.now() - t0, level: "fast" }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    } finally {
      clearTimeout(timer)
    }
  }
}
