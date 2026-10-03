import { describe, expect, test } from 'bun:test';
import { verifyClassifier } from '../lib/classifier-cascade';
import { loadFloors, localAllowed } from '../../PAI/TOOLS/lib/cascade';

describe('classifier verifier', () => {
  test('accepts a valid ALGORITHM answer, fenced or not', () => {
    const body = '{"tab_title":"Wire classifier","session_name":null,"mode":"ALGORITHM","tier":3,"mode_reason":"multi-file"}';
    for (const out of [body, '```json\n' + body + '\n```']) {
      const v = verifyClassifier(out);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.value).toMatchObject({ mode: 'ALGORITHM', tier: 3 });
    }
  });
  test('NATIVE/MINIMAL need no tier, and tier is dropped', () => {
    const v = verifyClassifier('{"mode":"NATIVE","tier":4,"tab_title":"x"}');
    expect(v.ok && v.value.tier).toBe(null);
  });
  test('rejects what the hook used to silently default', () => {
    expect(verifyClassifier('{"mode":"algorithm","tier":3}')).toEqual({ ok: false, reason: 'invalid mode: algorithm' });
    expect(verifyClassifier('{"mode":"ALGORITHM"}').ok).toBe(false);
    expect(verifyClassifier('{"mode":"ALGORITHM","tier":7}').ok).toBe(false);
    expect(verifyClassifier('{"mode":"ALGORITHM","tier":2.5}').ok).toBe(false);
    expect(verifyClassifier('{"mode":"NATIVE","tab_title":42}').ok).toBe(false);
    expect(verifyClassifier('I think this is ALGORITHM tier 3').ok).toBe(false);
  });
  test('the live floors file lets the classifier run local first', () => {
    expect(localAllowed(loadFloors(), 'prompt-classifier').ok).toBe(true);
  });
});
