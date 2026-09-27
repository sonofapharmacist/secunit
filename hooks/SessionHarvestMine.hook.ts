#!/usr/bin/env bun
/**
 * SessionHarvestMine.hook.ts - Auto-mine session transcripts at SessionEnd
 *
 * PURPOSE:
 * Runs SessionHarvester --mine on substantial sessions so decisions, preferences,
 * milestones, and problems are captured without manual intervention.
 * Candidates land in MEMORY/KNOWLEDGE/_harvest-queue/ for review.
 *
 * TRIGGER: SessionEnd
 *
 * SIGNIFICANCE GATE:
 * Only runs if the session has >= MIN_USER_TURNS user messages.
 * Short Q&A sessions (< 10 user turns) are skipped to avoid noise.
 *
 * INTER-HOOK RELATIONSHIPS:
 * - RUNS AFTER: WorkCompletionLearning (both SessionEnd, independent)
 * - OUTPUT: MEMORY/KNOWLEDGE/_harvest-queue/ (review via KnowledgeHarvester)
 */

import * as fs from "fs";
import * as path from "path";

const MIN_USER_TURNS = 10;
const HOME = process.env.HOME!;
const CLAUDE_DIR = path.join(HOME, ".claude");
const PAI_TOOLS = path.join(CLAUDE_DIR, "PAI", "TOOLS");

// Project dirs derived from HOME — works for any username.
// Claude Code names project dirs by replacing / with - in the working path.
const homeHash = HOME.replace(/\//g, "-"); // /home/alice → -home-alice
const PROJECT_DIRS = [
  path.join(CLAUDE_DIR, "projects", homeHash),
  path.join(CLAUDE_DIR, "projects", `${homeHash}--claude`),
];

function findSessionFile(sessionId: string): string | null {
  for (const dir of PROJECT_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const candidate = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function countUserTurns(filePath: string): number {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());
  let count = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user") count++;
    } catch { /* skip malformed */ }
  }
  return count;
}

async function main() {
  let sessionId: string | undefined;
  try {
    const input = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    if (input?.trim()) {
      const parsed = JSON.parse(input);
      sessionId = parsed.session_id;
    }
  } catch { /* timeout or parse error — proceed without */ }

  if (!sessionId) {
    console.error("[SessionHarvestMine] No session_id in hook input");
    process.exit(0);
  }

  const sessionFile = findSessionFile(sessionId);
  if (!sessionFile) {
    console.error(`[SessionHarvestMine] Session file not found for ${sessionId.slice(0, 8)}`);
    process.exit(0);
  }

  const turns = countUserTurns(sessionFile);
  if (turns < MIN_USER_TURNS) {
    console.error(`[SessionHarvestMine] Skipping: only ${turns} user turns (threshold: ${MIN_USER_TURNS})`);
    process.exit(0);
  }

  console.error(`[SessionHarvestMine] ${turns} user turns — mining session ${sessionId.slice(0, 8)}...`);

  const harvesterPath = path.join(PAI_TOOLS, "SessionHarvester.ts");
  const proc = Bun.spawn(["bun", harvesterPath, "--mine", "--file", sessionFile], {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  await proc.exited;

  process.exit(0);
}

main();
