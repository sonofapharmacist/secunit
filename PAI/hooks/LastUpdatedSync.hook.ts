#!/usr/bin/env bun
/**
 * LastUpdatedSync.hook.ts — PostToolUse entry point
 *
 * After Edit/Write/MultiEdit on any file under PAI/USER/, refreshes
 * `last_updated:` frontmatter and `> Last updated:` body header to today.
 *
 * TRIGGER: PostToolUse (matcher: Edit, Write, MultiEdit)
 * WIRING:  settings.json → hooks.PostToolUse[].command points here
 */

import { readFileSync, writeFileSync } from 'fs';

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: {
    file_path?: string;
    [key: string]: unknown;
  };
  tool_result?: unknown;
}

function main(): void {
  let input: HookInput;

  try {
    const raw = readFileSync('/dev/stdin', 'utf-8');
    if (!raw.trim()) return;
    input = JSON.parse(raw) as HookInput;
  } catch {
    return;
  }

  const filePath = input?.tool_input?.file_path;
  if (!filePath || typeof filePath !== 'string') return;

  const home = process.env.HOME;
  if (!home) return;
  const userMarker = '/PAI/USER/';
  if (!filePath.includes(userMarker)) return;

  const today = new Date().toLocaleDateString('en-CA');

  let original: string;
  try {
    original = readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }

  let updated = original.replace(
    /^last_updated: \d{4}-\d{2}-\d{2}/m,
    `last_updated: ${today}`,
  );
  updated = updated.replace(
    /^> Last updated: \d{4}-\d{2}-\d{2}/m,
    `> Last updated: ${today}`,
  );

  if (updated === original) return;

  try {
    writeFileSync(filePath, updated, 'utf-8');
  } catch (err) {
    console.error(`LastUpdatedSync: write failed for ${filePath}:`, err);
  }
}

try {
  main();
} catch (err) {
  console.error('LastUpdatedSync: unexpected error:', err);
}

process.exit(0);
