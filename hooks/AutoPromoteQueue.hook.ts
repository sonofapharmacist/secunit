#!/usr/bin/env bun
/**
 * AutoPromoteQueue.hook.ts - Auto-promote high-confidence harvest candidates
 *
 * PURPOSE:
 * Reads _harvest-queue/ after SessionHarvestMine has populated it.
 * Candidates with confidence >= MIN_CONFIDENCE are written directly to
 * MEMORY/KNOWLEDGE/Ideas/ and removed from the queue.
 * Low-confidence candidates stay in the queue for manual review.
 *
 * TRIGGER: SessionEnd
 * RUNS AFTER: SessionHarvestMine
 * THRESHOLD: 0.8 confidence (green circle in SessionHarvester output)
 *
 * Manual review of remaining queue:
 *   bun TOOLS/KnowledgeHarvester.ts harvest --source queue
 */

import * as fs from "fs";
import * as path from "path";

const MIN_CONFIDENCE = 0.8;
const PAI_DIR = process.env.PAI_DIR || path.join(process.env.HOME!, ".claude", "PAI");
const QUEUE_DIR = path.join(PAI_DIR, "MEMORY", "KNOWLEDGE", "_harvest-queue");
const KNOWLEDGE_DIR = path.join(PAI_DIR, "MEMORY", "KNOWLEDGE");

function toKebabCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function promoteCandidate(filePath: string, data: any): string {
  const domain = data.domain || "Ideas";
  const slug = toKebabCase(data.title || path.basename(filePath, ".json"));
  const targetDir = path.join(KNOWLEDGE_DIR, domain);
  const targetPath = path.join(targetDir, `${slug}.md`);

  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  if (fs.existsSync(targetPath)) return targetPath; // don't overwrite

  const today = new Date().toISOString().split("T")[0];
  const tagsStr = (data.tags || []).join(", ");

  const note = `---
title: "${(data.title || slug).replace(/"/g, '\\"')}"
type: ${data.type || "idea"}
domain: ${domain.toLowerCase()}
tags: [${tagsStr}]
confidence: ${data.confidence || MIN_CONFIDENCE}
created: ${today}
updated: ${today}
quality: 5
harvested_from: ${data.sourcePath || filePath}
---

# ${data.title || slug}

${data.content || ""}
`;

  fs.writeFileSync(targetPath, note);
  return targetPath;
}

function main() {
  if (!fs.existsSync(QUEUE_DIR)) {
    console.error("[AutoPromoteQueue] No harvest queue directory");
    process.exit(0);
  }

  const files = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith(".json"));
  if (files.length === 0) {
    process.exit(0);
  }

  let promoted = 0;
  let skipped = 0;

  for (const file of files) {
    const filePath = path.join(QUEUE_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const confidence = data.confidence ?? 0;

      if (confidence >= MIN_CONFIDENCE) {
        const notePath = promoteCandidate(filePath, data);
        fs.unlinkSync(filePath);
        console.error(`[AutoPromoteQueue] Promoted: ${path.basename(notePath)} (${(confidence * 100).toFixed(0)}%)`);
        promoted++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`[AutoPromoteQueue] Skipped malformed file: ${file}`);
    }
  }

  if (promoted > 0 || skipped > 0) {
    console.error(`[AutoPromoteQueue] ${promoted} promoted, ${skipped} left in queue for review`);
  }

  process.exit(0);
}

main();
