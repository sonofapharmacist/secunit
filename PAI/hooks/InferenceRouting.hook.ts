#!/usr/bin/env bun
/**
 * ============================================================================
 * InferenceRouting.hook.ts — P5: PreToolUse enforcement for local inference
 * ============================================================================
 *
 * PURPOSE:
 * Enforce local-first inference routing when tier:fast or tier:standard is set.
 * Scale timeouts per tier (fast=45s, standard=90s) so llama-server has time.
 * Log timeout extensions to observability.
 *
 * BEHAVIOR:
 * - Detects bun Inference.ts calls via stdin
 * - Reads --tier or infers from --level argument
 * - Injects --prefer-local when tier is fast/standard (unless --backend claude explicit)
 * - Sets --timeout to tier-appropriate value
 * - Appends observability record with timeout_extended, reason, and latency info
 *
 * WIRING:
 * settings.json, PreToolUse, Bash matcher
 *
 * ============================================================================
 */

import { appendFileSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const OBSERVABILITY_DIR = join(HOME, ".claude", "PAI", "MEMORY", "OBSERVABILITY");
const INFERENCE_LOG = join(OBSERVABILITY_DIR, "inference-calls.jsonl");

interface InferenceRouting {
  command: string;
  originalArgs: string[];
  tier?: string;
  backend?: string;
  timeout?: number;
  timeoutExtended?: boolean;
  extensionReason?: string;
}

function parseInferenceCommand(command: string): InferenceRouting {
  const parts = command.split(/\s+/);
  const result: InferenceRouting = {
    command,
    originalArgs: parts,
  };

  // Check if this is an Inference.ts call
  if (!parts.some((p) => p.includes("Inference.ts"))) {
    return result;
  }

  // Extract tier from --tier or infer from --level
  const tierIdx = parts.indexOf("--tier");
  if (tierIdx !== -1 && tierIdx + 1 < parts.length) {
    result.tier = parts[tierIdx + 1];
  }

  const levelIdx = parts.indexOf("--level");
  if (levelIdx !== -1 && levelIdx + 1 < parts.length) {
    const level = parts[levelIdx + 1];
    // Map level to tier: fast→fast, standard→standard, smart→smart
    result.tier = level;
  }

  // Extract backend
  const backendIdx = parts.indexOf("--backend");
  if (backendIdx !== -1 && backendIdx + 1 < parts.length) {
    result.backend = parts[backendIdx + 1];
  }

  // Extract timeout
  const timeoutIdx = parts.indexOf("--timeout");
  if (timeoutIdx !== -1 && timeoutIdx + 1 < parts.length) {
    result.timeout = parseInt(parts[timeoutIdx + 1], 10);
  }

  return result;
}

function enforceRouting(routing: InferenceRouting): string {
  if (!routing.tier || !routing.command.includes("Inference.ts")) {
    return routing.command;
  }

  const tier = routing.tier.toLowerCase();
  let modifiedCommand = routing.command;
  let timeoutMs = 15000; // Default for cloud
  let timeoutExtended = false;
  let extensionReason = "";

  // Determine target backend and timeout based on tier
  // --backend ollama bypasses fallback_models and uses defaultModel directly — wrong.
  // --prefer-local routes through _inferenceCore which uses fallback_models for correct
  // per-tier model selection (fast→qwen3:14b→host1, smart→qwen3:30b→host2).
  const useLocal = (tier === "fast" || tier === "standard") && routing.backend !== "claude";

  if (useLocal) {
    // Inject --prefer-local if neither --prefer-local nor --backend is already present
    if (!modifiedCommand.includes("--prefer-local") && !modifiedCommand.includes("--backend")) {
      modifiedCommand += " --prefer-local";
    }
  }

  // Only extend timeout for local tiers
  if (useLocal) {
    if (tier === "fast") {
      timeoutMs = 45000;
      timeoutExtended = true;
      extensionReason = "tier=fast with local inference (llama-server)";
    } else if (tier === "standard") {
      timeoutMs = 90000;
      timeoutExtended = true;
      extensionReason = "tier=standard with local inference (llama-server)";
    }
  }

  // Set timeout if extending
  if (timeoutExtended) {
    // Remove existing --timeout if present
    modifiedCommand = modifiedCommand.replace(/\s+--timeout\s+\d+/g, "");
    // Add new timeout
    modifiedCommand += ` --timeout ${timeoutMs}`;
  }

  // Log to observability (non-blocking)
  if (timeoutExtended) {
    try {
      const record = {
        timestamp: new Date().toISOString(),
        hook: "InferenceRouting",
        phase: "PreToolUse",
        tier,
        timeout_extended: true,
        original_timeout: routing.timeout || 15000,
        new_timeout: timeoutMs,
        reason: extensionReason,
        backend_enforced: tier === "fast" || tier === "standard" ? "prefer-local" : undefined,
      };
      appendFileSync(INFERENCE_LOG, JSON.stringify(record) + "\n", "utf-8");
    } catch (e) {
      // Silently fail observability logging to avoid blocking the command
      console.error(`[InferenceRouting] Observability append failed: ${e}`);
    }
  }

  return modifiedCommand;
}

// Read stdin (PreToolUse JSON from Claude Code)
let input = "";
process.stdin.setEncoding("utf-8");

process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(input.trim()) as {
      tool_input?: { command?: string; [k: string]: unknown };
      [k: string]: unknown;
    };
    const command = parsed?.tool_input?.command;

    if (!command) {
      process.exit(0);
      return;
    }

    const routing = parseInferenceCommand(command);
    const enforced = enforceRouting(routing);

    if (enforced !== command) {
      // Emit hookSpecificOutput with updatedInput so Claude Code applies the rewrite
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { ...parsed.tool_input, command: enforced },
        },
      }));
    }
    // No change → output nothing → Claude Code treats as allow
  } catch (e) {
    // Parse error or unexpected format — allow through, don't block
    console.error(`[InferenceRouting] Hook error: ${e}`);
  }

  process.exit(0);
});

// Timeout safety — exit 0 (allow) if stdin never closes
setTimeout(() => {
  process.exit(0);
}, 5000);
