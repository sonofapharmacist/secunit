import { existsSync, readFileSync } from "fs";
import { join } from "path";

export type Tier = 'fast' | 'standard' | 'smart';

const VALID_TIERS: ReadonlySet<Tier> = new Set<Tier>(['fast', 'standard', 'smart']);

function resolveHomeDirectory(): string {
  return process.env.HOME || process.env.USERPROFILE || '';
}

export function resolveRoutingManifestPath(): string {
  return join(
    resolveHomeDirectory(),
    '.claude',
    'PAI',
    'USER',
    'Config',
    'inference-routing.yaml',
  );
}

export function resolveSkillRoutingManifestPath(): string {
  return join(
    resolveHomeDirectory(),
    '.claude',
    'PAI',
    'USER',
    'Config',
    'skill-routing.yaml',
  );
}

export interface SkillRoutingPreference {
  tier?: Tier;
  modelHints?: string[];
}

interface SkillRoutingEntry {
  name: string;
  tier?: Tier;
  modelHints?: string[];
}

let SKILL_ROUTING_CACHE: Map<string, SkillRoutingEntry> | undefined;
let SKILL_ROUTING_CACHE_PATH: string | undefined;

function parseSkillRoutingManifest(rawText: string, manifestPath: string): Map<string, SkillRoutingEntry> {
  const entries = new Map<string, SkillRoutingEntry>();
  const lines = rawText.split(/\r?\n/);

  let inSkills = false;
  let inDescriptionBlock = false;
  let descriptionBaseIndent = -1;
  let current: SkillRoutingEntry | undefined;
  let inHints = false;

  const commitCurrent = (): void => {
    if (current && current.name) {
      entries.set(current.name, current);
    }
    current = undefined;
    inHints = false;
  };

  for (const rawLine of lines) {
    const indent = countIndentation(rawLine);
    const stripped = stripInlineComment(rawLine).trimEnd();
    const trimmed = stripped.trim();

    if (trimmed.length === 0) {
      continue;
    }

    // Handle multi-line block scalars (description: |) — skip until indent drops.
    if (inDescriptionBlock) {
      if (indent > descriptionBaseIndent) {
        continue;
      }
      inDescriptionBlock = false;
      descriptionBaseIndent = -1;
    }

    if (indent === 0) {
      if (trimmed === 'skills:') {
        inSkills = true;
        commitCurrent();
        continue;
      }
      // Top-level block scalar like "description: |"
      if (trimmed.endsWith(': |')) {
        inDescriptionBlock = true;
        descriptionBaseIndent = indent;
        continue;
      }
      inSkills = false;
      commitCurrent();
      continue;
    }

    if (!inSkills) {
      continue;
    }

    // List item start: "- name: ..."
    if (trimmed.startsWith('- ')) {
      commitCurrent();
      current = { name: '' };
      inHints = false;
      const after = trimmed.slice(2).trim();
      const kv = splitYamlKeyValue(after);
      if (kv && kv.key === 'name') {
        current.name = unquoteScalar(kv.value);
      }
      continue;
    }

    if (!current) {
      continue;
    }

    // model_hints array items
    if (inHints && trimmed.startsWith('- ')) {
      const hint = unquoteScalar(trimmed.slice(2).trim());
      if (hint.length > 0) {
        current.modelHints = current.modelHints || [];
        current.modelHints.push(hint);
      }
      continue;
    }

    const kv = splitYamlKeyValue(trimmed);
    if (!kv) {
      continue;
    }

    inHints = false;

    if (kv.key === 'name') {
      current.name = unquoteScalar(kv.value);
    } else if (kv.key === 'preferred_tier') {
      const tier = unquoteScalar(kv.value);
      if (VALID_TIERS.has(tier as Tier)) {
        current.tier = tier as Tier;
      } else {
        throw new Error(
          `Malformed skill routing manifest: invalid preferred_tier "${tier}" for skill "${current.name}" in ${manifestPath}`,
        );
      }
    } else if (kv.key === 'model_hints') {
      const value = kv.value.trim();
      if (value === '' || value === '[]') {
        current.modelHints = [];
        inHints = value === '';
      } else if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim();
        if (inner.length === 0) {
          current.modelHints = [];
        } else {
          current.modelHints = inner
            .split(',')
            .map((part) => unquoteScalar(part.trim()))
            .filter((part) => part.length > 0);
        }
      } else {
        // block-list form
        current.modelHints = [];
        inHints = true;
      }
    }
    // Other keys (e.g. description) are ignored.
  }

  commitCurrent();
  return entries;
}

function loadSkillRoutingCache(manifestPath: string): Map<string, SkillRoutingEntry> {
  if (SKILL_ROUTING_CACHE && SKILL_ROUTING_CACHE_PATH === manifestPath) {
    return SKILL_ROUTING_CACHE;
  }

  if (!existsSync(manifestPath)) {
    SKILL_ROUTING_CACHE = new Map();
    SKILL_ROUTING_CACHE_PATH = manifestPath;
    return SKILL_ROUTING_CACHE;
  }

  const raw = readFileSync(manifestPath, 'utf-8');
  SKILL_ROUTING_CACHE = parseSkillRoutingManifest(raw, manifestPath);
  SKILL_ROUTING_CACHE_PATH = manifestPath;
  return SKILL_ROUTING_CACHE;
}

/** @internal Test-only: clear the in-process cache so manifests reload on next read. */
export function _resetSkillRoutingCache(): void {
  SKILL_ROUTING_CACHE = undefined;
  SKILL_ROUTING_CACHE_PATH = undefined;
}

/**
 * Look up routing preferences for a named skill from skill-routing.yaml.
 *
 * - Returns {} when the manifest is missing or the skill is not registered.
 * - Logs to stderr at debug level (no throw) on unknown skills, mirroring
 *   the soft-fail behavior of getTierForModel().
 */
export function getSkillRoutingPreference(
  skillName: string,
  manifestPath: string = resolveSkillRoutingManifestPath(),
): SkillRoutingPreference {
  if (!skillName) {
    return {};
  }

  const cache = loadSkillRoutingCache(manifestPath);
  const entry = cache.get(skillName);

  if (!entry) {
    if (process.env.PAI_DEBUG_ROUTING) {
      console.error(`[tier-inference] Unknown skill "${skillName}" in ${manifestPath}`);
    }
    return {};
  }

  const result: SkillRoutingPreference = {};
  if (entry.tier) {
    result.tier = entry.tier;
  }
  if (entry.modelHints && entry.modelHints.length > 0) {
    result.modelHints = [...entry.modelHints];
  }
  return result;
}

export function inferTierFromLatency(coldStartMs: number): Tier {
  if (!Number.isFinite(coldStartMs) || Number.isNaN(coldStartMs) || coldStartMs < 0) {
    throw new Error(`Invalid cold-start latency: ${String(coldStartMs)}`);
  }

  if (coldStartMs < 500) {
    return 'fast';
  }

  return 'standard';
}

function stripInlineComment(line: string): string {
  if (line.trimStart().startsWith('#')) {
    return '';
  }
  const commentIndex = line.search(/\s#/);
  if (commentIndex === -1) {
    return line;
  }
  return line.slice(0, commentIndex);
}

function countIndentation(line: string): number {
  let indent = 0;
  while (indent < line.length && line[indent] === ' ') {
    indent += 1;
  }
  return indent;
}

function unquoteScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitYamlKeyValue(line: string): { key: string; value: string } | null {
  let braceDepth = 0;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '{') {
      braceDepth += 1;
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (char !== ':' || braceDepth !== 0) {
      continue;
    }

    const nextChar = line[index + 1];
    if (nextChar === undefined || /\s/.test(nextChar)) {
      return {
        key: line.slice(0, index).trim(),
        value: line.slice(index + 1).trim(),
      };
    }
  }

  return null;
}

function parseTierScalar(value: string, context: string): Tier {
  const tier = unquoteScalar(value);
  if (VALID_TIERS.has(tier as Tier)) {
    return tier as Tier;
  }
  throw new Error(`Malformed routing manifest: invalid tier "${tier}" for ${context}`);
}

function parseInlineTier(value: string, context: string): Tier {
  const tierMatch = value.match(/(?:^|[,{]\s*)tier\s*:\s*([^,}]+)\s*(?=,|})/);
  if (!tierMatch) {
    throw new Error(`Malformed routing manifest: missing tier for ${context}`);
  }
  return parseTierScalar(tierMatch[1], context);
}

export function loadRoutingManifest(manifestPath: string = resolveRoutingManifestPath()): Map<string, Tier> {
  if (!existsSync(manifestPath)) {
    throw new Error(`Routing manifest not found: ${manifestPath}`);
  }

  const raw = readFileSync(manifestPath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const modelTiers = new Map<string, Tier>();
  const discoveredModels = new Set<string>();
  let inDecisionLogicBlock = false;
  let inModelsSection = false;
  let currentModelName: string | undefined;

  for (const rawLine of lines) {
    const indent = countIndentation(rawLine);
    const trimmedLine = stripInlineComment(rawLine).trimEnd();
    const trimmed = trimmedLine.trim();

    if (trimmed.length === 0) {
      continue;
    }

    if (inDecisionLogicBlock) {
      if (indent > 0) {
        continue;
      }
      inDecisionLogicBlock = false;
    }

    if (indent === 0 && trimmed === 'decision_logic: |') {
      inDecisionLogicBlock = true;
      inModelsSection = false;
      currentModelName = undefined;
      continue;
    }

    if (indent === 0) {
      if (trimmed === 'models:') {
        inModelsSection = true;
        currentModelName = undefined;
        continue;
      }

      inModelsSection = false;
      currentModelName = undefined;
      continue;
    }

    if (!inModelsSection) {
      continue;
    }

    if (indent === 2) {
      const keyValue = splitYamlKeyValue(trimmed);
      if (!keyValue) {
        throw new Error(`Malformed routing manifest: invalid model entry "${trimmed}"`);
      }

      currentModelName = keyValue.key;
      discoveredModels.add(currentModelName);

      if (keyValue.value.length === 0) {
        continue;
      }

      if (!keyValue.value.startsWith('{')) {
        throw new Error(`Malformed routing manifest: unsupported model mapping for ${currentModelName}`);
      }

      modelTiers.set(currentModelName, parseInlineTier(keyValue.value, currentModelName));
      continue;
    }

    if (indent > 2 && currentModelName) {
      const keyValue = splitYamlKeyValue(trimmed);
      if (!keyValue) {
        continue;
      }
      if (keyValue.key === 'tier') {
        modelTiers.set(currentModelName, parseTierScalar(keyValue.value, currentModelName));
      }
    }
  }

  if (!inModelsSection && discoveredModels.size === 0 && modelTiers.size === 0) {
    throw new Error(`Malformed routing manifest: no models section found in ${manifestPath}`);
  }

  const modelsMissingTier = [...discoveredModels].filter((model) => !modelTiers.has(model));
  if (modelsMissingTier.length > 0) {
    throw new Error(
      `Malformed routing manifest: missing tier for model(s): ${modelsMissingTier.join(', ')}`,
    );
  }

  if (modelTiers.size === 0) {
    throw new Error(`Malformed routing manifest: no model tiers found in ${manifestPath}`);
  }

  return modelTiers;
}
