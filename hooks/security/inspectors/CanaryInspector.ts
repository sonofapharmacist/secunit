import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Inspector, InspectionContext, InspectionResult } from '../types';
import { ALLOW, deny, alert } from '../types';
import { logSecurityEvent } from '../logger';

interface CanaryRecord {
  session_id: string;
  canary: string;
  timestamp: string;
}

/** Best-effort alert sink. Must never throw or block; the deny stands regardless. */
export type CanaryNotifier = (toolName: string, sessionId: string) => void;

// In-flight alerts. The hook process exits right after a deny, which would kill
// a fire-and-forget fetch, so SecurityPipeline awaits flushCanaryAlerts() first.
const pendingAlerts: Promise<unknown>[] = [];

/** Wait for in-flight alerts, bounded so a dead Pulse never stalls the hook. */
export async function flushCanaryAlerts(timeoutMs = 1500): Promise<void> {
  if (pendingAlerts.length === 0) return;
  await Promise.race([Promise.allSettled(pendingAlerts), new Promise((r) => setTimeout(r, timeoutMs))]);
}

/** Production notifier: P0 through Pulse /notify (pages GP, breaks DND). */
export const pulseCanaryNotifier: CanaryNotifier = (toolName, sessionId) => {
  try {
    const sent = fetch('http://localhost:31337/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Canary token tripped',
        message: `Canary token detected in ${toolName} input in session ${sessionId.slice(0, 8)}. Possible injection exfiltration; the call was blocked. Check MEMORY/SECURITY for the event.`,
        severity: 'P0',
        source: 'canary-inspector',
        id: `canary-${sessionId.slice(0, 8)}`,
      }),
      signal: AbortSignal.timeout(1500),
    }).catch(() => {});
    pendingAlerts.push(sent);
  } catch {
    // Notification failure must never prevent the block
  }
};

const HOME = process.env.HOME || '';
const OBS_DIR = join(HOME, '.claude', 'PAI', 'MEMORY', 'OBSERVABILITY');

class CanaryInspector implements Inspector {
  name = 'CanaryInspector';
  priority = 95; // Runs before InjectionInspector (80), after nothing critical

  constructor(private readonly notify: CanaryNotifier) {}

  inspect(ctx: InspectionContext): InspectionResult {
    // ISC-18: no session_id in context → fail open
    if (!ctx.sessionId) return ALLOW;

    const canaryFile = join(OBS_DIR, `session-canary-${ctx.sessionId}.json`);

    // ISC-8: canary file absent → fail open
    if (!existsSync(canaryFile)) return ALLOW;

    let record: CanaryRecord;
    try {
      record = JSON.parse(readFileSync(canaryFile, 'utf-8')) as CanaryRecord;
    } catch {
      // File present but unreadable/corrupt — log as anomalous, allow (can't determine canary)
      logSecurityEvent({
        timestamp: new Date().toISOString(),
        sessionId: ctx.sessionId,
        eventType: 'alert',
        inspector: 'CanaryInspector',
        tool: ctx.toolName,
        target: canaryFile,
        reason: 'Canary file present but unreadable or corrupt — canary detection degraded',
        actionTaken: 'Alert logged, canary check skipped',
      });
      return alert('CanaryInspector: canary file corrupt — canary detection degraded this call');
    }

    // session_id mismatch — file exists but doesn't belong to this session; anomalous
    if (record.session_id !== ctx.sessionId) {
      logSecurityEvent({
        timestamp: new Date().toISOString(),
        sessionId: ctx.sessionId,
        eventType: 'alert',
        inspector: 'CanaryInspector',
        tool: ctx.toolName,
        target: canaryFile,
        reason: `Canary file session_id mismatch (stored: ${record.session_id}, current: ${ctx.sessionId})`,
        actionTaken: 'Alert logged, canary check skipped',
      });
      return alert('CanaryInspector: canary file session_id mismatch — possible tampering');
    }

    const { canary } = record;
    if (!canary) return ALLOW;

    // ISC-10: scan stringified tool_input for exact canary match
    const inputStr = JSON.stringify(ctx.toolInput) ?? '';
    if (!inputStr.includes(canary)) return ALLOW;

    const reason = `Canary token detected in ${ctx.toolName} tool_input — possible exfiltration attempt`;

    // ISC-12: log security event
    logSecurityEvent({
      timestamp: new Date().toISOString(),
      sessionId: ctx.sessionId,
      eventType: 'injection',
      inspector: 'CanaryInspector',
      tool: ctx.toolName,
      target: String(ctx.toolInput).slice(0, 200),
      reason,
      actionTaken: 'Hard block — exit 2',
    });

    // ISC-13: alert GP (best-effort, non-blocking)
    try {
      this.notify(ctx.toolName, ctx.sessionId);
    } catch {
      // Notification failure must never prevent the block
    }

    // ISC-11: hard deny
    return deny(reason, 'SEC-canary-detection');
  }
}

export function createCanaryInspector(notify: CanaryNotifier): CanaryInspector {
  return new CanaryInspector(notify);
}
