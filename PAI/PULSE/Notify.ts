/**
 * PAI Pulse — Notify Module
 *
 * Desktop notifications (macOS), input sanitization, rate limiting.
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

import { spawn } from "child_process"
import { readFileSync } from "fs"
import { log } from "./lib"

// ── Public Config Interface ──

export interface NotifyConfig {
  enabled: boolean
}

// ── Internal Types ──

interface LoadedNotifyConfig {
  desktopNotifications: boolean
}

// ── Module State ──

let moduleConfig: NotifyConfig = { enabled: false }
let notifyConfig: LoadedNotifyConfig = { desktopNotifications: true }
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

function loadNotifyConfigFromSettings(): LoadedNotifyConfig {
  const settingsPath = `${process.env.HOME ?? "~"}/.claude/settings.json`

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
    const desktopNotifications = settings.notifications?.desktop?.enabled !== false
    return { desktopNotifications }
  } catch {
    return { desktopNotifications: true }
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

// ── AppleScript Escaping ──

function escapeForAppleScript(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

// ── macOS Desktop Notification ──

async function showDesktopNotification(title: string, message: string): Promise<void> {
  if (!notifyConfig.desktopNotifications) return
  if (process.platform !== "darwin") return

  try {
    const escapedTitle = escapeForAppleScript(title)
    const escapedMessage = escapeForAppleScript(message)
    const script = `display notification "${escapedMessage}" with title "${escapedTitle}" sound name ""`

    await new Promise<void>((resolve, reject) => {
      const proc = spawn("/usr/bin/osascript", ["-e", script])
      proc.on("error", reject)
      proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`osascript exited ${code}`))))
    })
  } catch (error) {
    log("error", "Notify: notification display error", { error: String(error) })
  }
}

// ── Core: Send Notification ──

async function sendNotification(title: string, message: string): Promise<void> {
  const titleValidation = validateInput(title)
  const messageValidation = validateInput(message)

  if (!titleValidation.valid) throw new Error(`Invalid title: ${titleValidation.error}`)
  if (!messageValidation.valid) throw new Error(`Invalid message: ${messageValidation.error}`)

  const safeTitle = titleValidation.sanitized!
  const safeMessage = messageValidation.sanitized!

  await showDesktopNotification(safeTitle, safeMessage)
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
  initialized = true
  log("info", "Notify module: initialized", {
    desktopNotifications: notifyConfig.desktopNotifications,
  })
}

/**
 * Health check for the notify subsystem.
 */
export function notifyHealth(): Record<string, unknown> {
  return {
    initialized,
    enabled: moduleConfig.enabled,
    desktop_notifications: notifyConfig.desktopNotifications,
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

  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ status: "error", message: "Rate limit exceeded" }, 429)
  }

  // POST /notify
  if (pathname === "/notify") {
    try {
      const data = await req.json()
      const title = data.title || "PAI Notification"
      const message = data.message || "Task completed"

      await sendNotification(title, message)

      return jsonResponse({ status: "success", message: "Notification sent" }, 200)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      log("error", "Notify: notification error", { error: msg })
      return jsonResponse({ status: "error", message: msg }, errorStatus(msg))
    }
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
