/**
 * PAI Pulse — notification channels behind /notify.
 *
 * Portable replacement for the macOS-only osascript path. Each channel decides
 * for itself whether it can deliver on this host; nothing needs a manual flag:
 *   - desktop: macOS (osascript), Linux with a display (notify-send),
 *              WSL (Windows toast via powershell.exe interop). Headless → absent.
 *   - ntfy:    any ntfy server (ntfy.sh or self-hosted) from settings.json
 *              `notifications.ntfy`. Token goes in an Authorization header.
 *
 * Severity picks delivery: P0/P1 push to the phone; P2 stays local (desktop +
 * alerts.jsonl) for the digest. Payloads to a relay not marked `trusted` carry
 * severity, source, id and link only — never the message text.
 */

import { spawn } from "child_process"
import { existsSync, readFileSync } from "fs"

export type Severity = "P0" | "P1" | "P2"
export const SEVERITIES: readonly Severity[] = ["P0", "P1", "P2"]

export interface Alert {
  title: string
  message: string
  severity: Severity
  source?: string
  id?: string
  link?: string
  /** Render the body as Markdown where the channel supports it (trusted ntfy). */
  markdown?: boolean
}

export interface Channel {
  name: string
  /** Lowest-urgency severity this channel delivers (P2 = everything). */
  minSeverity: Severity
  send(alert: Alert): Promise<void>
}

export interface NtfySettings {
  enabled?: boolean
  server?: string
  topic?: string
  /** Name of the env var holding the access token (default NTFY_TOKEN). */
  tokenEnv?: string
  /** true only for a self-hosted or E2E server: full text is allowed. */
  trusted?: boolean
}

export interface NotificationSettings {
  desktop?: { enabled?: boolean }
  ntfy?: NtfySettings
  /** P1 pushes held inside this window. false disables. Default 22:00–07:00, host timezone. */
  quietHours?: { start?: string; end?: string; timeZone?: string } | false
}

type Env = Record<string, string | undefined>

export function parseSeverity(v: unknown): Severity {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v.toUpperCase())
    ? (v.toUpperCase() as Severity)
    : "P2"
}

export function severityReaches(alert: Severity, channelMin: Severity): boolean {
  return SEVERITIES.indexOf(alert) <= SEVERITIES.indexOf(channelMin)
}

/** `${VAR}` placeholders resolve from env; an unresolved placeholder yields "". */
export function expandEnv(value: string | undefined, env: Env): string {
  if (!value) return ""
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => env[k] ?? "")
}

// ── ntfy ──

export const NTFY_PRIORITY: Record<Severity, number> = { P0: 5, P1: 4, P2: 2 }

export interface NtfyMessage {
  title: string
  body: string
  priority: number
  tags: string[]
  click?: string
}

/** What actually leaves the box. Untrusted relays get no message text. */
export function formatForNtfy(alert: Alert, trusted: boolean): NtfyMessage {
  const tags = [alert.severity.toLowerCase(), ...(alert.severity === "P0" ? ["rotating_light"] : [])]
  const label = alert.source ? `${alert.severity} ${alert.source}` : alert.severity
  if (trusted) {
    return { title: `[${label}] ${alert.title}`, body: alert.message.slice(0, 3900), priority: NTFY_PRIORITY[alert.severity], tags, click: alert.link }
  }
  const body = [alert.id ? `id ${alert.id}` : "new alert", "details in Pulse"].join(" · ")
  return { title: `[${label}]`, body, priority: NTFY_PRIORITY[alert.severity], tags, click: alert.link }
}

export function normalizeServer(server: string | undefined): string {
  const s = (server || "ntfy.sh").trim().replace(/\/+$/, "")
  return /^https?:\/\//.test(s) ? s : `https://${s}`
}

export function ntfyChannel(cfg: NtfySettings, env: Env, fetchImpl: typeof fetch = fetch): Channel | null {
  if (cfg.enabled === false) return null
  const topic = expandEnv(cfg.topic, env)
  if (!topic) return null
  const url = `${normalizeServer(expandEnv(cfg.server, env))}/${encodeURIComponent(topic)}`
  const token = env[cfg.tokenEnv || "NTFY_TOKEN"]
  const trusted = cfg.trusted === true
  return {
    name: trusted ? "ntfy" : "ntfy (ids-only)",
    minSeverity: "P1",
    async send(alert) {
      const m = formatForNtfy(alert, trusted)
      const headers: Record<string, string> = { Title: m.title, Priority: String(m.priority), Tags: m.tags.join(",") }
      if (m.click) headers.Click = m.click
      if (trusted && alert.markdown) headers.Markdown = "yes"
      if (token) headers.Authorization = `Bearer ${token}`
      const res = await fetchImpl(url, { method: "POST", headers, body: m.body, signal: AbortSignal.timeout(5_000) })
      if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`)
    },
  }
}

// ── desktop ──

export type DesktopKind = "macos" | "linux-desktop" | "wsl" | "none"

export function detectDesktop(platform: string, env: Env, procVersion: string, hasNotifySend: boolean): DesktopKind {
  if (platform === "darwin") return "macos"
  if (platform !== "linux") return "none"
  if (env.WSL_DISTRO_NAME || /microsoft/i.test(procVersion)) return "wsl"
  if ((env.DISPLAY || env.WAYLAND_DISPLAY) && hasNotifySend) return "linux-desktop"
  return "none"
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "ignore", env })
    const timer = setTimeout(() => { proc.kill("SIGTERM"); reject(new Error(`${cmd} timed out`)) }, 10_000)
    proc.on("error", (e) => { clearTimeout(timer); reject(e) })
    proc.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)) })
  })
}

function escapeForAppleScript(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

// Title and message reach PowerShell through env vars (WSLENV), never the command string.
const WSL_TOAST = [
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$x = $t.GetElementsByTagName('text')",
  "$x.Item(0).AppendChild($t.CreateTextNode($env:PAI_NOTIFY_TITLE)) > $null",
  "$x.Item(1).AppendChild($t.CreateTextNode($env:PAI_NOTIFY_MESSAGE)) > $null",
  "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))",
].join("; ")

export function desktopChannel(kind: DesktopKind): Channel | null {
  if (kind === "none") return null
  return {
    name: `desktop (${kind})`,
    minSeverity: "P2",
    async send(alert) {
      const title = alert.severity === "P2" ? alert.title : `[${alert.severity}] ${alert.title}`
      if (kind === "macos") {
        const script = `display notification "${escapeForAppleScript(alert.message)}" with title "${escapeForAppleScript(title)}" sound name ""`
        return run("/usr/bin/osascript", ["-e", script])
      }
      if (kind === "linux-desktop") {
        const urgency = alert.severity === "P0" ? "critical" : alert.severity === "P1" ? "normal" : "low"
        return run("notify-send", ["-u", urgency, "-a", "PAI", title, alert.message])
      }
      const env = {
        ...process.env,
        PAI_NOTIFY_TITLE: title,
        PAI_NOTIFY_MESSAGE: alert.message,
        WSLENV: [process.env.WSLENV, "PAI_NOTIFY_TITLE/u", "PAI_NOTIFY_MESSAGE/u"].filter(Boolean).join(":"),
      }
      return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WSL_TOAST], env)
    },
  }
}

// ── assembly ──

export function loadNotificationSettings(): NotificationSettings {
  const path = `${process.env.HOME ?? "~"}/.claude/settings.json`
  return JSON.parse(readFileSync(path, "utf-8")).notifications ?? {}
}

export function buildChannels(settings: NotificationSettings, env: Env, desktop: DesktopKind): Channel[] {
  const out: Channel[] = []
  if (settings.desktop?.enabled !== false) {
    const d = desktopChannel(desktop)
    if (d) out.push(d)
  }
  const n = settings.ntfy ? ntfyChannel(settings.ntfy, env) : null
  if (n) out.push(n)
  return out
}

export function detectHostDesktop(): DesktopKind {
  let procVersion = ""
  try { procVersion = existsSync("/proc/version") ? readFileSync("/proc/version", "utf-8") : "" } catch {}
  return detectDesktop(process.platform, process.env, procVersion, Bun.which("notify-send") !== null)
}

export interface Delivery {
  channel: string
  outcome: "sent" | "failed" | "below-threshold"
  error?: string
}

/** Sends to every channel the severity reaches. Never throws. */
export async function dispatch(alert: Alert, channels: Channel[]): Promise<Delivery[]> {
  return Promise.all(
    channels.map(async (c): Promise<Delivery> => {
      if (!severityReaches(alert.severity, c.minSeverity)) return { channel: c.name, outcome: "below-threshold" }
      try {
        await c.send(alert)
        return { channel: c.name, outcome: "sent" }
      } catch (e) {
        return { channel: c.name, outcome: "failed", error: e instanceof Error ? e.message : String(e) }
      }
    }),
  )
}
