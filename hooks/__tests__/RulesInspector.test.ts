import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

// ── Mock inference BEFORE any import of RulesInspector ──────────────────────
// mock.module is hoisted by Bun above all imports; factory is called lazily
// so `mockInferenceResult` is initialized by the time the factory runs.
const INFERENCE_MODULE = join(import.meta.dir, '../../PAI/TOOLS/Inference.ts');

// Holds the response that mocked inference() will return; reassign per test
let mockInferenceResult: { success: boolean; parsed?: { decision: string; reason: string } } = {
  success: true,
  parsed: { decision: 'ALLOW', reason: 'test default' },
};
let inferenceCallCount = 0;

mock.module(INFERENCE_MODULE, () => ({
  inference: async (_opts: unknown) => {
    inferenceCallCount++;
    return mockInferenceResult;
  },
}));

// ── After mocking, import the module under test ──────────────────────────────
// Dynamic import ensures RulesInspector loads AFTER mock is registered.
// We use a top-level variable populated in beforeAll.
let createRulesInspector: () => import('../security/types.ts').Inspector;

// PAI_DIR for rules file path — point to a tmpdir so we control existence
import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

const tmpPaiDir = mkdtempSync(join(tmpdir(), 'secunit-rules-test-'));
const securityDir = join(tmpPaiDir, 'USER', 'SECURITY');
const rulesFilePath = join(securityDir, 'SECURITY_RULES.md');
mkdirSync(securityDir, { recursive: true });

const origPaiDir = process.env.PAI_DIR;
process.env.PAI_DIR = tmpPaiDir;

import type { InspectionContext } from '../security/types.ts';

beforeAll(async () => {
  const mod = await import('../security/inspectors/RulesInspector.ts');
  createRulesInspector = mod.createRulesInspector;
});

afterAll(() => {
  process.env.PAI_DIR = origPaiDir;
  try { unlinkSync(rulesFilePath); } catch { /* ok */ }
});

function ctx(command: string): InspectionContext {
  return {
    sessionId: 'test-session',
    toolName: 'Bash',
    toolInput: { command },
  };
}

describe('RulesInspector', () => {
  test('no SECURITY_RULES.md → allow without calling inference', () => {
    if (existsSync(rulesFilePath)) unlinkSync(rulesFilePath);
    inferenceCallCount = 0;

    const inspector = createRulesInspector();
    const result = inspector.inspect(ctx('ls /tmp'));

    // Must be a promise (async inspect)
    return Promise.resolve(result).then((r) => {
      expect(r.action).toBe('allow');
      expect(inferenceCallCount).toBe(0);
    });
  });

  test('rules file exists + inference returns ALLOW → allow', async () => {
    writeFileSync(rulesFilePath, '## BLOCK\n- Do not access /secrets\n');
    mockInferenceResult = { success: true, parsed: { decision: 'ALLOW', reason: 'no rule matched' } };
    inferenceCallCount = 0;

    const inspector = createRulesInspector();
    const result = await inspector.inspect(ctx('ls /tmp'));
    expect(result.action).toBe('allow');
    expect(inferenceCallCount).toBe(1);
  });

  test('rules file exists + inference returns BLOCK → deny', async () => {
    writeFileSync(rulesFilePath, '## BLOCK\n- Do not access /secrets\n');
    mockInferenceResult = { success: true, parsed: { decision: 'BLOCK', reason: 'matches /secrets rule' } };

    const inspector = createRulesInspector();
    const result = await inspector.inspect(ctx('cat /secrets/api-keys'));
    expect(result.action).toBe('deny');
    expect(result.reason).toContain('matches /secrets rule');
  });

  test('rules file exists + inference fails → require_approval (fail-closed)', async () => {
    writeFileSync(rulesFilePath, '## BLOCK\n- Do not access /secrets\n');
    mockInferenceResult = { success: false, parsed: undefined };

    const inspector = createRulesInspector();
    const result = await inspector.inspect(ctx('ls /tmp/other'));
    expect(result.action).toBe('require_approval');
  });

  test('result cache: identical call returns cached result without second inference call', async () => {
    writeFileSync(rulesFilePath, '## BLOCK\n- Do not access /secrets\n');
    mockInferenceResult = { success: true, parsed: { decision: 'ALLOW', reason: 'cached' } };
    inferenceCallCount = 0;

    const inspector = createRulesInspector();
    const cmd = 'ls /tmp/cache-test-' + Date.now();

    await inspector.inspect(ctx(cmd));
    await inspector.inspect(ctx(cmd)); // identical input
    expect(inferenceCallCount).toBe(1); // second call should use cache
  });
});
