#!/usr/bin/env bun
/**
 * BudgetWarning.hook.ts — UserPromptSubmit: inject context when 5h window is high
 *
 * Reads statusline's usage cache. Injects additionalContext at WARN_THRESHOLD%.
 * Fail-open always — cache may not exist or be stale.
 */

import { readFileSync } from "fs";

const USER = process.env.USER || process.env.LOGNAME || "anon";
const USAGE_CACHE = `/tmp/pai-usage-${USER}.json`;
const WARN_THRESHOLD = 80;

function main(): void {
  try {
    const data = JSON.parse(readFileSync(USAGE_CACHE, "utf-8"));
    const utilization = data?.five_hour?.utilization;
    if (typeof utilization !== "number") return;

    const pct = Math.round(utilization);
    if (pct < WARN_THRESHOLD) return;

    let resetStr = "";
    const resetsAt = data?.five_hour?.resets_at;
    if (resetsAt) {
      const diffMs = new Date(resetsAt).getTime() - Date.now();
      if (diffMs > 0) {
        const hrs = Math.floor(diffMs / 3600000);
        const mins = Math.floor((diffMs % 3600000) / 60000);
        resetStr = hrs > 0 ? `, resets in ${hrs}h ${mins}m` : `, resets in ${mins}m`;
      }
    }

    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `PROMPT_BUDGET: ${pct}% of 5-hour window used${resetStr}. Pace accordingly.`,
      },
    }));
  } catch {
    // fail-open
  }
}

main();
