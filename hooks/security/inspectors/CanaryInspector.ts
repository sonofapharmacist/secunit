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

const HOME = process.env.HOME || '';
const OBS_DIR = join(HOME, '.claude', 'PAI', 'MEMORY', 'OBSERVABILITY');

class CanaryInspector implements Inspector {
  name = 'CanaryInspector';
  priority = 95; // Runs before InjectionInspector (80), after nothing critical

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

    // ISC-13: fire Pulse notification (best-effort, non-blocking)
    try {
      const body = JSON.stringify({
        message: `SECURITY ALERT: Canary token detected in ${ctx.toolName} — possible injection exfiltration. Session blocked.`,
        voice_enabled: true,
      });
      // Sync fetch via Bun — intentionally brief timeout
      fetch('http://localhost:31337/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(2000),
      }).catch(() => {}); // Non-blocking — ignore failures
    } catch {
      // Notification failure must never prevent the block
    }

    // ISC-11: hard deny
    return deny(reason, 'SEC-canary-detection');
  }
}

export function createCanaryInspector(): CanaryInspector {
  return new CanaryInspector();
}
