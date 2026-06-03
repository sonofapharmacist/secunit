#!/usr/bin/env bun
/**
 * ============================================================================
 * ObserveGate.hook.ts — Block premature OBSERVE→THINK phase transition
 * ============================================================================
 *
 * PURPOSE:
 * Enforce the OBSERVE COMPLETION TOKEN doctrine at E2+. Before the Algorithm
 * is allowed to flip an ISA from `phase: observe` to `phase: think`, the
 * working directory MUST contain a `.observe-gate.json` sentinel asserting:
 *   1. ISA Skill was invoked (Skill("ISA", ...) scaffolded the artifact)
 *   2. REVERSE ENGINEERING block was produced
 *   3. PREFLIGHT block was produced
 *   4. capabilities.md was loaded before capability selection
 *
 * If the sentinel is missing or any flag is false, the Edit/Write is blocked
 * with exit code 2 and a remediation message pointing back to v7.0.0.md.
 * E1 (and the legacy "standard" tier) are exempt — the gate auto-passes.
 *
 * BEHAVIOR:
 * - Triggered on PreToolUse for Edit and Write
 * - No-op for any file that is not (slash)ISA.md
 * - No-op unless the proposed new content contains `phase: think`
 * - No-op unless the current on-disk ISA contains `phase: observe`
 *   (i.e. only the observe→think transition is gated)
 * - No-op when ISA frontmatter `effort:` is E1 or "standard"
 * - Reads `${dirname(ISA.md)}/.observe-gate.json` and validates 4 booleans
 * - Any failure → console.error(message) + process.exit(2)
 * - All success paths → process.exit(0)
 * - Fully synchronous; no async/await; zero LLM calls
 *
 * SENTINEL SCHEMA:
 * interface ObserveGateSentinel {
 *   isa_path: string;
 *   isa_skill_invoked: boolean;
 *   reverse_engineering: boolean;
 *   preflight: boolean;
 *   capabilities_loaded: boolean;
 *   tier: string;
 *   timestamp: string;
 * }
 *
 * WIRING:
 * settings.json → hooks.PreToolUse → matchers: ["Edit", "Write"]
 *   command: bun ${PAI_DIR}/hooks/ObserveGate.hook.ts
 *
 * ============================================================================
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";

// ----- Types ----------------------------------------------------------------

interface ToolInput {
  file_path?: string;
  // Edit
  old_string?: string;
  new_string?: string;
  // Write
  content?: string;
}

interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: ToolInput;
}

interface ObserveGateSentinel {
  isa_path?: string;
  isa_skill_invoked?: boolean;
  reverse_engineering?: boolean;
  preflight?: boolean;
  capabilities_loaded?: boolean;
  tier?: string;
  timestamp?: string;
}

// ----- Helpers --------------------------------------------------------------

function allow(): never {
  process.exit(0);
}

function block(message: string): never {
  console.error(message);
  process.exit(2);
}

function readStdin(): HookInput {
  try {
    const raw = readFileSync(0, "utf-8");
    if (!raw || raw.trim().length === 0) return {};
    return JSON.parse(raw) as HookInput;
  } catch {
    // Malformed input → do not block tool execution; fail open.
    return {};
  }
}

function readFileOrNull(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Extract the value of the first `effort:` line from ISA frontmatter.
 * Returns the trimmed value (e.g. "E2", "e1", "standard"), or null if absent.
 */
function parseEffort(fileContent: string): string | null {
  const lines = fileContent.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^effort:\s*(.+)$/);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

function isExemptEffort(effort: string | null): boolean {
  if (!effort) return false;
  const normalized = effort.toLowerCase().replace(/^["']|["']$/g, "").trim();
  return normalized === "e1" || normalized === "standard";
}

// ----- Main -----------------------------------------------------------------

function main(): void {
  const input = readStdin();
  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};

  // Only Edit and Write are wired, but be defensive.
  if (toolName !== "Edit" && toolName !== "Write") {
    allow();
  }

  const filePath = toolInput.file_path;
  if (!filePath || typeof filePath !== "string") {
    allow();
  }

  // Step 3: only gate ISA.md files.
  if (!filePath.endsWith("/ISA.md")) {
    allow();
  }

  // Step 4: pick the proposed new content depending on tool.
  let newContent = "";
  if (toolName === "Edit") {
    newContent = toolInput.new_string ?? "";
  } else if (toolName === "Write") {
    newContent = toolInput.content ?? "";
  }

  // Step 5: only gate transitions whose new content sets phase: think.
  if (!newContent.includes("phase: think")) {
    allow();
  }

  // Step 6-7: only gate when the current on-disk file is still phase: observe.
  const currentContent = readFileOrNull(filePath);
  if (currentContent === null) {
    // ISA does not exist yet on disk — not an observe→think transition.
    allow();
  }
  if (!currentContent.includes("phase: observe")) {
    allow();
  }

  // Step 8-9: parse effort; E1/standard are exempt.
  const effort = parseEffort(currentContent);
  if (isExemptEffort(effort)) {
    allow();
  }

  // Step 10-11: load the sentinel from the ISA's directory.
  const workDir = dirname(filePath);
  const sentinelPath = join(workDir, ".observe-gate.json");
  const sentinelRaw = readFileOrNull(sentinelPath);

  // Step 12: sentinel missing → block.
  if (sentinelRaw === null) {
    block(
      "[ObserveGate] 🚫 OBSERVE gate: .observe-gate.json sentinel missing.\n" +
        "Write the sentinel before transitioning to THINK. See Algorithm v7.0.0.md → OBSERVE COMPLETION TOKEN."
    );
  }

  // Step 13: parse sentinel JSON; parse failure → treat as missing → block.
  let sentinel: ObserveGateSentinel;
  try {
    sentinel = JSON.parse(sentinelRaw) as ObserveGateSentinel;
  } catch {
    block(
      "[ObserveGate] 🚫 OBSERVE gate: .observe-gate.json sentinel missing.\n" +
        "Write the sentinel before transitioning to THINK. See Algorithm v7.0.0.md → OBSERVE COMPLETION TOKEN."
    );
  }

  // Step 14: check flags in defined order; block on first false.
  if (sentinel.isa_skill_invoked !== true) {
    block(
      "[ObserveGate] 🚫 ISA Skill not invoked — cannot transition to THINK.\n" +
        'Invoke Skill("ISA", "scaffold from prompt at tier T") first.'
    );
  }

  if (sentinel.reverse_engineering !== true) {
    block(
      "[ObserveGate] 🚫 REVERSE ENGINEERING block missing — cannot transition to THINK.\n" +
        "Produce the 🔎 REVERSE ENGINEERING block in your response."
    );
  }

  if (sentinel.preflight !== true) {
    block(
      "[ObserveGate] 🚫 PREFLIGHT block missing — cannot transition to THINK.\n" +
        "Produce the 🚦 PREFLIGHT block in your response."
    );
  }

  if (sentinel.capabilities_loaded !== true) {
    block(
      "[ObserveGate] 🚫 capabilities.md not loaded — cannot transition to THINK.\n" +
        "Load PAI/ALGORITHM/capabilities.md before selecting capabilities."
    );
  }

  // Step 15: all flags true → allow.
  allow();
}

main();
