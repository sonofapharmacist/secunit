/**
 * Explicit rating detection for SatisfactionCapture.
 *
 * A rating is a bare number ("8", "8/10", "ten!") or a number, a separator, then a
 * comment that starts with a letter ("3 - missed the point", "7: fine").
 *
 * Before 2026-10-02 any prompt starting with a number counted, so answers to numbered
 * options ("1 pls", "1 is doctrine make it so", "2 3 in a row pls", "1 and 3") were
 * recorded as 1/10 and resurfaced at session start as low-rating lessons. About 15 of
 * the 27 explicit ratings recorded May–Sep 2026 were such misreads. A rating typed
 * with a plain space and no separator ("3 seems off") is now missed; that loses one
 * data point, where a misread plants a false lesson.
 */

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const NUM = String.raw`(10|[1-9]|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*\/\s*10)?`;
const BARE = new RegExp(String.raw`^${NUM}\s*[!.]*$`, 'i');
// The comment must start with a letter so ranges and option lists ("1-3", "2: 4") don't count.
const WITH_COMMENT = new RegExp(String.raw`^${NUM}\s*[-:–—,]\s*([A-Za-z].*)$`, 'is');

export function parseExplicitRating(prompt: string): { rating: number; comment?: string } | null {
  const trimmed = prompt.trim();
  const m = trimmed.match(BARE) ?? trimmed.match(WITH_COMMENT);
  if (!m) return null;
  const token = m[1].toLowerCase();
  const rating = WORD_NUMBERS[token] ?? parseInt(token, 10);
  const comment = m[2]?.trim() || undefined;
  return comment ? { rating, comment } : { rating };
}
