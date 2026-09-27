#!/usr/bin/env bun
/**
 * PAI Backend Health Checker
 *
 * Probes all configured backends for reachability without using API keys.
 * Uses unauthenticated HTTP requests to detect endpoint availability.
 *
 * Usage: bun BackendHealth.ts
 */

interface BackendConfig {
  name: string;
  hostname: string;
  url: string;
  expectedStatus?: number;
  script: string;
  contextWindow?: string;
}

interface BackendHealth extends BackendConfig {
  reachable: boolean;
  latency: number | null;
  status: number | null;
  error: string | null;
}

const TIMEOUT_MS = 5000;

const BACKENDS: BackendConfig[] = [
  {
    name: 'Anthropic direct',
    hostname: 'api.anthropic.com',
    url: 'https://api.anthropic.com/v1/models',
    expectedStatus: 401,
    script: '(default — no switch needed)',
    contextWindow: '200K',
  },
  {
    name: 'Z.ai GLM',
    hostname: 'api.z.ai',
    url: 'https://api.z.ai/api/anthropic/v1/models',
    expectedStatus: 200,
    script: 'source ~/.claude/glm.sh',
    contextWindow: '128K (1M with glm-5.2[1m])',
  },
  {
    name: 'MiniMax M3',
    hostname: 'api.minimax.io',
    url: 'https://api.minimax.io/anthropic/v1/models',
    expectedStatus: 401,
    script: 'source ~/.claude/minimax.sh',
    contextWindow: '128K',
  },
  {
    name: 'Ollama autogen',
    hostname: 'your-ollama-host.example.com:11436',
    url: 'http://your-ollama-host.example.com:11436/api/tags',
    expectedStatus: 200,
    script: 'source ~/.claude/offline.sh',
    contextWindow: 'model-dependent',
  },
];

async function probeBackend(backend: BackendConfig): Promise<BackendHealth> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const startTime = performance.now();

  try {
    const response = await fetch(backend.url, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const latency = Math.round(performance.now() - startTime);
    const status = response.status;

    let reachable: boolean;
    if (backend.expectedStatus !== undefined) {
      reachable = status === backend.expectedStatus;
    } else {
      // Any non-5xx response means backend is reachable (401 = auth required = up)
      reachable = status < 500;
    }

    return { ...backend, reachable, latency, status, error: null };
  } catch (err) {
    clearTimeout(timeoutId);

    let error = 'UNREACHABLE';
    if (err instanceof Error) {
      if (err.name === 'AbortError') {
        error = 'TIMEOUT';
      } else if (err.message.includes('ECONNREFUSED') || err.message.includes('UNABLE TO CONNECT')) {
        error = 'CONN_REFUSED';
      } else if (err.message.includes('ETIMEDOUT') || err.message.includes('TIMED OUT')) {
        error = 'TIMEDOUT';
      } else if (err.message.includes('ENOTFOUND') || err.message.includes('DNS')) {
        error = 'DNS_FAIL';
      }
      // Always use short normalized label — never pass raw Bun error message to output
    }

    return { ...backend, reachable: false, latency: null, status: null, error };
  }
}

function formatHeader(): string {
  const name = 'Backend'.padEnd(18);
  const ctx = 'Context Window'.padEnd(28);
  const status = 'Status';
  return `    ${name}  ${ctx}  ${status}`;
}

function formatRow(health: BackendHealth): string {
  const icon = health.reachable ? '✅' : '❌';
  const name = health.name.padEnd(18);
  const ctx = health.contextWindow?.padEnd(28) ?? ''.padEnd(28);
  const statusStr = health.reachable
    ? `${String(health.latency).padStart(5)}ms  HTTP ${health.status}`
    : health.error ?? 'FAILED';
  return `${icon}  ${name}  ${ctx}  ${statusStr}`;
}

function getActiveBackend(): string {
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? '';
  if (!baseUrl) return 'Not set (defaults to Anthropic)';
  if (baseUrl.includes('anthropic.com')) return 'Anthropic direct';
  if (baseUrl.includes('z.ai')) return 'Z.ai GLM';
  if (baseUrl.includes('minimax.io')) return 'MiniMax M3';
  if (baseUrl.includes('your-ollama-host.example.com') || baseUrl.includes('11436')) return 'Ollama autogen';
  return `Unknown (${baseUrl})`;
}

function getRecommendation(results: BackendHealth[]): string {
  const anthropicUp = results.find((r) => r.name === 'Anthropic direct')?.reachable ?? false;
  if (anthropicUp) return '✓ Anthropic is up — no action needed';

  const fallbackOrder: { name: string; script: string }[] = [
    { name: 'Z.ai GLM', script: 'source ~/.claude/glm.sh' },
    { name: 'MiniMax M3', script: 'source ~/.claude/minimax.sh' },
    { name: 'Ollama autogen', script: 'source ~/.claude/offline.sh' },
  ];

  for (const { name, script } of fallbackOrder) {
    if (results.find((r) => r.name === name)?.reachable) {
      return `→ Switch to ${name}: ${script}`;
    }
  }

  return '⚠  All backends down — check network connection';
}

async function main(): Promise<void> {
  console.log('');
  console.log('PAI Backend Health Check');
  console.log('═'.repeat(86));
  console.log('');
  console.log(formatHeader());
  console.log('─'.repeat(86));

  const settled = await Promise.allSettled(BACKENDS.map(probeBackend));
  const results: BackendHealth[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { ...BACKENDS[i], reachable: false, latency: null, status: null, error: 'PROBE_CRASH' }
  );

  for (const result of results) {
    console.log(formatRow(result));
  }

  console.log('');
  console.log(`Active backend:     ${getActiveBackend()}`);
  console.log(`Recommended action: ${getRecommendation(results)}`);
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
