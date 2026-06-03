/**
 * PAI Security Inspector Pipeline
 *
 * Orchestrates a chain of Inspector instances in priority order.
 * Short-circuits on deny, accumulates require_approval, returns allow only if all pass.
 *
 * Inspired by Goose's ToolInspectionManager pattern.
 */

import type { Inspector, InspectionContext, InspectionResult } from './types';
import { ALLOW, requireApproval } from './types';
import { logSecurityEvent } from './logger';

export class InspectorPipeline {
  private inspectors: Inspector[];

  constructor(inspectors: Inspector[]) {
    // Sort by priority descending (highest first)
    this.inspectors = [...inspectors].sort((a, b) => b.priority - a.priority);
  }

  async run(ctx: InspectionContext): Promise<InspectionResult> {
    let pendingApproval: InspectionResult | null = null;
    let triggeringInspector = '';

    for (const inspector of this.inspectors) {
      let result: InspectionResult;

      try {
        result = await inspector.inspect(ctx);
      } catch (err) {
        // Inspector error — fail closed rather than skipping the layer
        console.error(`[Pipeline] ${inspector.name} threw: ${err}`);
        logSecurityEvent({
          timestamp: new Date().toISOString(),
          sessionId: ctx.sessionId,
          eventType: 'confirm',
          inspector: inspector.name,
          tool: ctx.toolName,
          target: this.extractTarget(ctx),
          reason: `Inspector error: ${err}`,
          actionTaken: 'Inspector errored — failing closed to require_approval',
        });
        return requireApproval(
          `Security inspector ${inspector.name} errored — cannot verify safety`,
          `[PAI SECURITY] ⚠️ Inspector ${inspector.name} errored during evaluation.\n\nFailing closed. Proceed only if you initiated this action.`
        );
      }

      switch (result.action) {
        case 'deny':
          // Short-circuit: immediate deny
          logSecurityEvent({
            timestamp: new Date().toISOString(),
            sessionId: ctx.sessionId,
            eventType: 'block',
            inspector: inspector.name,
            tool: ctx.toolName,
            target: this.extractTarget(ctx),
            reason: result.reason,
            findingId: result.findingId,
            actionTaken: 'Hard block — exit 2',
          });
          return result;

        case 'require_approval':
          // Take highest-priority approval request
          if (!pendingApproval) {
            pendingApproval = result;
            triggeringInspector = inspector.name;
          }
          break;

        case 'alert':
          // Log and continue
          logSecurityEvent({
            timestamp: new Date().toISOString(),
            sessionId: ctx.sessionId,
            eventType: 'alert',
            inspector: inspector.name,
            tool: ctx.toolName,
            target: this.extractTarget(ctx),
            reason: result.reason,
            actionTaken: 'Alert logged, allowed execution',
          });
          break;

        case 'allow':
          // Continue to next inspector
          break;
      }
    }

    // If any inspector requested approval, return that
    if (pendingApproval) {
      logSecurityEvent({
        timestamp: new Date().toISOString(),
        sessionId: ctx.sessionId,
        eventType: 'confirm',
        inspector: triggeringInspector,
        tool: ctx.toolName,
        target: this.extractTarget(ctx),
        reason: pendingApproval.reason,
        actionTaken: 'Prompted user for confirmation',
      });
      return pendingApproval;
    }

    return ALLOW;
  }

  private extractTarget(ctx: InspectionContext): string {
    if (typeof ctx.toolInput === 'string') return ctx.toolInput.slice(0, 500);
    const command = ctx.toolInput?.command as string;
    const filePath = ctx.toolInput?.file_path as string;
    return (command || filePath || JSON.stringify(ctx.toolInput)).slice(0, 500);
  }
}
