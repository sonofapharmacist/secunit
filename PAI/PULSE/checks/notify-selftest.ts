#!/usr/bin/env bun
/**
 * Daily delivery self-test — script-type Pulse job (alerting ISA ISC-28).
 *
 * "Silence must be visible": /notify was a void on Linux for 15 weeks because
 * nothing checked delivery. Each day this proves every hop it can:
 *   1. Pulse /notify/health reports at least one channel.
 *   2. Primary ntfy: publish a nonce at priority 1 to the self-test topic and read it back.
 *   3. Backup relay (ntfy.sh, ids-only): same round trip at priority 1 (min: no sound, no banner).
 * On any failure: P1 through whichever path still works. The backup only ever carries
 * "notify-selftest failed" and an id, never text.
 *
 * Env: NTFY_TOKEN, NTFY_SELFTEST_TOPIC (default pai-selftest), NTFY_BACKUP_TOPIC.
 * Primary server comes from settings.json notifications.ntfy.server.
 */

import { loadNotificationSettings, normalizeServer, expandEnv, ntfyChannel } from "../NotifyChannels"

export interface Check { name: string; ok: boolean; detail?: string }

export async function roundTrip(server: string, topic: string, token: string | undefined, fetchImpl: typeof fetch = fetch, retryMs = 2_000): Promise<Check> {
  const nonce = `selftest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
  const url = `${normalizeServer(server)}/${encodeURIComponent(topic)}`
  try {
    const pub = await fetchImpl(url, { method: "POST", headers: { ...auth, Priority: "1", Tags: "white_check_mark" }, body: nonce, signal: AbortSignal.timeout(10_000) })
    if (!pub.ok) return { name: topic, ok: false, detail: `publish HTTP ${pub.status}` }
    // ntfy.sh is eventually consistent: a read right after publish can miss it.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, retryMs))
      const got = await fetchImpl(`${url}/json?poll=1&since=5m`, { headers: auth, signal: AbortSignal.timeout(10_000) })
      if (!got.ok) return { name: topic, ok: false, detail: `read HTTP ${got.status}` }
      if ((await got.text()).includes(nonce)) return { name: topic, ok: true }
    }
    return { name: topic, ok: false, detail: "published but not read back after 3 reads" }
  } catch (e) {
    return { name: topic, ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

if (import.meta.main) {
  const checks: Check[] = []

  try {
    const h = (await (await fetch("http://localhost:31337/notify/health", { signal: AbortSignal.timeout(5_000) })).json()) as { channels?: unknown[]; warning?: string }
    checks.push({ name: "pulse-notify", ok: (h.channels?.length ?? 0) > 0 && !h.warning, detail: h.warning })
  } catch (e) {
    checks.push({ name: "pulse-notify", ok: false, detail: e instanceof Error ? e.message : String(e) })
  }

  const primary = loadNotificationSettings().ntfy
  if (primary && primary.enabled !== false) {
    checks.push({ ...(await roundTrip(expandEnv(primary.server, process.env), process.env.NTFY_SELFTEST_TOPIC || "pai-selftest", process.env.NTFY_TOKEN)), name: "ntfy-primary" })
  }
  const backupTopic = process.env.NTFY_BACKUP_TOPIC
  if (backupTopic) checks.push({ ...(await roundTrip("ntfy.sh", backupTopic, undefined)), name: "ntfy-backup" })

  const failed = checks.filter((c) => !c.ok)
  if (failed.length === 0) {
    console.log("NO_ACTION")
    process.exit(0)
  }

  const summary = failed.map((c) => `${c.name}: ${c.detail ?? "failed"}`).join("; ")
  // Primary path first (full text, through the governor); then the backup, ids-only.
  try {
    await fetch("http://localhost:31337/notify", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Notification self-test failed", message: summary, severity: "P1", source: "notify-selftest", id: "selftest" }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch { /* Pulse down is one of the things being reported */ }
  if (backupTopic && !failed.some((c) => c.name === "ntfy-backup")) {
    const backup = ntfyChannel({ server: "ntfy.sh", topic: backupTopic, trusted: false }, {})
    await backup?.send({ title: "x", message: "x", severity: "P1", source: "notify-selftest", id: "selftest-failed" }).catch(() => {})
  }
  console.log(`SELFTEST FAILED: ${summary}`)
}
