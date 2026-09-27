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

    // The cache is only refreshed by statusline-command.sh's OAuth fallback
    // path — sessions with native rate_limits (has_native_rate_limits=true)
    // never write it, so it can freeze indefinitely at a past window's
    // snapshot. A resets_at already in the past proves the window it
    // describes has closed and the data is dead, regardless of TTL.
    const resetsAt = data?.five_hour?.resets_at;
    let resetStr = "";
    if (resetsAt) {
      const diffMs = new Date(resetsAt).getTime() - Date.now();
      if (diffMs <= 0) return;
      const hrs = Math.floor(diffMs / 3600000);
      const mins = Math.floor((diffMs % 3600000) / 60000);
      resetStr = hrs > 0 ? `, resets in ${hrs}h ${mins}m` : `, resets in ${mins}m`;
    }

    const pct = Math.round(utilization);
    if (pct < WARN_THRESHOLD) return;

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
