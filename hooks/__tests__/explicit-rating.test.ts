import { describe, expect, test } from 'bun:test';
import { parseExplicitRating } from '../lib/explicit-rating';

describe('parseExplicitRating', () => {
  test('bare numbers and words are ratings', () => {
    for (const [p, r] of [['8', 8], ['10', 10], [' 9 ', 9], ['7/10', 7], ['8 / 10', 8], ['10!', 10], ['ten', 10], ['Eight!', 8], ['3.', 3]] as const) {
      expect(parseExplicitRating(p)).toEqual({ rating: r });
    }
  });

  test('number, separator, comment is a rating with a comment', () => {
    expect(parseExplicitRating('3 - missed the point')).toEqual({ rating: 3, comment: 'missed the point' });
    expect(parseExplicitRating('7: fine')).toEqual({ rating: 7, comment: 'fine' });
    expect(parseExplicitRating('9/10 — great')).toEqual({ rating: 9, comment: 'great' });
    expect(parseExplicitRating('two, way off')).toEqual({ rating: 2, comment: 'way off' });
  });

  // Real prompts that were recorded as low ratings between May and Sep 2026.
  test('answers to numbered options are not ratings', () => {
    for (const p of [
      '1 is doctrine make it so, then lets get to fixing why it didn\'t get run',
      '1 pls it was fat that can be removed',
      '1 +2 pls then lets cook on the rest after',
      '4 years x 3.2M x resign bonis = 9.6 points  for champagnie',
      '1 57322-332-8',
      '1 84309-474-6',
      '2 3 in a row pls',
      '1 and 3 . transactions i\'ll show you from proboards here',
      '1 and 2 complete. rust stained weeping.',
      '1 do it quick.  also on the observability dashboard',
      '3 for 1. check the fallback code created from other session',
      '1 at a time',
      'one at a time',
      '1-3',
      '2: 4',
      '1. yes',
      '10x faster',
      '3 items left',
      'do 1 and 2',
    ]) {
      expect(parseExplicitRating(p)).toBeNull();
    }
  });
});
