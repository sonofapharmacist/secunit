#!/usr/bin/env bun
// Reads the local aphorisms database and prints one random quote as "text|author".
// Used by statusline-command.sh as a local replacement for ZenQuotes API.

import { readFileSync } from "fs";
import { resolve } from "path";

const DB_PATH = process.env.APHORISMS_DB ??
  resolve(import.meta.dir, "../Database/aphorisms.md");

let content: string;
try {
  content = readFileSync(DB_PATH, "utf8");
} catch {
  process.exit(1);
}

const lines = content.split("\n");
const quotes: { text: string; author: string }[] = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  const qm = line.match(/^\*\*"(.+)"\*\*$/);
  if (!qm) continue;

  let text = qm[1];
  for (let j = i + 1; j < Math.min(i + 7, lines.length); j++) {
    const next = lines[j].trim();
    // Translation line: *(English translation)* — append to quote text
    const tm = next.match(/^\*\((.+)\)\*$/);
    if (tm) { text = `${text} (${tm[1]})`; continue; }
    const am = next.match(/^- Author:\s*(.+)$/);
    if (am) { quotes.push({ text, author: am[1] }); break; }
  }
}

if (quotes.length === 0) process.exit(1);

const pick = quotes[Math.floor(Math.random() * quotes.length)];
process.stdout.write(`${pick.text}|${pick.author}\n`);
