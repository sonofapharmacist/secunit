import { describe, expect, test } from 'bun:test';
import { newProposals, sameTarget, type InferenceEdit } from '../handlers/DocCrossRefIntegrity';

const e = (doc: string, old_text: string, new_text = 'x'): InferenceEdit => ({ doc, old_text, new_text, reason: 'r' });

describe('sameTarget', () => {
  test('same doc and overlapping old text, whatever the wording', () => {
    expect(sameTarget(e('A.md', 'ContentScanner (PostToolUse: WebFetch, WebSearch) runs InjectionInspector(80)'), e('A.md', 'ContentScanner (PostToolUse: WebFetch, WebSearch)'))).toBe(true);
    expect(sameTarget(e('A.md', '  same line '), e('A.md', 'same line'))).toBe(true);
  });
  test('different doc, disjoint text or empty text is not the same target', () => {
    expect(sameTarget(e('A.md', 'same line'), e('B.md', 'same line'))).toBe(false);
    expect(sameTarget(e('A.md', 'one line'), e('A.md', 'another line'))).toBe(false);
    expect(sameTarget(e('A.md', ''), e('A.md', 'anything'))).toBe(false);
  });
});

describe('newProposals', () => {
  // Shapes from the 2026-10-02 review: 7 rewordings of one LoadContext row, 2 changelog re-proposals.
  test('drops rewordings of a pending edit and of each other', () => {
    const pending = [e('Arch.md', '| `hooks/LoadContext.hook.ts` | Injects startup files + dynamic context |')];
    const r = newProposals([
      e('Arch.md', 'Injects startup files + dynamic context', 'v2'),
      e('Fork.md', 'on WebFetch/WebSearch results', 'a'),
      e('Fork.md', '`InjectionInspector` on WebFetch/WebSearch results', 'b'),
    ], pending, []);
    expect(r.fresh.map(x => x.new_text)).toEqual(['a']);
    expect(r.duplicates).toBe(2);
  });

  test('drops proposals that target text GP already rejected', () => {
    const rejected = [{ doc: 'CHANGELOG.md', old_text: '- **Nightly code review defaults to Sonnet again.** Gemini Flash stays available via `--reviewer flash`.' }];
    const r = newProposals([e('CHANGELOG.md', '- **Nightly code review defaults to Sonnet again.**'), e('CHANGELOG.md', 'an unrelated line')], [], rejected);
    expect(r.rejectedAgain).toBe(1);
    expect(r.fresh.map(x => x.old_text)).toEqual(['an unrelated line']);
  });
});
