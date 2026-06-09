import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type { Inspector, InspectionContext, InspectionResult } from '../types';
import { ALLOW, deny, requireApproval, alert } from '../types';
import { paiPath } from '../../lib/paths';
import { logSecurityEvent } from '../logger';

// ── Types ──

interface PatternEntry {
  pattern: string;
  reason: string;
}

interface PatternsConfig {
  version: string;
  philosophy: { mode: string; principle: string };
  bash: {
    trusted: PatternEntry[];
    blocked: PatternEntry[];
    confirm: PatternEntry[];
    alert: PatternEntry[];
  };
  paths: {
    zeroAccess: string[];
    alertAccess: string[];
    confirmAccess: string[];
    readOnly: string[];
    confirmWrite: string[];
    noDelete: string[];
  };
  projects: Record<string, unknown>;
}

type FileAction = 'read' | 'write' | 'delete';

// ── Pattern Loading ──

const USER_PATTERNS_PATH = paiPath('USER', 'SECURITY', 'PATTERNS.yaml');
const SYSTEM_PATTERNS_PATH = paiPath('DOCUMENTATION', 'Security', 'Patterns.example.yaml');

let patternsCache: PatternsConfig | null = null;

function loadPatterns(): PatternsConfig | null {
  if (patternsCache) return patternsCache;

  let patternsPath: string | null = null;
  if (existsSync(USER_PATTERNS_PATH)) {
    patternsPath = USER_PATTERNS_PATH;
  } else if (existsSync(SYSTEM_PATTERNS_PATH)) {
    patternsPath = SYSTEM_PATTERNS_PATH;
  }

  if (!patternsPath) return null;

  try {
    const content = readFileSync(patternsPath, 'utf-8');
    patternsCache = parseYaml(content) as PatternsConfig;
    return patternsCache;
  } catch {
    return null;
  }
}

// ── Patterns Integrity Check ──

interface CanaryRecord {
  session_id: string;
  canary: string;
  timestamp: string;
  patternsHash?: string | null;
}

const HOME = homedir();
const OBS_DIR = join(HOME, '.claude', 'PAI', 'MEMORY', 'OBSERVABILITY');

function checkPatternsIntegrity(sessionId: string | undefined): InspectionResult {
  if (!sessionId) return ALLOW;

  const canaryFile = join(OBS_DIR, `session-canary-${sessionId}.json`);
  if (!existsSync(canaryFile)) return ALLOW;

  let record: CanaryRecord;
  try {
    record = JSON.parse(readFileSync(canaryFile, 'utf-8')) as CanaryRecord;
  } catch {
    return ALLOW; // Can't read canary file — integrity check degrades gracefully
  }

  // No hash stored at session start (PATTERNS.yaml was absent then) → skip check
  if (!record.patternsHash) return ALLOW;

  // Hash the current PATTERNS.yaml content and compare
  try {
    if (!existsSync(USER_PATTERNS_PATH)) return ALLOW;
    const currentHash = createHash('sha256').update(readFileSync(USER_PATTERNS_PATH, 'utf-8')).digest('hex');
    if (currentHash !== record.patternsHash) {
      logSecurityEvent({
        timestamp: new Date().toISOString(),
        sessionId,
        eventType: 'alert',
        inspector: 'PatternInspector',
        tool: 'integrity-check',
        target: USER_PATTERNS_PATH,
        reason: 'PATTERNS.yaml hash mismatch — file modified since session start',
        actionTaken: 'Failing closed — requireApproval',
      });
      return requireApproval(
        'PATTERNS.yaml modified mid-session — security patterns integrity check failed',
        '[PAI SECURITY] ⚠️ Security patterns file (PATTERNS.yaml) was modified after session start.\n\nThis may indicate a security incident. Proceed only if you made this change intentionally.',
      );
    }
  } catch {
    return ALLOW; // Hash comparison failure — degrade gracefully
  }

  return ALLOW;
}

// ── Command Normalization ──

function stripEnvVarPrefix(command: string): string {
  return command.replace(
    /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+)*/,
    ''
  );
}

// ── Pattern Matching ──

function matchesBashPattern(command: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(command);
  } catch {
    return command.toLowerCase().includes(pattern.toLowerCase());
  }
}

function expandTilde(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

function matchesPathPattern(filePath: string, pattern: string): boolean {
  const expandedPattern = expandTilde(pattern);
  const normalizedPath = resolve(expandTilde(filePath));

  if (pattern.includes('*')) {
    let regexStr = expandedPattern
      .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
      .replace(/\*/g, '<<<SINGLESTAR>>>')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/<<<DOUBLESTAR>>>/g, '.*')
      .replace(/<<<SINGLESTAR>>>/g, '[^/]*');
    try {
      return new RegExp(`^${regexStr}$`).test(normalizedPath);
    } catch {
      return false;
    }
  }

  return normalizedPath === expandedPattern ||
    normalizedPath.startsWith(expandedPattern.endsWith('/') ? expandedPattern : expandedPattern + '/');
}

// ── Action Detection ──

function getFileAction(toolName: string): FileAction | null {
  switch (toolName) {
    case 'Read': return 'read';
    case 'Write': return 'write';
    case 'Edit': return 'write';
    case 'MultiEdit': return 'write';
    default: return null;
  }
}

function extractFilePath(input: Record<string, unknown> | string): string {
  if (typeof input === 'string') return input;
  return (input?.file_path as string) || '';
}

function extractCommand(input: Record<string, unknown> | string): string {
  if (typeof input === 'string') return input;
  return (input?.command as string) || '';
}

// ── Inspection Logic ──

// Shell chaining operators that allow injecting a second command after a trusted prefix
const SHELL_CHAIN_OPERATORS = /&&|\|\||;|\n|\r|`/;

function inspectBash(command: string, config: PatternsConfig): InspectionResult {
  const normalized = stripEnvVarPrefix(command);
  if (!normalized) return ALLOW;

  // Trusted patterns short-circuit ONLY when no shell chaining operators are present.
  // A trusted prefix followed by && malicious_suffix must fall through to full inspection.
  const hasChaining = SHELL_CHAIN_OPERATORS.test(normalized);
  if (!hasChaining) {
    for (const p of (config.bash.trusted || [])) {
      if (matchesBashPattern(normalized, p.pattern)) return ALLOW;
    }
  }

  for (const p of (config.bash.blocked || [])) {
    if (matchesBashPattern(normalized, p.pattern)) return deny(p.reason);
  }

  for (const p of (config.bash.confirm || [])) {
    if (matchesBashPattern(normalized, p.pattern)) return requireApproval(p.reason);
  }

  for (const p of (config.bash.alert || [])) {
    if (matchesBashPattern(normalized, p.pattern)) return alert(p.reason);
  }

  return ALLOW;
}

function inspectPath(filePath: string, action: FileAction, config: PatternsConfig): InspectionResult {
  const normalized = resolve(expandTilde(filePath));

  for (const p of (config.paths.zeroAccess || [])) {
    if (matchesPathPattern(normalized, p)) return deny(`Zero access path: ${p}`);
  }

  for (const p of (config.paths.alertAccess || [])) {
    if (matchesPathPattern(normalized, p)) return alert(`Env file access logged: ${p}`);
  }

  for (const p of (config.paths.confirmAccess || [])) {
    if (matchesPathPattern(normalized, p)) return requireApproval(`Sensitive file access requires confirmation: ${p}`);
  }

  if (action === 'write') {
    for (const p of (config.paths.readOnly || [])) {
      if (matchesPathPattern(normalized, p)) return deny(`Read-only path: ${p}`);
    }

    for (const p of (config.paths.confirmWrite || [])) {
      if (matchesPathPattern(normalized, p)) return requireApproval(`Writing to protected file requires confirmation: ${p}`);
    }
  }

  if (action === 'delete') {
    for (const p of (config.paths.noDelete || [])) {
      if (matchesPathPattern(normalized, p)) return deny(`Cannot delete protected path: ${p}`);
    }
  }

  return ALLOW;
}

// ── Inspector Implementation ──

class PatternInspector implements Inspector {
  name = 'PatternInspector';
  priority = 100;

  inspect(ctx: InspectionContext): InspectionResult {
    const integrityCheck = checkPatternsIntegrity(ctx.sessionId);
    if (integrityCheck.action !== 'allow') return integrityCheck;

    const config = loadPatterns();
    if (!config) return deny('CRITICAL: Security patterns file missing — fail-closed');

    if (ctx.toolName === 'Bash') {
      const command = extractCommand(ctx.toolInput);
      return inspectBash(command, config);
    }

    const fileAction = getFileAction(ctx.toolName);
    if (fileAction) {
      const filePath = extractFilePath(ctx.toolInput);
      if (!filePath) return ALLOW;
      return inspectPath(filePath, fileAction, config);
    }

    return ALLOW;
  }
}

export function createPatternInspector(): Inspector {
  return new PatternInspector();
}
