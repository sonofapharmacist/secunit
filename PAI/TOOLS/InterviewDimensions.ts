#!/usr/bin/env bun

/**
 * InterviewDimensions.ts - Collect STATE dimension ratings and persist to PAI_STATE.json
 *
 * PURPOSE:
 * Interactive CLI that collects user ratings (1-10) for each STATE dimension
 * (HEALTH, CREATIVE, FREEDOM, RELATIONS, FIN) and writes them to PAI_STATE.json
 * with timestamp and session_id. Ensures the Life Dashboard can display current status.
 *
 * USAGE:
 *   bun PAI/TOOLS/InterviewDimensions.ts                    # Interactive prompt
 *   bun PAI/TOOLS/InterviewDimensions.ts --session SESSION_ID --json
 *   bun PAI/TOOLS/InterviewDimensions.ts --silent --health 8 --creative 7 ...
 *
 * INPUT:
 *   - Interactive: stdin prompts
 *   - Args: --health N --creative N --freedom N --relations N --fin N
 *   - Env: SESSION_ID (optional, defaults to timestamp)
 *
 * OUTPUT:
 *   - stdout: JSON summary or confirmation message
 *   - Writes: PAI_STATE.json updated with dimension scores
 *   - stderr: Errors and debug info
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || "";
const PAI_DIR = join(HOME, ".claude", "PAI");
const STATE_FILE = join(PAI_DIR, "USER", "TELOS", "PAI_STATE.json");
const DIMENSIONS = ["HEALTH", "CREATIVE", "FREEDOM", "RELATIONS", "FIN"] as const;

// ── Types ──

interface DimensionScore {
  value: number | null;
  session_id: string;
  timestamp: string;
}

interface PAIState {
  dimensions: Record<string, DimensionScore>;
  history: Array<{
    timestamp: string;
    session_id: string;
    scores: Record<string, number>;
  }>;
}

// ── Utility Functions ──

function getISOTimestamp(): string {
  return new Date().toISOString();
}

function createDimensionScore(value: number | null, sessionId: string): DimensionScore {
  return {
    value,
    session_id: sessionId,
    timestamp: getISOTimestamp(),
  };
}

function validateInput(value: string): number | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "skip" || trimmed === "decline") return null;

  const num = parseInt(trimmed, 10);
  if (isNaN(num) || num < 1 || num > 10) {
    throw new Error(`Invalid input. Please enter a number 1-10, or "skip" to decline.`);
  }
  return num;
}

function ensureStateFileExists(): PAIState {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    } catch {
      console.error(`[InterviewDimensions] Could not parse ${STATE_FILE}, creating fresh.`);
    }
  }

  // Create fresh state
  const fresh: PAIState = {
    dimensions: {
      HEALTH: createDimensionScore(null, ""),
      CREATIVE: createDimensionScore(null, ""),
      FREEDOM: createDimensionScore(null, ""),
      RELATIONS: createDimensionScore(null, ""),
      FIN: createDimensionScore(null, ""),
    },
    history: [],
  };

  // Ensure directory exists
  mkdirSync(join(PAI_DIR, "USER", "TELOS"), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(fresh, null, 2));
  return fresh;
}

function persistScores(scores: Record<string, number | null>, sessionId: string): void {
  const state = ensureStateFileExists();
  const timestamp = getISOTimestamp();

  // Update dimension values
  for (const dim of DIMENSIONS) {
    const value = scores[dim];
    state.dimensions[dim] = createDimensionScore(value ?? null, sessionId);
  }

  // Add to history (only if at least one score was provided)
  const providedScores = Object.entries(scores).filter(([_, v]) => v !== null);
  if (providedScores.length > 0) {
    const historyEntry = {
      timestamp,
      session_id: sessionId,
      scores: Object.fromEntries(providedScores),
    };
    state.history.push(historyEntry);
  }

  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`[InterviewDimensions] Scores persisted to ${STATE_FILE}`);
}

// ── Interactive Mode ──

async function interactiveMode(sessionId: string): Promise<void> {
  const scores: Record<string, number | null> = {};
  const prompts: Record<string, string> = {
    HEALTH: "How are you on HEALTH? (1-10, or skip): ",
    CREATIVE: "How are you on CREATIVE? (1-10, or skip): ",
    FREEDOM: "How are you on FREEDOM? (1-10, or skip): ",
    RELATIONS: "How are you on RELATIONS? (1-10, or skip): ",
    FIN: "How are you on FINANCIAL health? (1-10, or skip): ",
  };

  console.log("\n━━━ Dimension Ratings ━━━");
  console.log("Rate each dimension 1-10, or type 'skip' to decline.\n");

  for (const dim of DIMENSIONS) {
    let valid = false;
    while (!valid) {
      process.stdout.write(prompts[dim]);
      const input = await getUserInput();
      try {
        scores[dim] = validateInput(input);
        valid = true;
      } catch (e) {
        console.error(`  ✗ ${(e as Error).message}`);
      }
    }
  }

  persistScores(scores, sessionId);
  console.log("\n✓ Ratings saved. Dashboard will update on next load.\n");
}

// ── Argument Parsing ──

function parseArguments(): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = process.argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function getUserInput(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.once("data", (data) => {
      resolve(data.toString().trim());
    });
  });
}

// ── Main ──

async function main() {
  const args = parseArguments();
  const sessionId = (args.session as string) || process.env.SESSION_ID || `dimension-${Date.now()}`;

  // Silent mode (command-line args)
  if (args.health || args.creative || args.freedom || args.relations || args.fin) {
    const scores: Record<string, number | null> = {};
    for (const dim of DIMENSIONS) {
      const key = dim.toLowerCase();
      if (args[key]) {
        try {
          scores[dim] = validateInput(args[key] as string);
        } catch (e) {
          console.error(`[InterviewDimensions] ${key}: ${(e as Error).message}`);
          process.exit(1);
        }
      } else {
        scores[dim] = null;
      }
    }
    persistScores(scores, sessionId);
    if (args.json) {
      console.log(JSON.stringify({ session_id: sessionId, scores }, null, 2));
    }
    process.exit(0);
  }

  // Interactive mode
  try {
    await interactiveMode(sessionId);
  } catch (e) {
    console.error(`[InterviewDimensions] Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();
