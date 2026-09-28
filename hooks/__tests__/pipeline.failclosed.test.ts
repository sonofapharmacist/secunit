/**
 * Fail-closed contract for the security InspectorPipeline.
 *
 * CLAUDE.md invariant: "Inspector throws in a pipeline return `require_approval`,
 * never `continue` — skipping a layer is indistinguishable from a bypass."
 *
 * pipeline.ts implements this (the catch around inspect() returns require_approval),
 * but nothing proved it. A refactor that turned the catch into a `continue` or a
 * swallowed error would silently reopen the bypass with every test still green.
 * These tests make that regression impossible to land quietly.
 */
import { describe, test, expect, spyOn, beforeAll, afterAll } from 'bun:test';
import { InspectorPipeline } from '../security/pipeline';
import { ALLOW, deny, requireApproval, alert } from '../security/types';
import type { Inspector, InspectionResult, InspectionContext } from '../security/types';

const THROW = Symbol('throw');
const stub = (name: string, priority: number, out: InspectionResult | typeof THROW): Inspector => ({
  name,
  priority,
  inspect: async () => {
    if (out === THROW) throw new Error(`${name} boom`);
    return out;
  },
});

const ctx: InspectionContext = {
  sessionId: 'test-session',
  toolName: 'Bash',
  toolInput: { command: 'echo hi' },
} as InspectionContext;

// Silence the pipeline's console.error on the throw path so test output stays clean.
let errSpy: ReturnType<typeof spyOn>;
beforeAll(() => { errSpy = spyOn(console, 'error').mockImplementation(() => {}); });
afterAll(() => { errSpy.mockRestore(); });

describe('InspectorPipeline — fail closed on inspector throw', () => {
  test('a throwing inspector yields require_approval, not allow', async () => {
    const r = await new InspectorPipeline([stub('Boom', 100, THROW)]).run(ctx);
    expect(r.action).toBe('require_approval');
  });

  test('the throw short-circuits — a later inspector that would ALLOW cannot rescue it', async () => {
    // Higher-priority inspector throws; lower-priority one allows. Must still fail closed.
    const r = await new InspectorPipeline([
      stub('Boom', 100, THROW),
      stub('WouldAllow', 10, ALLOW),
    ]).run(ctx);
    expect(r.action).toBe('require_approval');
  });

  test('the throw is not silently skipped even when every other inspector allows', async () => {
    const r = await new InspectorPipeline([
      stub('AllowA', 90, ALLOW),
      stub('Boom', 50, THROW),
      stub('AllowB', 10, ALLOW),
    ]).run(ctx);
    expect(r.action).toBe('require_approval');
  });

  test('the require_approval names the failing inspector (operator can see which layer errored)', async () => {
    const r = await new InspectorPipeline([stub('EgressInspector', 90, THROW)]).run(ctx);
    expect(r.action).toBe('require_approval');
    expect(`${r.reason} ${r.permissionDecisionReason ?? ''}`).toContain('EgressInspector');
  });
});

describe('InspectorPipeline — non-throw ordering (guards against the fix breaking normal paths)', () => {
  test('a hard deny short-circuits before a later throw is ever reached', async () => {
    // deny must win and the pipeline must not even call the throwing inspector after it.
    const r = await new InspectorPipeline([
      stub('Deny', 100, deny('nope', 'F-1')),
      stub('Boom', 50, THROW),
    ]).run(ctx);
    expect(r.action).toBe('deny');
    expect(r.findingId).toBe('F-1');
  });

  test('all-allow → ALLOW', async () => {
    const r = await new InspectorPipeline([stub('A', 50, ALLOW), stub('B', 10, ALLOW)]).run(ctx);
    expect(r.action).toBe('allow');
  });

  test('alert does not block; a later require_approval is what surfaces', async () => {
    const r = await new InspectorPipeline([
      stub('Alerter', 90, alert('fyi')),
      stub('Asker', 50, requireApproval('please confirm')),
    ]).run(ctx);
    expect(r.action).toBe('require_approval');
    expect(r.reason).toBe('please confirm');
  });
});
