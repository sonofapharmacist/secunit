/**
 * Prompt classifier as a cascade job (local-first cascade F4, first production job).
 *
 * Local is the 80B, not the fast tier: same quality on the workload bench
 * (prompt-classify-mode-tier: 80B 45/50, KAT 45/50) at ~5x lower latency.
 * Cloud is Haiku, matching the old Claude fallback's latency. Haiku scores lower on this
 * task (31/50), so escalation is a rescue for unusable local output, not an upgrade.
 *
 * The verifier accepts exactly what PromptProcessing can use. Before this,
 * any parseable JSON was accepted and an invalid mode was silently defaulted
 * to ALGORITHM/3, hiding classifier failures from every metric.
 */

import type { JobContract, Verdict } from '../../PAI/TOOLS/lib/cascade';

export interface ClassifierOutput {
  tab_title: string | null;
  session_name: string | null;
  mode: 'MINIMAL' | 'NATIVE' | 'ALGORITHM';
  tier: 1 | 2 | 3 | 4 | 5 | null;
  mode_reason: string | null;
}

const MODES = new Set(['MINIMAL', 'NATIVE', 'ALGORITHM']);

export function verifyClassifier(output: string): Verdict<ClassifierOutput> {
  // Same extraction Inference.ts uses for expectJson (first {...} span), so a fenced but valid answer passes.
  const m = output.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, reason: 'no JSON object' };
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m[0]);
  } catch {
    return { ok: false, reason: 'JSON does not parse' };
  }
  if (typeof o.mode !== 'string' || !MODES.has(o.mode)) return { ok: false, reason: `invalid mode: ${String(o.mode).slice(0, 20)}` };
  const tier = o.tier;
  if (o.mode === 'ALGORITHM' && !(typeof tier === 'number' && Number.isInteger(tier) && tier >= 1 && tier <= 5)) {
    return { ok: false, reason: `ALGORITHM without a 1-5 tier: ${String(tier).slice(0, 10)}` };
  }
  for (const k of ['tab_title', 'session_name', 'mode_reason'] as const) {
    if (o[k] !== undefined && o[k] !== null && typeof o[k] !== 'string') return { ok: false, reason: `${k} is not a string` };
  }
  return {
    ok: true,
    value: {
      tab_title: (o.tab_title as string | undefined) ?? null,
      session_name: (o.session_name as string | undefined) ?? null,
      mode: o.mode as ClassifierOutput['mode'],
      tier: o.mode === 'ALGORITHM' ? (tier as ClassifierOutput['tier']) : null,
      mode_reason: (o.mode_reason as string | undefined) ?? null,
    },
  };
}

export const CLASSIFIER_JOB = 'prompt-classifier';

export const classifierContract: JobContract<{ systemPrompt: string; userPrompt: string }, ClassifierOutput> = {
  job: CLASSIFIER_JOB,
  build: (i) => ({ systemPrompt: i.systemPrompt, userPrompt: i.userPrompt, expectJson: true }),
  verify: verifyClassifier,
  // 60 s matches OLLAMA_DEFAULT_TIMEOUT_MS (the old local path); 20 s matches LEVEL_CONFIG.fast.
  local: { model: 'qwen3_next_80b_a3b', timeoutMs: 60_000 },
  cloud: { level: 'fast', timeoutMs: 20_000 },
};
