#!/usr/bin/env bun
/**
 * SatisfactionCapture.hook.ts - Explicit Satisfaction Rating
 *
 * PURPOSE:
 * Records ratings the principal types ("8", "3 - missed the point").
 * Implicit LLM sentiment grading was retired 2026-10-02; see main().
 *
 * TRIGGER: UserPromptSubmit
 *
 * KEY BEHAVIOR:
 * - Explicit rating (bare "8", or "3 - reason") → ratings.jsonl; under 5 → learning note; 3 or less → failure capture
 * - Anything else → nothing recorded, no model call
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { getPrincipalName } from './lib/identity';
import { getLearningCategory } from './lib/learning-utils';
import { getISOTimestamp, getPSTComponents } from './lib/time';
import { captureFailure } from '../PAI/TOOLS/FailureCapture';
import { addRatingPulse } from './lib/isa-utils';
import { exitIfAutomated } from './lib/automated-session';
import { parseExplicitRating } from './lib/explicit-rating';

// ── Types ──

interface HookInput {
  session_id: string;
  prompt?: string;
  user_prompt?: string;
  transcript_path: string;
  hook_event_name: string;
}

interface RatingEntry {
  timestamp: string;
  rating: number;
  session_id: string;
  comment?: string;
  source?: 'implicit' | 'explicit';
  sentiment_summary?: string;
  confidence?: number;
  response_preview?: string;
}


// ── Constants ──

const BASE_DIR = process.env.PAI_DIR || join(process.env.HOME!, '.claude', 'PAI');
const SIGNALS_DIR = join(BASE_DIR, 'MEMORY', 'LEARNING', 'SIGNALS');
const RATINGS_FILE = join(SIGNALS_DIR, 'ratings.jsonl');
const LAST_RESPONSE_CACHE = join(BASE_DIR, 'MEMORY', 'STATE', 'last-response.txt');

// ── Stdin Reader ──

async function readStdinWithTimeout(timeout: number = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeout);
    process.stdin.on('data', (chunk) => { data += chunk.toString(); });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// ── Cached Response ──

function getLastResponse(): string {
  try {
    if (existsSync(LAST_RESPONSE_CACHE)) return readFileSync(LAST_RESPONSE_CACHE, 'utf-8');
  } catch {}
  return '';
}

// ── System Text Detection ──

const SYSTEM_TEXT_PATTERNS = [
  /^<task-notification>/i,
  /^<system-reminder>/i,
  /^This session is being continued from a previous conversation/i,
  /^Please continue the conversation/i,
  /^Note:.*was read before/i,
];

// ── Rating Writer ──

function writeRating(entry: RatingEntry): void {
  if (!existsSync(SIGNALS_DIR)) mkdirSync(SIGNALS_DIR, { recursive: true });
  // Strip lone UTF-16 surrogates that break jq parsing (e.g. truncated emoji at slice boundary)
  const json = JSON.stringify(entry).replace(/\\ud[89a-f][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})/gi, '');
  appendFileSync(RATINGS_FILE, json + '\n', 'utf-8');
  console.error(`[SatisfactionCapture] Wrote ${entry.source} rating ${entry.rating}`);
}

// ── Low Rating Learning Capture ──

function captureLowRatingLearning(
  rating: number,
  summaryOrComment: string,
  detailedContext: string,
  source: 'explicit' | 'implicit'
): void {
  if (rating >= 5) return;
  if (!detailedContext?.trim()) return;

  const { year, month, day, hours, minutes, seconds } = getPSTComponents();
  const yearMonth = `${year}-${month}`;
  const category = getLearningCategory(detailedContext, summaryOrComment);
  const learningsDir = join(BASE_DIR, 'MEMORY', 'LEARNING', category, yearMonth);

  if (!existsSync(learningsDir)) mkdirSync(learningsDir, { recursive: true });

  const label = source === 'explicit' ? `low-rating-${rating}` : `sentiment-rating-${rating}`;
  const filename = `${year}-${month}-${day}-${hours}${minutes}${seconds}_LEARNING_${label}.md`;
  const filepath = join(learningsDir, filename);

  const tags = source === 'explicit'
    ? '[low-rating, improvement-opportunity]'
    : '[sentiment-detected, implicit-rating, improvement-opportunity]';

  const content = `---
capture_type: LEARNING
timestamp: ${year}-${month}-${day} ${hours}:${minutes}:${seconds} PST
rating: ${rating}
source: ${source}
auto_captured: true
tags: ${tags}
---

# ${source === 'explicit' ? 'Low Rating' : 'Implicit Low Rating'} Captured: ${rating}/10

**Date:** ${year}-${month}-${day}
**Rating:** ${rating}/10
**Detection Method:** ${source === 'explicit' ? 'Explicit Rating' : 'Sentiment Analysis'}
${summaryOrComment ? `**Feedback:** ${summaryOrComment}` : ''}

---

## Context

${detailedContext || 'No context available'}

---

## Improvement Notes

This response was rated ${rating}/10 by ${getPrincipalName()}. Use this as an improvement opportunity.

---
`;

  writeFileSync(filepath, content, 'utf-8');
  console.error(`[SatisfactionCapture] Captured low ${source} rating learning`);
}

// ══════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════

async function main() {
  exitIfAutomated('SatisfactionCapture');
  try {
    console.error('[SatisfactionCapture] Hook started');
    const input = await readStdinWithTimeout();
    const data: HookInput = JSON.parse(input);
    const prompt = data.prompt || data.user_prompt || '';
    const sessionId = data.session_id;

    if (!prompt || !sessionId) { process.exit(0); }

    // ── SKIP: System text ──
    if (SYSTEM_TEXT_PATTERNS.some(re => re.test(prompt.trim()))) {
      console.error('[SatisfactionCapture] System text, skipping');
      process.exit(0);
    }

    // ── FAST PATH: Explicit rating (check BEFORE length gate) ──
    const explicitResult = parseExplicitRating(prompt);
    if (explicitResult) {
      console.error(`[SatisfactionCapture] Explicit rating: ${explicitResult.rating}`);
      const lastResponse = getLastResponse();
      const entry: RatingEntry = {
        timestamp: getISOTimestamp(),
        rating: explicitResult.rating,
        session_id: sessionId,
        source: 'explicit',
      };
      if (explicitResult.comment) entry.comment = explicitResult.comment;
      if (lastResponse) entry.response_preview = lastResponse.slice(0, 500);
      writeRating(entry);

      addRatingPulse(sessionId, {
        value: explicitResult.rating,
        timestamp: Date.now(),
        message: explicitResult.comment?.slice(0, 32),
      });

      if (explicitResult.rating < 5) {
        captureLowRatingLearning(explicitResult.rating, explicitResult.comment || '', lastResponse, 'explicit');
        if (explicitResult.rating <= 3) {
          await captureFailure({
            transcriptPath: data.transcript_path,
            rating: explicitResult.rating,
            sentimentSummary: explicitResult.comment || `Explicit low rating: ${explicitResult.rating}/10`,
            detailedContext: lastResponse,
            sessionId,
          }).catch((err) => console.error(`[SatisfactionCapture] Failure capture error: ${err}`));
        }
      }
      process.exit(0);
    }

    // Implicit grading retired 2026-10-02 (GP). An LLM guessed a rating for every prompt:
    // 709 in 30 days, 55% exactly 5. Its low guesses became FAILURES at 55-63% precision,
    // and "repeated request" claims were 0/8 real (an approval of the DA's own proposal was
    // read as a repeat). Only ratings GP types are recorded now.
    // Evidence: MEMORY/LEARNING/FAILURES/precision-sample-2026-10-02.md
    process.exit(0);
  } catch (err) {
    console.error(`[SatisfactionCapture] Fatal error: ${err}`);
    process.exit(0);
  }
}

main();
