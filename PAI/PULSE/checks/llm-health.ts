#!/usr/bin/env bun
/**
 * Local LLM tier health — script-type Pulse job (alerting ISA ISC-24).
 *
 * Probes each configured llama-server tier (/health, plus /props for the served
 * alias when an expected alias is given). A tier that stays unhealthy for
 * DOWN_ALERT_MS sends one P1; when it comes back after that alert, one P2.
 * Blips shorter than the window stay silent, since restarts and model loads are normal.
 *
 * Tiers: PAI_PULSE_LLM_TIERS="name|baseUrl|expectedAlias,..." (alias optional).
 * Empty default ships in the public release; principals add their own hosts.
 * State: PULSE/state/llm-health.json. Output: a status line, or NO_ACTION.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"

export const DOWN_ALERT_MS = 10 * 60_000

export interface Tier { name: string; url: string; alias?: string }
export interface TierState { downSince?: number; alerted?: boolean; lastError?: string }
export interface Probe { ok: boolean; error?: string }
export interface HealthAlert { title: string; message: string; severity: "P1" | "P2"; source: "llm-health"; id: string }

export function parseTiers(spec: string | undefined): Tier[] {
  return (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [name, url, alias] = entry.split("|").map((s) => s.trim())
    return { name, url: (url ?? "").replace(/\/+$/, ""), alias: alias || undefined }
  }).filter((t) => t.name && t.url)
}

/** Pure transition: returns the next state and an alert when one is due. */
export function step(tier: string, prev: TierState, probe: Probe, now: number): { next: TierState; alert: HealthAlert | null } {
  if (probe.ok) {
    if (prev.alerted) {
      const mins = Math.round((now - (prev.downSince ?? now)) / 60_000)
      return { next: {}, alert: { title: `Local LLM recovered: ${tier}`, message: `${tier} is healthy again after about ${mins} min down.`, severity: "P2", source: "llm-health", id: `llm-${tier}` } }
    }
    return { next: {}, alert: null }
  }
  const downSince = prev.downSince ?? now
  const next: TierState = { downSince, alerted: prev.alerted, lastError: probe.error }
  if (!prev.alerted && now - downSince >= DOWN_ALERT_MS) {
    next.alerted = true
    const mins = Math.round((now - downSince) / 60_000)
    return { next, alert: { title: `Local LLM down: ${tier}`, message: `${tier} has been unhealthy for ${mins} min: ${probe.error ?? "no detail"}. Local-first jobs fall back to cloud or fail until it returns.`, severity: "P1", source: "llm-health", id: `llm-${tier}` } }
  }
  return { next, alert: null }
}

async function probe(t: Tier): Promise<Probe> {
  try {
    const h = await fetch(`${t.url}/health`, { signal: AbortSignal.timeout(5_000) })
    if (!h.ok) return { ok: false, error: `/health HTTP ${h.status}` }
    if (t.alias) {
      const p = await fetch(`${t.url}/props`, { signal: AbortSignal.timeout(5_000) })
      const props = p.ok ? ((await p.json()) as { model_alias?: string }) : {}
      if (props.model_alias !== t.alias) return { ok: false, error: `serving ${props.model_alias ?? "unknown"}, expected ${t.alias}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

if (import.meta.main) {
  const tiers = parseTiers(process.env.PAI_PULSE_LLM_TIERS)
  if (tiers.length === 0) { console.log("NO_ACTION"); process.exit(0) }
  const statePath = join(process.env.PAI_DIR ?? join(process.env.HOME ?? "~", ".claude", "PAI"), "PULSE", "state", "llm-health.json")
  let state: Record<string, TierState> = {}
  try { if (existsSync(statePath)) state = JSON.parse(readFileSync(statePath, "utf-8")) } catch { state = {} }

  const now = Date.now()
  const lines: string[] = []
  for (const t of tiers) {
    const { next, alert } = step(t.name, state[t.name] ?? {}, await probe(t), now)
    state[t.name] = next
    if (next.downSince) lines.push(`${t.name} down ${Math.round((now - next.downSince) / 60_000)} min: ${next.lastError}`)
    if (alert) {
      try {
        await fetch("http://localhost:31337/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(alert), signal: AbortSignal.timeout(3_000) })
      } catch (e) {
        lines.push(`notify failed for ${alert.id}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, JSON.stringify(state))
  console.log(lines.length ? lines.join("\n") : "NO_ACTION")
}
