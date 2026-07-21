# SingleVendor — Single Vendor Intelligence Workflow

**Mode:** One vendor, four parallel research angles | **Output:** Full vendor profile + consulting angle

## When to Use

User asks about a single vendor: "evaluate CrowdStrike", "where does Wiz sit in Gartner", "what do people think of Tenable", "vendor intel on SentinelOne".

## Step 1: Extract Vendor and Category

From the user's request, identify:
- `VENDOR` — the vendor being evaluated
- `CATEGORY` — inferred market category (e.g., "EDR/XDR", "CSPM", "Vulnerability Management")
- `CONTEXT` — any client or use-case context the user provided

## Step 2: Craft Four Parallel Queries

**Angle 1 — Analyst positioning:**
> "[VENDOR] Gartner Magic Quadrant [CATEGORY] Forrester Wave analyst positioning leader challenger 2024 2025"

**Angle 2 — Practitioner sentiment:**
> "[VENDOR] review G2 PeerSpot Reddit cybersecurity practitioner experience pros cons complaints 2024 2025"

**Angle 3 — Competitive positioning and differentiators:**
> "[VENDOR] competitive differentiation [CATEGORY] wins loses compared to competitors strengths weaknesses"

**Angle 4 — Business trajectory:**
> "[VENDOR] funding valuation acquisition IPO revenue ARR growth 2024 2025 business momentum"

## Step 3: Launch Four Researchers in Parallel

```
Single message with 4 parallel Agent calls:

Agent(subagent_type="PerplexityResearcher", description="[VENDOR] analyst positioning", prompt="Search for: [Angle 1 query]. Return Gartner/Forrester placement, any analyst ratings, and relevant report names and dates. Tag findings [HIGH]/[MED]/[LOW].")

Agent(subagent_type="GeminiResearcher", description="[VENDOR] practitioner sentiment", prompt="Search for: [Angle 2 query]. Focus on what practitioners actually experience day-to-day — deployment complexity, support quality, false positive rates, integration pain points. Tag findings [HIGH]/[MED]/[LOW].")

Agent(subagent_type="ClaudeResearcher", description="[VENDOR] competitive position", prompt="Search for: [Angle 3 query]. What does [VENDOR] do better than alternatives? Where do they lose deals? What's their actual differentiator vs. their marketing claim? Tag findings [HIGH]/[MED]/[LOW].")

Agent(subagent_type="GrokResearcher", description="[VENDOR] business trajectory", prompt="Search for: [Angle 4 query]. Look for funding events, valuation signals, M&A activity, executive changes, and any contrarian signals about momentum or risk. Is this vendor's position stronger or weaker than it appears? Tag findings [HIGH]/[MED]/[LOW].")
```

## Step 4: Synthesize into Structured Output

```markdown
## [VENDOR] — Vendor Intelligence

**Category:** [CATEGORY] | **Researched:** [DATE]

### Analyst Position

[Gartner MQ / Forrester Wave placement, year, report name]
[Peer Insights rating if available]
[Any notable analyst cautions or strengths called out]

### What They Do

[2-3 sentence description of core product and differentiated value]

### Strengths

[Bullet list — practitioner-validated, tagged [HIGH]/[MED]/[LOW]]

### Weaknesses / Watch-outs

[Bullet list — practitioner-validated, tagged [HIGH]/[MED]/[LOW]]

### Competitive Position

[Where they win and lose vs. the category leaders]
[Specific competitors they beat and where they get beaten]

### Business Trajectory

[Funding status, valuation, M&A, IPO timing, revenue/ARR if known]
[Momentum signal — growing, plateauing, at risk]

### Consulting Angle

[How to position this vendor to a client. What buyer profile fits this vendor best? What's the procurement gotcha? Is this a safe enterprise bet or a riskier specialist buy? What questions should a client ask in a vendor evaluation? What does the vendor's sales team oversell?]

### Sources

[Verified URLs only. Paywalled analyst reports: cite report name + date, no URL.]
```

## Step 5: Write Output to Disk

After synthesizing, write the full output to:
```
~/vendor-intel/[vendor-slug]-[YYYY-MM-DD].md
```

- Create `~/vendor-intel/` if it doesn't exist (`mkdir -p ~/vendor-intel`)
- Slug = vendor name lowercased, spaces replaced with hyphens (e.g., `crowdstrike-2026-07-08.md`)
- Confirm path to user after writing: `Saved to ~/vendor-intel/[filename]`

## URL Verification (mandatory before delivery)

Before including any URL:
1. Confirm the URL was returned by a research agent with an explicit citation
2. Analyst reports (Gartner.com, Forrester.com) — cite report name and date only, never guess a URL
3. Mark any claim whose source URL could not be verified as `[UNVERIFIED]`
