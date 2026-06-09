#!/usr/bin/env bun
/**
 * SettingsIntegrityCheck.hook.ts — SessionStart integrity guard
 *
 * Detects uncommitted changes to ~/.claude/settings.json at session start.
 * Mitigates the Miasma/Phantom Gyp class of attack: malicious npm postinstall
 * scripts inject SessionStart hooks into settings.json; this surfaces the diff
 * before any work begins so the user can investigate before proceeding.
 *
 * TRIGGER: SessionStart
 * OUTPUT:  console.log warning + diff if uncommitted changes detected; silent otherwise
 * DESIGN:  fail-open always — never block session start
 *
 * Incident response order if injection found:
 *   1. Disconnect from network
 *   2. Remove the injected hook entry
 *   3. Rotate credentials from a clean machine
 */

import { spawnSync } from "child_process";

const HOME = process.env.HOME ?? "";
const CLAUDE_DIR = `${HOME}/.claude`;

function checkSettingsIntegrity(): void {
  const result = spawnSync(
    "git",
    ["-C", CLAUDE_DIR, "diff", "HEAD", "--", "settings.json"],
    { stdio: "pipe", encoding: "utf-8" }
  );

  // git unavailable, not a repo, or clean — nothing to do
  if (result.status !== 0 || !result.stdout?.trim()) return;

  const diff = result.stdout.trim();

  console.log(`<system-reminder>
⚠️  SECURITY: settings.json has uncommitted changes detected at session start.

This may indicate hook injection via a malicious npm package (Miasma/Phantom Gyp campaign).
Check for unrecognized entries under hooks.SessionStart in particular.

If you did NOT make these changes:
  1. Disconnect from network immediately
  2. Do NOT revoke tokens yet — malware may wipe ~/ on revocation
  3. Remove the injected hook entry from ~/.claude/settings.json
  4. Rotate all credentials from a CLEAN machine

Diff:
${diff}
</system-reminder>`);
}

try {
  // Consume stdin (session_id) — required by hook protocol
  try {
    await Bun.stdin.text();
  } catch {
    // stdin unavailable — continue
  }

  checkSettingsIntegrity();
} catch {
  // fail-open — never crash session start
}

process.exit(0);
