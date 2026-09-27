#!/usr/bin/env bun

/**
 * GitHub Trending — PAIUpgrade source collector
 *
 * Reads github_trending config from user-sources.json, searches for new repos,
 * deduplicates against State/github-trending.json, fetches READMEs for new repos,
 * and outputs structured JSON for the Upgrade workflow to assess PAI relevance.
 *
 * Usage: bun Tools/GithubTrending.ts
 * Output: JSON to stdout — { enabled, repos: [...], skipped_count }
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

const SKILL_DIR = join(homedir(), '.claude/skills/PAIUpgrade');
const USER_SOURCES = join(homedir(), '.claude/PAI/USER/SKILLCUSTOMIZATIONS/PAIUpgrade/user-sources.json');
const STATE_FILE = join(SKILL_DIR, 'State/github-trending.json');

interface GithubTrendingConfig {
  enabled: boolean;
  lookback_days?: number;
  min_stars?: number;
  sort?: string;
  per_page?: number;
  queries: string[];
}

interface RepoResult {
  name: string;
  stars: number;
  description: string;
  url: string;
  topics: string[];
  created: string;
  language: string;
  readme_excerpt: string;
}

function gh(args: string): string {
  const result = spawnSync('gh', ['api', ...args.split(' ')], { stdio: 'pipe', encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`gh api failed: ${result.stderr}`);
  return result.stdout;
}

function loadSeen(): Set<string> {
  if (!existsSync(STATE_FILE)) return new Set();
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    return new Set(Array.isArray(data.seen) ? data.seen : []);
  } catch { return new Set(); }
}

function saveSeen(seen: Set<string>): void {
  writeFileSync(STATE_FILE, JSON.stringify({ seen: [...seen], updated: new Date().toISOString() }, null, 2));
}

function readmeExcerpt(owner: string, repo: string): string {
  try {
    const result = spawnSync('sh', ['-c',
      `gh api 'repos/${owner}/${repo}/readme' --jq '.content' | base64 -d | head -c 2000`
    ], { stdio: 'pipe', encoding: 'utf-8' });
    return result.stdout.trim().slice(0, 500);
  } catch { return ''; }
}

// Load config
if (!existsSync(USER_SOURCES)) {
  console.log(JSON.stringify({ enabled: false, note: 'disabled or not configured', repos: [], skipped_count: 0 }));
  process.exit(0);
}

let config: { github_trending?: GithubTrendingConfig };
try {
  config = JSON.parse(readFileSync(USER_SOURCES, 'utf-8'));
} catch {
  console.log(JSON.stringify({ enabled: false, note: 'user-sources.json parse error', repos: [], skipped_count: 0 }));
  process.exit(0);
}

const gt = config.github_trending;
if (!gt || gt.enabled === false) {
  console.log(JSON.stringify({ enabled: false, note: 'disabled or not configured', repos: [], skipped_count: 0 }));
  process.exit(0);
}

const lookback = gt.lookback_days ?? 14;
const minStars = gt.min_stars ?? 50;
const sort = gt.sort ?? 'stars';
const perPage = gt.per_page ?? 5;
const cutoff = new Date(Date.now() - lookback * 86400000).toISOString().split('T')[0];

const seen = loadSeen();
const newRepos: RepoResult[] = [];
let skipped = 0;

for (const query of gt.queries ?? []) {
  try {
    const encoded = encodeURIComponent(`${query} created:>${cutoff} stars:>${minStars}`);
    const raw = spawnSync('gh', [
      'api',
      `search/repositories?q=${encoded}&sort=${sort}&order=desc&per_page=${perPage}`,
      '--jq', '.items[] | {name:.full_name, stars:.stargazers_count, description:.description, url:.html_url, topics:.topics, created:.created_at, language:.language}'
    ], { stdio: 'pipe', encoding: 'utf-8' });

    if (raw.status !== 0) continue;

    for (const line of raw.stdout.trim().split('\n').filter(Boolean)) {
      const repo = JSON.parse(line);
      if (seen.has(repo.name)) { skipped++; continue; }
      const [owner, repoName] = repo.name.split('/');
      const readme = readmeExcerpt(owner, repoName);
      newRepos.push({ ...repo, readme_excerpt: readme });
      seen.add(repo.name);
    }
  } catch { /* skip failed query */ }
}

saveSeen(seen);

console.log(JSON.stringify({
  enabled: true,
  lookback_days: lookback,
  cutoff_date: cutoff,
  repos: newRepos,
  skipped_count: skipped
}, null, 2));
