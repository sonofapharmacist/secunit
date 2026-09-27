# TLDR Cron Configuration

Hermes/AGY Integration Step 2 — documents the automated TLDR harvest schedule.

## Cron Entry

```
0 9 * * 1-5 /home/<username>/.bun/bin/bun /home/<username>/.claude/PAI/TOOLS/TLDRCatchup.ts >> /home/<username>/.claude/PAI/MEMORY/OBSERVABILITY/cron.log 2>&1
```

- **Schedule:** 9:00 AM weekdays (America/Chicago)
- **Runner:** `bun` via absolute path (avoids PATH issues in cron context)
- **Log:** `PAI/MEMORY/OBSERVABILITY/cron.log`

## What TLDRCatchup.ts Does

1. Scrapes configured TLDR feeds (Tech, AI, InfoSec; Dev/DevOps/Fintech/IT/Data/Design pending)
2. Scores each item for relevance via Inference.ts (AGY backend when available)
3. Writes output to `~/.claude/PAI/MEMORY/KNOWLEDGE/TLDR/YYYY-MM/{id}.json`
4. Appends a human-review surface to `~/.claude/tldr-suggestions.md`

## Manual Run

```bash
bun ~/.claude/PAI/TOOLS/TLDRCatchup.ts
```

## Cherry-Pick Flow

1. Review `~/.claude/tldr-suggestions.md` (auto-surfaced by cron output)
2. Items worth keeping → `Skill("Knowledge", "ingest ...")` immediately
3. Items that trigger a task → add to relevant `Projects/*.md`
4. Never stage in PROJECTS_TODO.md first unless genuinely unclassified

## Feeds Status

| Feed | Status |
|------|--------|
| TLDR Tech | Live |
| TLDR AI | Live |
| TLDR InfoSec | Live |
| TLDR Dev | Pending |
| TLDR DevOps | Pending |
| TLDR Fintech | Pending |
| TLDR IT | Pending |
| TLDR Data | Pending |
| TLDR Design | Pending |

## Troubleshooting

- **Cron not firing:** check `crontab -l` and confirm entry exists; check log at `MEMORY/OBSERVABILITY/cron.log`
- **Bun not found:** cron PATH doesn't include `~/.bun/bin` — the absolute path in the entry avoids this
- **AGY auth expired:** TLDRCatchup falls back to Claude subscription path automatically
