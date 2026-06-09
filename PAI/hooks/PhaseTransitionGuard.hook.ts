#!/usr/bin/env bun
/**
 * ============================================================================
 * PhaseTransitionGuard.hook.ts — Enforce sequential ISA phase ordering
 * ============================================================================
 *
 * PURPOSE:
 * Block illegal phase transitions in PAI Algorithm ISA.md files. The
 * Algorithm must walk its phases in order:
 *
 *   observe → think → plan → build → execute → verify → learn
 *
 * Skipping a phase forward (e.g. observe → plan) is illegal — it bypasses
 * the work the skipped phase is supposed to do. This hook is the runtime
 * enforcement of that ordering invariant. It is stateless: it compares the
 * current on-disk ISA phase against the proposed Edit/Write content and
 * blocks the tool call when the delta jumps more than one step forward.
 *
 * BEHAVIOR:
 * - Triggered on PreToolUse for Edit and Write
 * - No-op for any file path that does not end with `/ISA.md`
 * - No-op if the proposed content has no `phase:` line (not a phase change)
 * - No-op if the current on-disk file is missing or unreadable (fail-open)
 * - No-op if either current or proposed phase is unrecognized (fail-open)
 * - No-op if proposed phase equals current phase (no-op edit)
 * - No-op if proposed phase is `complete` (always legal to close an ISA)
 * - No-op for backward transitions and single-step forward transitions
 * - BLOCKS (exit 2) when toIdx > fromIdx + 1 (forward skip of >=1 phase)
 *
 * NON-GOALS:
 * - Does NOT read sentinel files (that is ObserveGate's job)
 * - Does NOT gate MultiEdit (only Edit and Write are wired)
 * - Does NOT mutate any files
 * - Does NOT call any LLMs; fully synchronous
 *
 * WIRING:
 * settings.json → hooks.PreToolUse → matchers: ["Edit", "Write"]
 *   command: bun ${PAI_DIR}/hooks/PhaseTransitionGuard.hook.ts
 *
 * FAIL-OPEN PHILOSOPHY:
 * Any error path (malformed stdin, unreadable file, unknown phase name,
 * missing `phase:` line) results in `allow()`. The hook only blocks when
 * it can prove an illegal forward jump is happening.
 *
 * ============================================================================
 */

import { readFileSync, existsSync } from "fs";

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

// ----- Constants ------------------------------------------------------------

const PHASE_ORDER: string[] = [
  "observe",
  "think",
  "plan",
  "build",
  "execute",
  "verify",
  "learn",
];

const PHASE_RE = /^phase:\s*(\S+)/m;

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

function extractPhase(content: string): string | null {
  const match = content.match(PHASE_RE);
  if (!match) return null;
  return match[1].trim().toLowerCase();
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

  // Only gate ISA.md files.
  if (!filePath.endsWith("/ISA.md")) {
    allow();
  }

  // Pick the proposed new content depending on tool.
  let newContent = "";
  if (toolName === "Edit") {
    newContent = toolInput.new_string ?? "";
  } else if (toolName === "Write") {
    newContent = toolInput.content ?? "";
  }

  // If the proposed content has no `phase:` line, this is not a
  // phase-change edit — allow.
  const proposedPhase = extractPhase(newContent);
  if (proposedPhase === null) {
    allow();
  }

  // Load the current on-disk ISA. Missing file → not a transition; allow.
  const currentContent = readFileOrNull(filePath);
  if (currentContent === null) {
    allow();
  }

  const currentPhase = extractPhase(currentContent);
  if (currentPhase === null) {
    allow();
  }

  // Same-phase edit (e.g. updating ISCs while still in `think`) → allow.
  if (proposedPhase === currentPhase) {
    allow();
  }

  // Closing out an ISA is always legal regardless of where we were.
  if (proposedPhase === "complete") {
    allow();
  }

  const fromIdx = PHASE_ORDER.indexOf(currentPhase);
  const toIdx = PHASE_ORDER.indexOf(proposedPhase);

  // Unknown phase name on either side → fail open. We refuse to be the
  // authority on phase names we have not been taught.
  if (fromIdx === -1 || toIdx === -1) {
    allow();
  }

  // Forward skip of one or more phases is the only illegal case.
  // - Backward (toIdx < fromIdx): allow (re-opening a phase).
  // - Adjacent forward (toIdx === fromIdx + 1): allow (normal progression).
  // - Forward skip (toIdx > fromIdx + 1): BLOCK.
  if (toIdx > fromIdx + 1) {
    const skipped = PHASE_ORDER[fromIdx + 1];
    block(
      `[PhaseTransitionGuard] 🚫 Illegal phase transition: ${currentPhase} → ${proposedPhase}\n` +
        `  Skipped phase: ${skipped}\n` +
        `  Algorithm phases must run in sequence: observe → think → plan → build → execute → verify → learn\n` +
        `  If you need to skip a phase, update the ISA phase manually after confirming with GP.`
    );
  }

  allow();
}

main();
