/**
 * learning-readback.ts - Close the learning loop by reading learnings back into context
 *
 * PURPOSE:
 * The PAI learning system writes extensively (8,400+ files across 5 hooks) but
 * previously had no readback mechanism. This library provides fast, compact
 * readers that LoadContext.hook.ts calls at session start to inject accumulated
 * knowledge back into the model's context.
 *
 * FUNCTIONS:
 * - loadLearningDigest()    — Recent learning signals (ALGORITHM + SYSTEM)
 * - loadWisdomFrames()      — Crystallized behavioral patterns (WISDOM/FRAMES)
 * - loadFailurePatterns()   — Recent failure insights (FAILURES)
 * - loadSignalTrends()      — Typed-rating averages from ratings.jsonl
 * - loadSynthesisPatterns() — Most recent weekly complaint synthesis (SYNTHESIS)
 *
 * PERFORMANCE:
 * Each function reads a small number of pre-existing files (<10).
 * Total budget: <100ms combined. All reads are synchronous for simplicity.
 *
 * OUTPUT:
 * Each function returns a compact string (<500 chars) or null if no data.
 * Combined output stays under 2000 chars for context injection.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

/** Date the explicit-rating parser stopped counting replies like "1 pls" as ratings. */
const RATING_PARSER_FIXED = '2026-10-02';

/**
 * Explicit low-rating notes written before the parser fix with a comment attached were
 * answers to numbered options ("1 is doctrine make it so", "2 3 in a row pls"), not
 * ratings. Every one checked on 2026-10-02 was. Bare-number ratings are kept.
 */
function isMisreadRating(file: string, content: string, feedback: string): boolean {
  return /^source:\s*explicit/m.test(content) && feedback !== '' && file.slice(0, 10) < RATING_PARSER_FIXED;
}

/**
 * Read the N most recent learning files from a LEARNING subdirectory.
 * Files are named YYYY-MM-DD-HHMMSS_LEARNING_*.md with YAML frontmatter.
 * Extracts the **Feedback:** line and rating for compact display.
 */
function getRecentLearnings(baseDir: string, subdir: string, count: number): string[] {
  const insights: string[] = [];
  const learningDir = join(baseDir, 'MEMORY', 'LEARNING', subdir);
  if (!existsSync(learningDir)) return insights;

  try {
    // Get month dirs sorted descending (newest first)
    const months = readdirSync(learningDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
      .map(d => d.name)
      .sort()
      .reverse();

    for (const month of months) {
      if (insights.length >= count) break;
      const monthPath = join(learningDir, month);

      try {
        const files = readdirSync(monthPath)
          // _sentiment-rating- notes came from the implicit grader retired 2026-10-02 (55-63% precision).
          .filter(f => f.endsWith('.md') && !f.includes('_sentiment-rating-'))
          .sort()
          .reverse();

        for (const file of files) {
          if (insights.length >= count) break;
          try {
            const content = readFileSync(join(monthPath, file), 'utf-8');
            // [ \t]* not \s*: an empty Feedback line must not capture the next line ("---").
            const feedbackMatch = content.match(/\*\*Feedback:\*\*[ \t]*(.*)/);
            const ratingMatch = content.match(/rating:\s*(\d+)/);
            if (feedbackMatch) {
              const feedback = feedbackMatch[1].trim();
              if (isMisreadRating(file, content, feedback)) continue;
              const rating = ratingMatch ? ratingMatch[1] : '?';
              insights.push(`[${rating}/10] ${feedback ? feedback.substring(0, 80) : '(no comment)'}`);
            }
          } catch { /* skip unreadable files */ }
        }
      } catch { /* skip unreadable months */ }
    }
  } catch { /* skip if dir scan fails */ }

  return insights;
}

/**
 * Load recent learning signals from ALGORITHM and SYSTEM directories.
 * Returns the 3 most recent from each, formatted as a compact bullet list.
 */
export function loadLearningDigest(paiDir: string): string | null {
  const algorithmInsights = getRecentLearnings(paiDir, 'ALGORITHM', 3);
  const systemInsights = getRecentLearnings(paiDir, 'SYSTEM', 3);

  if (algorithmInsights.length === 0 && systemInsights.length === 0) return null;

  const parts: string[] = ['**Recent Learning Signals:**'];

  if (algorithmInsights.length > 0) {
    parts.push('*Algorithm:*');
    algorithmInsights.forEach(i => parts.push(`  ${i}`));
  }
  if (systemInsights.length > 0) {
    parts.push('*System:*');
    systemInsights.forEach(i => parts.push(`  ${i}`));
  }

  return parts.join('\n');
}

/**
 * Load Wisdom Frame core principles for context injection.
 * Reads all WISDOM/FRAMES/*.md files and extracts principle headers
 * (lines matching "### Name [CRYSTAL: N%]").
 */
export function loadWisdomFrames(paiDir: string): string | null {
  const framesDir = join(paiDir, 'MEMORY', 'WISDOM', 'FRAMES');
  if (!existsSync(framesDir)) return null;

  const principles: string[] = [];

  try {
    const files = readdirSync(framesDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      try {
        const content = readFileSync(join(framesDir, file), 'utf-8');
        const domain = file.replace('.md', '');

        // Extract principle headers with CRYSTAL confidence
        const matches = content.matchAll(/^### (.+?) \[CRYSTAL: (\d+)%\]/gm);
        for (const match of matches) {
          const confidence = parseInt(match[2], 10);
          if (confidence >= 85) {
            principles.push(`[${domain}] ${match[1]} (${confidence}%)`);
          }
        }
      } catch { /* skip unreadable frames */ }
    }
  } catch { /* skip if dir scan fails */ }

  if (principles.length === 0) return null;

  return `**Wisdom Frames (high confidence):**\n${principles.map(p => `  ${p}`).join('\n')}`;
}

/**
 * Load recent failure pattern insights.
 * Reads the 5 most recent FAILURES directories and extracts the CONTEXT.md
 * first paragraph for a compact summary of what went wrong.
 */
export function loadFailurePatterns(paiDir: string): string | null {
  const failuresDir = join(paiDir, 'MEMORY', 'LEARNING', 'FAILURES');
  if (!existsSync(failuresDir)) return null;

  const patterns: string[] = [];

  try {
    // Get month dirs sorted descending
    const months = readdirSync(failuresDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
      .map(d => d.name)
      .sort()
      .reverse();

    for (const month of months) {
      if (patterns.length >= 5) break;
      const monthPath = join(failuresDir, month);

      try {
        // Failure dirs are named timestamp_slug
        const dirs = readdirSync(monthPath, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name)
          .sort()
          .reverse();

        for (const dir of dirs) {
          if (patterns.length >= 5) break;
          const contextPath = join(monthPath, dir, 'CONTEXT.md');
          if (!existsSync(contextPath)) continue;

          try {
            const content = readFileSync(contextPath, 'utf-8');
            // Extract slug as human-readable failure description
            const slug = dir.replace(/^\d{4}-\d{2}-\d{2}-\d{6}_/, '').replace(/-/g, ' ');
            // Get date from dir name
            const dateMatch = dir.match(/^(\d{4}-\d{2}-\d{2})/);
            const date = dateMatch ? dateMatch[1] : '';
            patterns.push(`[${date}] ${slug.substring(0, 70)}`);
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip unreadable months */ }
    }
  } catch { /* skip if dir scan fails */ }

  if (patterns.length === 0) return null;

  return `**Recent Failure Patterns (avoid these):**\n${patterns.map(p => `  ${p}`).join('\n')}`;
}

/**
 * Load the most recent weekly complaint synthesis.
 * Reads MEMORY/LEARNING/SYNTHESIS/YYYY-MM/YYYY-MM-DD_weekly-patterns.md
 * (written by LearningPatternSynthesis.ts) and extracts the average rating
 * plus the top issue clusters so every session is primed with current themes.
 */
export function loadSynthesisPatterns(paiDir: string): string | null {
  const synthesisDir = join(paiDir, 'MEMORY', 'LEARNING', 'SYNTHESIS');
  if (!existsSync(synthesisDir)) return null;

  try {
    // Get month dirs sorted descending (newest first)
    const months = readdirSync(synthesisDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
      .map(d => d.name)
      .sort()
      .reverse();

    for (const month of months) {
      const monthPath = join(synthesisDir, month);

      try {
        const files = readdirSync(monthPath)
          .filter(f => f.endsWith('_weekly-patterns.md'))
          .sort()
          .reverse();

        for (const file of files) {
          try {
            const content = readFileSync(join(monthPath, file), 'utf-8');

            const avgMatch = content.match(/\*\*Average Rating:\*\*\s*([\d.]+\/10)/);
            if (!avgMatch) continue;

            // Extract numbered items under "## Top Issues"
            const topIssuesMatch = content.match(/## Top Issues\s*\n([\s\S]*?)(?:\n##|\n---|$)/);
            if (!topIssuesMatch) continue;

            const issues: string[] = [];
            const itemRegex = /^\s*(\d+)\.\s+(.+)$/gm;
            let m: RegExpExecArray | null;
            while ((m = itemRegex.exec(topIssuesMatch[1])) !== null) {
              if (issues.length >= 5) break;
              issues.push(`  ${m[1]}. ${m[2].trim()}`);
            }

            if (issues.length === 0) return null;

            return `**Current Complaint Clusters (from weekly synthesis):** Avg rating ${avgMatch[1]}\n${issues.join('\n')}`;
          } catch { /* skip unreadable files */ }
        }
      } catch { /* skip unreadable months */ }
    }
  } catch { /* skip if dir scan fails */ }

  return null;
}

export interface RatingRow { timestamp: string; rating: number; source?: string; comment?: string }

/**
 * Typed ratings only. Implicit (LLM-guessed) rows were retired 2026-10-02, and explicit
 * rows from before the parser fix that carry a comment were option picks, not ratings.
 * Exported for tests.
 */
export function summarizeTypedRatings(rows: RatingRow[], now: number): string | null {
  const typed = rows.filter(r =>
    (r.source === 'explicit' || r.source === 'user_explicit') &&
    typeof r.rating === 'number' &&
    !(r.comment && r.timestamp.slice(0, 10) < RATING_PARSER_FIXED));
  const window = (days: number) => typed.filter(r => now - Date.parse(r.timestamp) <= days * 86_400_000);
  const fmt = (rs: RatingRow[]) => rs.length ? `${(rs.reduce((a, r) => a + r.rating, 0) / rs.length).toFixed(1)}/10 (n=${rs.length})` : 'none';
  const week = window(7), month = window(30);
  // Under 3 ratings is an anecdote, not a signal (a lone bare "1" may itself be an option pick).
  if (month.length < 3) return null;
  return `**Typed ratings:** Week: ${fmt(week)} | Month: ${fmt(month)}`;
}

/** Hidden under 3 typed ratings in 30 days: no line beats an invented score. */
export function loadSignalTrends(paiDir: string): string | null {
  const path = join(paiDir, 'MEMORY', 'LEARNING', 'SIGNALS', 'ratings.jsonl');
  if (!existsSync(path)) return null;
  try {
    const rows: RatingRow[] = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.includes('explicit')) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip bad row */ }
    }
    return summarizeTypedRatings(rows, Date.now());
  } catch {
    return null;
  }
}
