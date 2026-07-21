---
name: VendorIntel
description: "Cybersecurity vendor and market intelligence for ES consulting work. Fans out to analyst sources (Gartner MQ, Forrester Wave, Peer Insights), practitioner sentiment (G2, PeerSpot, Reddit/security forums), funding/M&A databases, and analyst blogs. Returns structured competitive intelligence: analyst rankings, practitioner sentiment, funding status, deal-positioning guidance, and a Consulting Angle section shaped for client use. Head-to-head comparisons produce a Choose-X-when decision matrix. USE WHEN: evaluate [vendor], compare [vendor A] vs [vendor B], vendor intel, market position of [vendor], how does [vendor] compare to, where does [vendor] sit in Gartner, what do practitioners think of [vendor], is [vendor] a leader, competitive landscape for [category]. NOT FOR: general research unrelated to security vendors, people/company background checks (use Recon), academic paper search (use ArXiv)."
effort: high
context: inline
---

## Customization

**Before executing, check for user customizations at:**
`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/VendorIntel/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior.

## 🚨 MANDATORY: Voice Notification (REQUIRED BEFORE ANY ACTION)

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the VendorIntel skill to research vendor market position"}' \
  > /dev/null 2>&1 &
```

Output text:
```
Running the **VendorIntel** skill to research cybersecurity vendor intelligence...
```

# VendorIntel Skill

Cybersecurity vendor and market intelligence — shaped for ES consulting use.

## Routing

| Request type | Workflow |
|---|---|
| Single vendor — analyst position, practitioner sentiment, funding | → `Workflows/SingleVendor.md` |
| Two vendors — head-to-head comparison, decision matrix | → `Workflows/HeadToHead.md` |
| Category landscape — who are the major players, how do they rank | → `Workflows/CategoryLandscape.md` |

**Default:** If unsure, run SingleVendor. If a second vendor is named, run HeadToHead.

## Confidence Tagging (mandatory on all output)

Every factual claim must be tagged:

| Tag | Meaning |
|---|---|
| `[HIGH]` | Primary source — vendor newsroom, Gartner/Forrester report, SEC filing, verified press release |
| `[MED]` | Secondary source — analyst blog summary, trade press, Peer Insights aggregate |
| `[LOW]` | Tertiary — practitioner forum, Reddit thread, aggregated review site |
| `[UNVERIFIED]` | Claimed in research but URL/source could not be confirmed |

**Never deliver unverified URLs.** Analyst reports behind paywalls: cite the report name and date, not a guessed URL.

## Source Priority Hierarchy

1. **Tier 1 — Analyst/Authoritative:** Gartner MQ, Forrester Wave, IDC MarketScape, SEC filings, official press releases
2. **Tier 2 — Market Data:** Crunchbase, PitchBook, CB Insights (funding/M&A), Forbes Cloud 100, Peer Insights ratings
3. **Tier 3 — Practitioner:** G2, PeerSpot, Reddit (r/netsec, r/cybersecurity, r/sysadmin), vendor-specific subreddits, Hacker News threads
4. **Tier 4 — Analyst Blogs:** Dark Reading, SC Magazine, BankInfoSecurity, Krebs, vendor-agnostic analyst commentary

## References

- `References/AnalystSources.md` — known Gartner MQ categories relevant to cybersecurity, Forrester Wave schedules
- `References/VendorDirectory.md` — common vendors by category with known Gartner/Forrester positions
