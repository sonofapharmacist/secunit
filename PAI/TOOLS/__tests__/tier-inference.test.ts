import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  inferTierFromLatency,
  loadRoutingManifest,
} from "../lib/tier-inference";

const tempDirs: string[] = [];

afterEach((): void => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('inferTierFromLatency', () => {
  test('maps 80ms to fast', () => {
    expect(inferTierFromLatency(80)).toBe('fast');
  });

  test('maps 500ms to standard', () => {
    expect(inferTierFromLatency(500)).toBe('standard');
  });

  test('maps 1000ms to standard', () => {
    expect(inferTierFromLatency(1000)).toBe('standard');
  });

  test('maps 5233ms to standard', () => {
    expect(inferTierFromLatency(5233)).toBe('standard');
  });

  test('rejects negative latency', () => {
    expect(() => inferTierFromLatency(-1)).toThrow(/Invalid cold-start latency/);
  });

  test('rejects NaN latency', () => {
    expect(() => inferTierFromLatency(Number.NaN)).toThrow(/Invalid cold-start latency/);
  });
});

describe('loadRoutingManifest', () => {
  test('parses models and ignores comments plus decision_logic block', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tier-routing-'));
    tempDirs.push(directory);

    const manifestPath = join(directory, 'inference-routing.yaml');
    writeFileSync(
      manifestPath,
      [
        '# comment',
        'version: 1',
        'decision_logic: |',
        '  comment-like text: keep ignoring this',
        '  second line',
        '',
        'models:',
        '  qwen2.5-coder:7b-instruct-q4_K_M: { tier: fast, cold_start_ms: 80, warm_p50_ms: 77 }',
        '  gemma4:e4b-it-q4_K_M:',
        '    tier: standard',
        '    cold_start_ms: 5233',
        '    warm_p50_ms: 235',
      ].join('\n'),
      'utf-8',
    );

    const manifest = loadRoutingManifest(manifestPath);
    expect(manifest.get('qwen2.5-coder:7b-instruct-q4_K_M')).toBe('fast');
    expect(manifest.get('gemma4:e4b-it-q4_K_M')).toBe('standard');
  });
});
