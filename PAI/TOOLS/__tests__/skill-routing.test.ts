import { beforeEach, describe, expect, test } from "bun:test";

import {
  _resetSkillRoutingCache,
  getSkillRoutingPreference,
  loadRoutingManifest,
  resolveRoutingManifestPath,
  resolveSkillRoutingManifestPath,
} from "../lib/tier-inference";

import {
  getTierForModel,
  resolveRoutingDecision,
} from "../Inference";

beforeEach((): void => {
  _resetSkillRoutingCache();
});

describe('getSkillRoutingPreference', () => {
  test('returns tier + modelHints for tabletop-exercise', () => {
    const pref = getSkillRoutingPreference('tabletop-exercise');
    expect(pref.tier).toBe('fast');
    expect(Array.isArray(pref.modelHints)).toBe(true);
    expect(pref.modelHints).toContain('qwen2.5-coder:7b-instruct-q4_K_M');
    expect(pref.modelHints).toContain('deepseek-coder-v2:lite');
  });

  test('returns {} for unknown skills (no error)', () => {
    const pref = getSkillRoutingPreference('this-skill-does-not-exist-xyz');
    expect(pref.tier).toBeUndefined();
    expect(pref.modelHints).toBeUndefined();
    expect(Object.keys(pref).length).toBe(0);
  });

  test('skill-routing.yaml parses without error and yields all four registered skills', () => {
    const path = resolveSkillRoutingManifestPath();
    expect(path.endsWith('skill-routing.yaml')).toBe(true);

    // All four documented skills resolve cleanly.
    const skills = ['tabletop-exercise', 'asa', 'tldr-librarian', 'aurascape'];
    for (const name of skills) {
      const pref = getSkillRoutingPreference(name);
      expect(pref.tier).toBeDefined();
    }
  });

  test('every registered skill has a tier (name field implicit via lookup)', () => {
    expect(getSkillRoutingPreference('tabletop-exercise').tier).toBe('fast');
    expect(getSkillRoutingPreference('asa').tier).toBe('standard');
    expect(getSkillRoutingPreference('tldr-librarian').tier).toBe('fast');
    expect(getSkillRoutingPreference('aurascape').tier).toBe('standard');
  });
});

describe('resolveRoutingDecision (skill > level priority)', () => {
  test('skill preferred_tier overrides requested level', () => {
    // asa is preferred_tier: standard. Caller requests 'smart' — skill wins.
    const decision = resolveRoutingDecision('asa', 'smart');
    expect(decision.tier).toBe('standard');
    expect(decision.source).toBe('skill');
  });

  test('with model_hints, picks a hint that matches the resolved tier', () => {
    // tabletop-exercise → fast, hints include qwen2.5-coder:7b-instruct-q4_K_M (fast tier).
    const decision = resolveRoutingDecision('tabletop-exercise', undefined);
    expect(decision.tier).toBe('fast');
    expect(decision.preferredModel).toBe('qwen2.5-coder:7b-instruct-q4_K_M');
  });

  test('unknown skill falls through to requested level', () => {
    const decision = resolveRoutingDecision('not-a-real-skill', 'smart');
    expect(decision.tier).toBe('smart');
    expect(decision.preferredModel).toBeUndefined();
  });

  test('no skillName preserves prior behavior (caller-driven level)', () => {
    const decision = resolveRoutingDecision(undefined, 'fast');
    expect(decision.tier).toBe('fast');
    expect(decision.skillName).toBeUndefined();
  });
});

describe('inference-routing.yaml integrity', () => {
  test('parses successfully and contains all configured models', () => {
    const manifest = loadRoutingManifest(resolveRoutingManifestPath());
    // The pre-populated manifest has 15+ models across 3 tiers (P3 expansion).
    expect(manifest.size).toBeGreaterThanOrEqual(15);

    // Spot-check a few known models from each tier.
    expect(manifest.get('qwen2.5-coder:7b-instruct-q4_K_M')).toBe('fast');
    expect(manifest.get('gemma4:e4b-it-q4_K_M')).toBe('standard');
    expect(manifest.get('gpt-oss:20b')).toBe('smart');
  });

  test('getTierForModel() works with all registered models', () => {
    const manifest = loadRoutingManifest(resolveRoutingManifestPath());
    for (const [model, tier] of manifest.entries()) {
      expect(getTierForModel(model)).toBe(tier);
    }
  });
});
