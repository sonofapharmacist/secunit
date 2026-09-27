#!/usr/bin/env bun
/**
 * SkillTriggerTracker.hook.ts — PostToolUse: log Skill invocations to JSONL
 *
 * TRIGGER: PostToolUse (matcher: Skill)
 * WRITES:  MEMORY/OBSERVABILITY/skill-triggers.jsonl
 */

import { appendFileSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || "";
const LOG = join(HOME, ".claude", "PAI", "MEMORY", "OBSERVABILITY", "skill-triggers.jsonl");

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: { skill?: string; args?: string; [key: string]: unknown };
}

function main(): void {
  let input: HookInput;
  try {
    const raw = require("fs").readFileSync("/dev/stdin", "utf-8");
    if (!raw.trim()) return;
    input = JSON.parse(raw) as HookInput;
  } catch {
    return;
  }

  const skill = input?.tool_input?.skill;
  if (!skill) return;

  const record = {
    timestamp: new Date().toISOString(),
    session_id: input.session_id ?? null,
    skill,
    args: input.tool_input?.args ?? null,
  };

  try {
    appendFileSync(LOG, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // fail-open — never block the skill call
  }
}

main();
