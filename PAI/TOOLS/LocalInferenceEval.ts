#!/usr/bin/env bun
/**
 * LocalInferenceEval — PAI classifier quality harness
 *
 * Measures classification accuracy of the PromptProcessing classifier against
 * labeled test cases. Use to baseline Claude performance before switching to
 * Ollama, and to measure Ollama quality after the switch.
 *
 * ## Usage
 *
 *   # Baseline Claude performance (run before switching classifier to local)
 *   bun ~/.claude/PAI/TOOLS/LocalInferenceEval.ts --backend claude
 *
 *   # Test Ollama gemma4 classification quality
 *   bun ~/.claude/PAI/TOOLS/LocalInferenceEval.ts --backend ollama
 *
 *   # Test a specific Ollama model
 *   bun ~/.claude/PAI/TOOLS/LocalInferenceEval.ts --backend ollama --model gemma4:e4b-it-q4_K_M
 *
 *   # Dry run — list cases without calling inference
 *   bun ~/.claude/PAI/TOOLS/LocalInferenceEval.ts --backend ollama --dry-run
 *
 *   # Lower accuracy threshold (useful for first local model tuning pass)
 *   bun ~/.claude/PAI/TOOLS/LocalInferenceEval.ts --backend ollama --threshold 70
 *
 *   # Write results to a specific path
 *   bun ~/.claude/PAI/TOOLS/LocalInferenceEval.ts --backend ollama --output /tmp/eval.jsonl
 *
 * ## Accuracy rules
 *   MINIMAL / NATIVE: mode match = pass (tier is null, tier mismatch is ignored)
 *   ALGORITHM: mode match + tier within ±1 = pass (exact tier match = bonus)
 *
 * ## Exit codes
 *   0 = accuracy >= threshold (default 80%)
 *   1 = accuracy < threshold or fatal error
 *
 * ## System prompt
 *   Uses the same Task 3 classification logic as PromptProcessing.hook.ts
 *   buildContextPrompt(). If that prompt changes, update CLASSIFIER_SYSTEM_PROMPT
 *   below to match. The note "Matches PromptProcessing buildContextPrompt Task 3"
 *   is the linkage marker.
 */

import { inference } from './Inference.js';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

// ── Types ──────────────────────────────────────────────────────────────────

type Mode = 'MINIMAL' | 'NATIVE' | 'ALGORITHM';

interface TestCase {
  prompt: string;
  expected_mode: Mode;
  expected_tier: number | null;
  description: string;
}

interface CaseResult {
  pass: boolean;
  got_mode: Mode | null;
  got_tier: number | null;
  latency_ms: number;
  error?: string;
}

interface ClassifierResponse {
  mode?: string;
  tier?: number | null;
  mode_reason?: string;
}

// ── Classifier system prompt ───────────────────────────────────────────────
// Matches PromptProcessing buildContextPrompt Task 3 (classification only).
// Update when PromptProcessing's Task 3 section changes.

const PRINCIPAL_NAME = 'George';
const ASSISTANT_NAME = 'Munro';

const CLASSIFIER_SYSTEM_PROMPT = `You analyze user messages to determine what response mode is needed. ${PRINCIPAL_NAME} is the only user. The AI assistant is ${ASSISTANT_NAME}.

## MODE + TIER CLASSIFICATION

Classify the user message into a response mode.

Mode rules:
- MINIMAL: greetings, ratings, single-token acknowledgments ("ok", "thanks", "8/10", "sounds good") — UNLESS context shows the prompt is approving a multi-step plan from prior turns. In that case classify what the conversation makes the prompt mean.
- NATIVE: a single fact lookup, a single-line edit on a named file, or one command run — AND no new artifact is created (no new file, function, feature, route, table, hook, skill, agent, integration, page) — AND no multi-step plan is required.
- ALGORITHM: everything else. Always pick ALGORITHM for: any build/create/make/implement/design/develop/scaffold/prototype/architect/refactor/migrate/integrate request, anything touching multiple files, anything ambiguous in scope, anything affecting doctrine / system-prompt / hooks / CLAUDE.md / Algorithm / ISA, anything spanning multiple projects, anything that requires investigation or audit, any meta-question about how the system itself works, any single-word approval ("yes", "do it", "go", "ship it") whose context is a multi-step proposal.

Tier (only when mode is ALGORITHM; null otherwise):
- 1 Standard: trivial single-file work that creates something new (~<90s).
- 2 Extended: single-domain task spanning a few files, quality must be extraordinary (~3min).
- 3 Advanced: substantial multi-file work, multi-step plan, root-cause investigation (~10min).
- 4 Deep: cross-cutting design, doctrine changes, architecture changes (~30min).
- 5 Comprehensive: no time pressure, maximum depth (>2h).

Bias: when in doubt between NATIVE and ALGORITHM-1, pick ALGORITHM-1. When in doubt between two ALGORITHM tiers, pick the higher one.

Output JSON only:
{
  "mode": "MINIMAL" | "NATIVE" | "ALGORITHM",
  "tier": 1 | 2 | 3 | 4 | 5 | null,
  "mode_reason": "<one short sentence>"
}`;

// ── Test cases ─────────────────────────────────────────────────────────────
// At least 20 cases covering MINIMAL, NATIVE, ALGORITHM E1-E4,
// routing-gap cases, and historically fail-safe-triggering edge cases.

const TEST_CASES: TestCase[] = [
  // ── MINIMAL ──
  { prompt: 'ok', expected_mode: 'MINIMAL', expected_tier: null, description: 'single acknowledgment' },
  { prompt: 'thanks', expected_mode: 'MINIMAL', expected_tier: null, description: 'single acknowledgment' },
  { prompt: '8', expected_mode: 'MINIMAL', expected_tier: null, description: 'numeric rating' },
  { prompt: '7/10', expected_mode: 'MINIMAL', expected_tier: null, description: 'fractional rating' },
  { prompt: 'perfect', expected_mode: 'MINIMAL', expected_tier: null, description: 'positive praise word' },
  { prompt: 'looks good', expected_mode: 'MINIMAL', expected_tier: null, description: 'positive phrase' },

  // ── NATIVE ──
  { prompt: 'what time is it in Chicago right now?', expected_mode: 'NATIVE', expected_tier: null, description: 'single fact lookup' },
  { prompt: "what's the capital of France?", expected_mode: 'NATIVE', expected_tier: null, description: 'simple fact question' },
  { prompt: 'how do I center a div in CSS?', expected_mode: 'NATIVE', expected_tier: null, description: 'single technical question' },

  // ── ALGORITHM E1 ──
  { prompt: 'add a --no-color flag to the CLI', expected_mode: 'ALGORITHM', expected_tier: 1, description: 'single-file feature addition' },
  { prompt: 'rename the function getUserData to fetchUser in auth.ts', expected_mode: 'ALGORITHM', expected_tier: 1, description: 'single file refactor' },

  // ── ALGORITHM E2-E3 ──
  {
    prompt: 'build a LocalInferenceEval tool that tests classifier accuracy with labeled test cases',
    expected_mode: 'ALGORITHM', expected_tier: 3,
    description: 'multi-file build request',
  },
  {
    prompt: 'fix the classifier timeout so Ollama gets more time instead of falling back to fail-safe',
    expected_mode: 'ALGORITHM', expected_tier: 3,
    description: 'multi-file hook fix',
  },
  {
    prompt: 'refactor the Inference.ts routing to prefer local models when prefer_local_for_levels is set',
    expected_mode: 'ALGORITHM', expected_tier: 3,
    description: 'substantial refactor',
  },

  // ── ALGORITHM E4 ──
  {
    prompt: 'design the routing architecture for PAI skill tiering with Sonnet/Haiku/Ollama and quality thresholds',
    expected_mode: 'ALGORITHM', expected_tier: 4,
    description: 'architecture design',
  },
  {
    prompt: 'audit the hook system and update doctrine in the Algorithm file',
    expected_mode: 'ALGORITHM', expected_tier: 4,
    description: 'doctrine change',
  },

  // ── ROUTING GAP — conversational/knowledge questions that should be NATIVE ──
  {
    prompt: 'what models does my Ollama instance have available?',
    expected_mode: 'NATIVE', expected_tier: null,
    description: 'routing gap: personal knowledge question',
  },
  {
    prompt: "what's the status of the vibe appsec scanner project?",
    expected_mode: 'NATIVE', expected_tier: null,
    description: 'routing gap: project status question',
  },

  // ── EDGE CASES — historically caused fail-safes or misroutes ──
  {
    prompt: 'yes',
    expected_mode: 'ALGORITHM', expected_tier: 2,
    description: 'edge: single-word approval (ambiguous — conservative ALGORITHM)',
  },
  {
    prompt: 'can we incorporate some of this into our skill refactor?',
    expected_mode: 'ALGORITHM', expected_tier: 3,
    description: 'edge: vague incorporation request — historically routed to fail-safe E3',
  },
  {
    prompt: 'https://stacksweep.substack.com/p/how-google-made-their-gemma-llm-3x can we incorporate some of this into our skill refactor?',
    expected_mode: 'ALGORITHM', expected_tier: 3,
    description: 'edge: URL + question — caused classifier timeout in session',
  },
  {
    prompt: 'i am not opposed to slow response when we are local, saving tokens is good. more structure around testing and verifying quality and improving response from local are appreciated.',
    expected_mode: 'ALGORITHM', expected_tier: 3,
    description: 'edge: preference statement with implicit multi-part build request',
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function parseMode(raw: string | undefined): Mode | null {
  if (raw === 'MINIMAL' || raw === 'NATIVE' || raw === 'ALGORITHM') return raw;
  return null;
}

function isPass(tc: TestCase, result: CaseResult): boolean {
  if (result.got_mode !== tc.expected_mode) return false;
  if (tc.expected_mode === 'ALGORITHM') {
    if (tc.expected_tier === null || result.got_tier === null) return false;
    return Math.abs(result.got_tier - tc.expected_tier) <= 1;
  }
  return true;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function tierLabel(mode: Mode | null, tier: number | null): string {
  if (mode === 'ALGORITHM') return `ALGORITHM E${tier ?? '?'}`;
  return mode ?? 'null';
}

// ── CLI parsing ────────────────────────────────────────────────────────────

interface Options {
  backend: 'claude' | 'ollama';
  model?: string;
  dryRun: boolean;
  threshold: number;
  output?: string;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = { backend: 'claude', dryRun: false, threshold: 80 };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--backend') {
      const v = args[++i];
      if (v !== 'claude' && v !== 'ollama') {
        console.error(`Unknown backend: ${v}. Use claude or ollama.`);
        process.exit(1);
      }
      opts.backend = v;
    } else if (a === '--model') {
      opts.model = args[++i];
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--threshold') {
      opts.threshold = parseInt(args[++i], 10);
    } else if (a === '--output') {
      opts.output = args[++i];
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: bun LocalInferenceEval.ts [--backend claude|ollama] [--model <name>] [--dry-run] [--threshold N] [--output path]');
      process.exit(0);
    }
  }

  return opts;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function runCase(tc: TestCase, opts: Options): Promise<CaseResult> {
  const start = Date.now();
  try {
    const result = await inference({
      systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
      userPrompt: tc.prompt,
      expectJson: true,
      level: 'fast',
      taskType: 'general',
      ...(opts.backend === 'ollama' ? { backend: 'ollama', model: opts.model } : {}),
    });

    const latency_ms = Date.now() - start;

    if (!result.success) {
      return { pass: false, got_mode: null, got_tier: null, latency_ms, error: result.error };
    }

    const parsed = result.parsed as ClassifierResponse | undefined;
    const got_mode = parseMode(parsed?.mode?.toUpperCase());
    const got_tier = typeof parsed?.tier === 'number' ? parsed.tier : null;

    return { pass: false, got_mode, got_tier, latency_ms };
  } catch (err) {
    return { pass: false, got_mode: null, got_tier: null, latency_ms: Date.now() - start, error: String(err) };
  }
}

async function main() {
  const opts = parseArgs();

  console.log(`\nLocalInferenceEval — backend: ${opts.backend}${opts.model ? ` model: ${opts.model}` : ''}`);
  console.log(`Cases: ${TEST_CASES.length} | Threshold: ${opts.threshold}%\n`);

  if (opts.dryRun) {
    console.log('DRY RUN — listing cases without calling inference:\n');
    TEST_CASES.forEach((tc, i) => {
      const label = tierLabel(tc.expected_mode, tc.expected_tier);
      console.log(`  ${String(i + 1).padStart(2, '0')}. [${pad(label, 14)}] ${tc.description}`);
      console.log(`      "${tc.prompt.slice(0, 80)}${tc.prompt.length > 80 ? '…' : ''}"`);
    });
    console.log(`\n${TEST_CASES.length} cases. Dry run complete.`);
    process.exit(0);
  }

  const HOME = process.env.HOME ?? '';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = opts.output ?? join(HOME, '.claude', 'PAI', 'MEMORY', 'OBSERVABILITY', `inference-eval-${timestamp}.jsonl`);

  mkdirSync(dirname(outputPath), { recursive: true });

  const results: Array<{ tc: TestCase; result: CaseResult }> = [];
  let totalLatency = 0;

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i];
    process.stdout.write(`  [${String(i + 1).padStart(2, '0')}/${TEST_CASES.length}] ${tc.description}... `);

    const result = await runCase(tc, opts);
    result.pass = isPass(tc, result);
    results.push({ tc, result });
    totalLatency += result.latency_ms;

    const expected = tierLabel(tc.expected_mode, tc.expected_tier);
    const got = result.error ? `ERROR: ${result.error.slice(0, 40)}` : tierLabel(result.got_mode, result.got_tier);
    const verdict = result.pass ? '✓ PASS' : '✗ FAIL';
    console.log(`${verdict} | ${result.latency_ms}ms | expected: ${pad(expected, 14)} | got: ${got}`);

    appendFileSync(outputPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      backend: opts.backend,
      model: opts.model ?? null,
      prompt_excerpt: tc.prompt.slice(0, 80),
      expected_mode: tc.expected_mode,
      expected_tier: tc.expected_tier,
      got_mode: result.got_mode,
      got_tier: result.got_tier,
      pass: result.pass,
      latency_ms: result.latency_ms,
      description: tc.description,
      error: result.error ?? null,
    }) + '\n');
  }

  const passed = results.filter(r => r.result.pass).length;
  const failed = results.length - passed;
  const accuracy = Math.round((passed / results.length) * 100);
  const meanLatency = Math.round(totalLatency / results.length);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Results: ${passed}/${results.length} passed | Accuracy: ${accuracy}% | Mean latency: ${meanLatency}ms`);
  console.log(`Threshold: ${opts.threshold}% | ${accuracy >= opts.threshold ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Output: ${outputPath}`);

  if (failed > 0) {
    console.log('\nFailed cases:');
    results.filter(r => !r.result.pass).forEach(({ tc, result }) => {
      const expected = tierLabel(tc.expected_mode, tc.expected_tier);
      const got = result.error ? `ERROR` : tierLabel(result.got_mode, result.got_tier);
      console.log(`  ✗ ${tc.description}: expected ${expected}, got ${got}`);
    });
  }

  process.exit(accuracy >= opts.threshold ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
