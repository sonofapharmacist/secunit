# TLDR Cron Configuration

Hermes/AGY Integration Step 2 — documents the automated TLDR harvest schedule.

## Status: MOTHBALLED 2026-09-27

The pipeline is off. Almost nothing consumed its output. Over its life it produced 1,564 harvested knowledge files, which were opened directly 9 times. `tldr-suggestions.md` went mostly unread after June. Items promoted to knowledge notes fell from 19 in July to 1 in September. Meanwhile each run spent about 100 agy calls from the shared AI Pro quota, and the pipeline needed repeated repair.

- The crontab line is commented out with a `# MOTHBALLED` prefix. Nothing else schedules TLDR: the Pulse `tldr-scrape` job is disabled and the Hermes job is paused.
- The code, `MEMORY/STATE/tldr-feed.jsonl`, and `MEMORY/KNOWLEDGE/TLDR/` stay in place and untouched.
- **To revive:** run `crontab -e` and remove the `# MOTHBALLED ...: ` prefix. Consider a catch-up re-scrape of late-August and September dates, which lost rows (see below).
- Need relevant news for active work? Search on demand with WebSearch or the Research skill. If a push is wanted, scope a small weekly digest filtered by project instead of reviving this.

## Cron Entry

```
0 9 * * 1-5 /home/<username>/.bun/bin/bun /home/<username>/.claude/PAI/TOOLS/TLDRCatchup.ts >> /home/<username>/.claude/PAI/MEMORY/OBSERVABILITY/cron.log 2>&1
```

- **Schedule:** 9:00 AM weekdays (America/Chicago)
- **Runner:** `bun` via absolute path (avoids PATH issues in cron context)
- **Log:** `PAI/MEMORY/OBSERVABILITY/cron.log`

## One scheduler only

This crontab entry is the only thing that runs the TLDR pipeline. Don't add a second scheduler for TLDRCatchup.ts or TLDRScraper.ts, whether it's Pulse, Hermes cron, or a systemd timer. The scraper appends to the feed, while triage and harvest rewrite the whole file, so two concurrent runs corrupt it.

Until 2026-09-27, three schedulers fired at 09:00:
- this crontab entry;
- a Hermes cron job (`tldr-scrape`, id `f9e882b233e2`, now **paused**), which timed out at 120s on all 124 of its runs;
- a Pulse job (`tldr-scrape`, now `enabled = false`).

Together they left 1904 duplicate ids in the feed, and some days lost most of their articles. The feed was deduped with a field-level merge; the backup is `MEMORY/STATE/tldr-feed.pre-dedupe-2026-09-27.jsonl`.

TLDRCatchup.ts now takes an exclusive lock (`MEMORY/STATE/tldr-catchup.lock`, holding its pid) and exits without changes if another live run holds it. A lock left by a dead pid is taken over. Before this, Catchup also re-scores up to 30 articles whose scoring failed (`reason: "parse error — defaulted"`), newest first.

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
