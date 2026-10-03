import { describe, expect, test } from 'bun:test';
import { summarizeTypedRatings } from '../lib/learning-readback';

const now = Date.parse('2026-10-20T12:00:00Z');

describe('summarizeTypedRatings', () => {
  test('averages typed ratings by window and ignores implicit rows', () => {
    const out = summarizeTypedRatings([
      { timestamp: '2026-10-19T10:00:00Z', rating: 8, source: 'explicit' },
      { timestamp: '2026-10-18T10:00:00Z', rating: 6, source: 'explicit', comment: 'meh' },
      { timestamp: '2026-10-01T10:00:00Z', rating: 10, source: 'explicit' },
      { timestamp: '2026-10-19T11:00:00Z', rating: 2, source: 'implicit' },
    ], now);
    expect(out).toBe('**Typed ratings:** Week: 7.0/10 (n=2) | Month: 8.0/10 (n=3)');
  });

  test('drops pre-fix rows with a comment (option picks) and hides when nothing remains', () => {
    expect(summarizeTypedRatings([
      { timestamp: '2026-09-25T10:00:00Z', rating: 1, source: 'explicit', comment: 'pls it was fat' },
      { timestamp: '2026-10-19T10:00:00Z', rating: 3, source: 'implicit' },
    ], now)).toBeNull();
  });
});
