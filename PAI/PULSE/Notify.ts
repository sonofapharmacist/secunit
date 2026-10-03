/**
 * PAI Pulse — Notify Module
 *
 * Severity-routed delivery (desktop on macOS/Linux/WSL, ntfy), input
 * sanitization, rate limiting. Channels live in NotifyChannels.ts.
 * Replaces VoiceServer/voice.ts after the 2026-08-08 ElevenLabs removal —
 * /notify was never voice-only; it's the general notification/progress
 * ingestion endpoint that many tools (ForgeProgress, AnvilProgress,
 * CostTracker, TLDRCatchup, the installer, etc.) POST to with a hardcoded
 * default of http://localhost:31337/notify. TTS synthesis is gone; the
 * route contract (accept title/message, sanitize, rate-limit, notify,
 * return JSON) is preserved so those callers keep working unchanged.
 *
 * Does NOT create its own HTTP server. Exports handleNotifyRequest() for
 * the parent pulse.ts to call on matching routes.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { log } from "./lib"
import {
  type Alert, type Channel, type Delivery, type NotificationSettings,
  buildChannels, detectHostDesktop, dispatch, loadNotificationSettings, parseSeverity,
} from "./NotifyChannels"
import { DEFAULT_GOVERNOR, type GovernorConfig, type GovernorState, decide, emptyState, tick } from "./NotifyGovernor"

// ── Public Config Interface ──

export interface NotifyConfig {
  enabled: boolean
}

// ── Internal Types ──

interface LoadedNotifyConfig {
  channels: Channel[]
  governor: GovernorConfig
}

// ── Module State ──

let moduleConfig: NotifyConfig = { enabled: false }
let notifyConfig: LoadedNotifyConfig = { channels: [], governor: { ...DEFAULT_GOVERNOR, quietHours: null } }
let governorState: GovernorState = emptyState()
let tickTimer: ReturnType<typeof setInterval> | null = null
let lastDelivery: { at: string; severity: string; deliveries: Delivery[] } | null = null

const PAI_ROOT = process.env.PAI_DIR ?? join(process.env.HOME ?? "~", ".claude", "PAI")
const ALERT_LOG = join(PAI_ROOT, "MEMORY", "OBSERVABILITY", "alerts.jsonl")
const GOVERNOR_STATE = join(PAI_ROOT, "PULSE", "state", "notify-governor.json")
let initialized = false

// ── Constants ──

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "http://localhost",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

// ── Rate Limiting ──

const requestCounts = new Map<string, { count: number; resetTime: number }>()
const RATE_LIMIT = 10
const RATE_WINDOW = 60_000

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const record = requestCounts.get(ip)

  if (!record || now > record.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_WINDOW })
    return true
  }

  if (record.count >= RATE_LIMIT) return false

  record.count++
  return true
}

// ── Notify Config from settings.json ──

function governorConfig(n: NotificationSettings): GovernorConfig {
  if (n.quietHours === false) return { ...DEFAULT_GOVERNOR, quietHours: null }
  const q = n.quietHours ?? {}
  return {
    ...DEFAULT_GOVERNOR,
    quietHours: {
      start: q.start ?? "22:00",
      end: q.end ?? "07:00",
      timeZone: q.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  }
}

function loadNotifyConfigFromSettings(): LoadedNotifyConfig {
  try {
    const notifications: NotificationSettings = loadNotificationSettings()
    return { channels: buildChannels(notifications, process.env, detectHostDesktop()), governor: governorConfig(notifications) }
  } catch (err) {
    log("warn", "Notify: could not read notification settings; desktop only", { error: String(err) })
    return { channels: buildChannels({}, process.env, detectHostDesktop()), governor: governorConfig({}) }
  }
}

function loadGovernorState(): GovernorState {
  try {
    if (existsSync(GOVERNOR_STATE)) return { ...emptyState(), ...JSON.parse(readFileSync(GOVERNOR_STATE, "utf-8")) }
  } catch (err) {
    log("warn", "Notify: governor state unreadable; starting empty", { error: String(err) })
  }
  return emptyState()
}

function saveGovernorState(): void {
  try {
    mkdirSync(dirname(GOVERNOR_STATE), { recursive: true })
    writeFileSync(GOVERNOR_STATE, JSON.stringify(governorState))
  } catch (err) {
    log("error", "Notify: governor state write failed", { error: String(err) })
  }
}

// ── Input Sanitization ──

function sanitizeMessage(input: string): string {
  return input
    .replace(/<script/gi, "")
    .replace(/\.\.\//g, "")
    .replace(/[;&|><`$\\]/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .trim()
    .substring(0, 500)
}

function validateInput(input: unknown): { valid: boolean; error?: string; sanitized?: string } {
  if (!input || typeof input !== "string") {
    return { valid: false, error: "Invalid input type" }
  }

  if (input.length > 500) {
    return { valid: false, error: "Message too long (max 500 characters)" }
  }

  const sanitized = sanitizeMessage(input)

  if (!sanitized || sanitized.length === 0) {
    return { valid: false, error: "Message contains no valid content after sanitization" }
  }

  return { valid: true, sanitized }
}

// ── Core: Send Notification ──

function logAlert(entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(ALERT_LOG), { recursive: true })
    appendFileSync(ALERT_LOG, JSON.stringify(entry) + "\n")
  } catch (err) {
    log("error", "Notify: alerts.jsonl write failed", { error: String(err) })
  }
}

function optionalField(v: unknown, max = 100): string | undefined {
  return typeof v === "string" && v.trim() ? sanitizeMessage(v).substring(0, max) : undefined
}

function optionalLink(v: unknown): string | undefined {
  return typeof v === "string" && /^https?:\/\/[^\s]+$/.test(v) && v.length <= 500 ? v : undefined
}

async function sendNotification(title: string, message: string, extra: Record<string, unknown> = {}): Promise<Delivery[]> {
  const titleValidation = validateInput(title)
  const messageValidation = validateInput(message)

  if (!titleValidation.valid) throw new Error(`Invalid title: ${titleValidation.error}`)
  if (!messageValidation.valid) throw new Error(`Invalid message: ${messageValidation.error}`)

  const alert: Alert = {
    title: titleValidation.sanitized!,
    message: messageValidation.sanitized!,
    severity: parseSeverity(extra.severity),
    source: optionalField(extra.source),
    id: optionalField(extra.id),
    link: optionalLink(extra.link),
  }

  return deliverAlert(alert)
}

/**
 * Governed delivery. Held alerts (quiet hours, flood) still reach local
 * channels (desktop) and the log; only the push waits. Dedup sends nothing.
 */
export async function deliverAlert(alert: Alert): Promise<Delivery[]> {
  const decision = decide(alert, Date.now(), governorState, notifyConfig.governor)
  saveGovernorState()
  const channels =
    decision.action === "send" ? notifyConfig.channels
    : decision.action === "dedup" ? []
    : notifyConfig.channels.filter((c) => c.minSeverity === "P2")
  return dispatchAndLog(alert, channels, decision.action)
}

async function dispatchAndLog(alert: Alert, channels: Channel[], governor: string): Promise<Delivery[]> {
  const deliveries = await dispatch(alert, channels)
  const at = new Date().toISOString()
  lastDelivery = { at, severity: alert.severity, deliveries }
  logAlert({ ts: at, ...alert, governor, deliveries })
  for (const d of deliveries) {
    if (d.outcome === "failed") log("error", "Notify: delivery failed", { channel: d.channel, error: d.error })
  }
  if (notifyConfig.channels.length === 0) log("warn", "Notify: no delivery channel configured; logged to alerts.jsonl only", { severity: alert.severity })
  return deliveries
}

async function runGovernorTick(): Promise<void> {
  try {
    const due = tick(Date.now(), governorState, notifyConfig.governor)
    saveGovernorState()
    for (const summary of due) await dispatchAndLog(summary, notifyConfig.channels, "release")
  } catch (err) {
    log("error", "Notify: governor tick failed", { error: String(err) })
  }
}

// ── JSON Error Response Helper ──

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    status,
  })
}

function errorStatus(message: string): number {
  return message.includes("Invalid") ? 400 : 500
}

// ── Public API ──

/**
 * Initialize the notify module. Call once at startup before handling requests.
 */
export function startNotify(config: NotifyConfig): void {
  moduleConfig = config

  if (!config.enabled) {
    log("info", "Notify module: disabled")
    return
  }

  notifyConfig = loadNotifyConfigFromSettings()
  governorState = loadGovernorState()
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = setInterval(runGovernorTick, 60_000)
  initialized = true
  log(notifyConfig.channels.length ? "info" : "warn", "Notify module: initialized", {
    channels: notifyConfig.channels.map((c) => c.name),
    quietHours: notifyConfig.governor.quietHours,
  })
}

/**
 * Health check for the notify subsystem.
 */
export function notifyHealth(): Record<string, unknown> {
  return {
    initialized,
    enabled: moduleConfig.enabled,
    channels: notifyConfig.channels.map((c) => ({ name: c.name, min_severity: c.minSeverity })),
    warning: notifyConfig.channels.length ? undefined : "notify: no channel",
    last_delivery: lastDelivery,
    quiet_hours: notifyConfig.governor.quietHours,
    held: governorState.held.length,
    flood_suppressed: governorState.floodSuppressed,
  }
}

/**
 * Handle an incoming HTTP request for notify routes.
 *
 * Routes:
 *   POST /notify              — main notification endpoint
 *   POST /notify/personality   — compatibility shim (legacy callers)
 *   POST /voice                — legacy alias, kept for existing callers
 *   GET  /notify/health        — notify subsystem health
 *
 * Returns a Response for matched routes, or null if the route is not ours.
 * `voice_enabled`/`voice_id`/`voice_settings` fields in request bodies are
 * accepted but ignored — kept so existing callers don't need updating.
 */
export async function handleNotifyRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url)
  const pathname = url.pathname

  // CORS preflight for any of our routes
  if (req.method === "OPTIONS" && ["/notify", "/notify/personality", "/voice", "/notify/health"].includes(pathname)) {
    return new Response(null, { headers: CORS_HEADERS, status: 204 })
  }

  const clientIp = req.headers.get("x-forwarded-for") || "localhost"

  // GET /notify/health
  if (pathname === "/notify/health" && req.method === "GET") {
    return jsonResponse(notifyHealth(), 200)
  }

  // All remaining routes are POST
  if (req.method !== "POST") return null

  // POST /notify — P0 is never rate-limited
  if (pathname === "/notify") {
    try {
      const data = await req.json()
      if (parseSeverity(data.severity) !== "P0" && !checkRateLimit(clientIp)) {
        return jsonResponse({ status: "error", message: "Rate limit exceeded" }, 429)
      }
      const title = data.title || "PAI Notification"
      const message = data.message || "Task completed"

      const deliveries = await sendNotification(title, message, data)

      return jsonResponse({ status: "success", message: "Notification sent", deliveries }, 200)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log("error", "Notify: notification error", { error: msg })
      return jsonResponse({ status: "error", message: msg }, errorStatus(msg))
    }
  }

  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ status: "error", message: "Rate limit exceeded" }, 429)
  }

  // POST /notify/personality — compatibility shim for legacy callers
  if (pathname === "/notify/personality") {
    try {
      const data = await req.json()
      const message = data.message || "Notification"

      await sendNotification("PAI Notification", message)

      return jsonResponse({ status: "success", message: "Personality notification sent" }, 200)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log("error", "Notify: personality notification error", { error: msg })
      return jsonResponse({ status: "error", message: msg }, errorStatus(msg))
    }
  }

  // POST /voice — legacy alias, kept for existing callers
  if (pathname === "/voice") {
    try {
      const data = await req.json()
      const title = data.title || "PAI Assistant"
      const message = data.message || "Task completed"

      await sendNotification(title, message)

      return jsonResponse({ status: "success", message: "PAI notification sent" }, 200)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log("error", "Notify: PAI notification error", { error: msg })
      return jsonResponse({ status: "error", message: msg }, errorStatus(msg))
    }
  }

  // Not our route
  return null
}
