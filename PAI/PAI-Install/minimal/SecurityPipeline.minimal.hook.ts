#!/usr/bin/env bun
/**
 * SecurityPipeline.minimal.hook.ts — PreToolUse entry point (minimal install variant)
 *
 * Same as SecurityPipeline.hook.ts minus RulesInspector. RulesInspector only
 * activates when USER/SECURITY/SECURITY_RULES.md exists with content, and it
 * costs an LLM call per unique tool invocation via Inference.ts — which pulls
 * in the `yaml` and `@anthropic-ai/sdk` npm packages plus a local tier-inference
 * module. None of that belongs in a from-scratch minimal install that hasn't
 * run `bun install` for the full PAI/TOOLS dependency set. The remaining
 * inspectors (Canary, Pattern, Egress) cover prompt-injection detection,
 * dangerous command patterns, and outbound data screening without it.
 *
 * If a team later wants natural-language security rules (SECURITY_RULES.md),
 * run the full installer per UPGRADE.md — it swaps this file for the full
 * SecurityPipeline.hook.ts and pulls in the RulesInspector dependency chain.
 *
 * TRIGGER: PreToolUse (matcher: Bash, Write, Edit, MultiEdit)
 */

import type { InspectionContext } from './security/types';
import { InspectorPipeline } from './security/pipeline';
import { createPatternInspector } from './security/inspectors/PatternInspector';
import { createEgressInspector } from './security/inspectors/EgressInspector';
import { createCanaryInspector } from './security/inspectors/CanaryInspector';
import { logSecurityEvent } from './security/logger';

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown> | string;
}

const pipeline = new InspectorPipeline([
  createCanaryInspector(),
  createPatternInspector(),
  createEgressInspector(),
]);

function emitAsk(reason: string): void {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: `[PAI SECURITY] ⚠️ ${reason}`,
    },
  }));
}

async function main(): Promise<void> {
  let input: HookInput;

  let raw: string;
  try {
    const { readFileSync } = await import('fs');
    raw = readFileSync('/dev/stdin', 'utf-8');
  } catch {
    return; // stdin unavailable — hook not applicable to this call
  }

  if (!raw.trim()) return; // Empty stdin — allow

  try {
    input = JSON.parse(raw);
  } catch {
    // Content present but not valid JSON — suspicious, fail closed
    emitAsk('Security pipeline received malformed input — cannot verify tool call safety');
    return;
  }

  const ctx: InspectionContext = {
    sessionId: input.session_id,
    toolName: input.tool_name,
    toolInput: input.tool_input,
  };

  const result = await pipeline.run(ctx);

  switch (result.action) {
    case 'deny':
      console.error(`[PAI SECURITY] 🚨 BLOCKED: ${result.reason}`);
      process.exit(2);
      break;

    case 'require_approval':
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: result.permissionDecisionReason,
        },
      }));
      break;

    case 'alert':
      console.error(`[PAI SECURITY] ⚠️ ALERT: ${result.reason}`);
      break;

    case 'allow':
      // Log ALLOW decisions for write operations — positive audit trail for file changes
      if (input.tool_name === 'Write' || input.tool_name === 'Edit' || input.tool_name === 'MultiEdit') {
        logSecurityEvent({
          timestamp: new Date().toISOString(),
          sessionId: input.session_id,
          eventType: 'allow',
          inspector: 'pipeline',
          tool: input.tool_name,
          target: typeof input.tool_input === 'string'
            ? input.tool_input.slice(0, 200)
            : ((input.tool_input as Record<string, unknown>)?.file_path as string ?? '').slice(0, 200),
          actionTaken: 'Write operation allowed by security pipeline',
        });
      }
      break;
  }
}

main().catch(() => {
  // Uncaught exception — fail closed rather than silently allowing
  emitAsk('Security pipeline encountered an unexpected error — cannot verify tool call safety');
  process.exit(0);
});
