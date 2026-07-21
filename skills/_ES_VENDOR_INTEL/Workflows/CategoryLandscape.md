# CategoryLandscape — Market Category Landscape Workflow

**Mode:** One security category, four parallel angles | **Output:** Who the players are, how they rank, who to evaluate

## When to Use

User asks about a category, not a specific vendor: "who are the major EDR vendors", "what's the CSPM landscape", "map out the OT security space", "who should we look at for vulnerability management".

## Step 1: Extract Category and Context

- `CATEGORY` — the security product category (e.g., "EDR/XDR", "CSPM", "OT Security", "SAST")
- `USE_CASE` — any client context (industry vertical, size, compliance requirements)

## Step 2: Craft Four Parallel Queries

**Angle 1 — Analyst landscape:**
> "[CATEGORY] Gartner Magic Quadrant Forrester Wave leaders challengers 2024 2025 market overview"

**Angle 2 — Practitioner rankings and sentiment:**
> "[CATEGORY] best vendors comparison G2 PeerSpot Reddit practitioner recommendation 2024 2025"

**Angle 3 — Market dynamics:**
> "[CATEGORY] market consolidation funding acquisitions emerging vendors 2024 2025"

**Angle 4 — Evaluation criteria:**
> "[CATEGORY] vendor evaluation criteria RFP questions what to look for buyer guide 2024 2025"

## Step 3: Launch Four Researchers in Parallel

```
Single message with 4 parallel Agent calls:

Agent(subagent_type="PerplexityResearcher", description="[CATEGORY] analyst landscape", prompt="Search for: [Angle 1 query]. List the key vendors, their Gartner/Forrester placements, and any notable positioning shifts. Tag findings [HIGH]/[MED]/[LOW].")

Agent(subagent_type="GeminiResearcher", description="[CATEGORY] practitioner rankings", prompt="Search for: [Angle 2 query]. Which vendors do practitioners actually recommend? Which ones have the best real-world track record? Any that look good on paper but disappoint in practice? Tag findings [HIGH]/[MED]/[LOW].")

Agent(subagent_type="ClaudeResearcher", description="[CATEGORY] market dynamics", prompt="Search for: [Angle 3 query]. Who has acquired whom? Who is consolidating? Any emerging challengers disrupting the incumbents? Tag findings [HIGH]/[MED]/[LOW].")

Agent(subagent_type="GrokResearcher", description="[CATEGORY] evaluation criteria", prompt="Search for: [Angle 4 query]. What are the critical evaluation criteria for this category? What do buyers consistently underweight or overlook? What traps do vendors set in RFPs? Tag findings [HIGH]/[MED]/[LOW].")
```

## Step 4: Synthesize into Structured Output

```markdown
## [CATEGORY] — Market Landscape

**Researched:** [DATE]

### Market Overview

[2-3 sentences on what this category covers and why it matters]

### Key Players

| Vendor | Analyst Position | Practitioner Sentiment | Notable |
|--------|-----------------|----------------------|---------|
| [Vendor A] | [MQ/Wave position] | [G2/PeerSpot summary] | [funding/M&A/IPO] |
| [Vendor B] | ... | ... | ... |

### Leaders (Analyst + Practitioner Consensus)

[Who shows up as strong on both axes]

### Challengers Worth Watching

[Vendors that aren't top-ranked but have strong practitioner reviews or momentum]

### Market Dynamics

[Consolidation, recent M&A, funding events, emerging disruptors]

### Evaluation Criteria for This Category

[What to look for when evaluating vendors in this space — the non-obvious criteria]

### Consulting Angle

[How to scope a vendor selection engagement in this category. What's the typical client mistake — going with the Gartner leader without evaluating fit? Underweighting integration complexity? How to run a meaningful proof-of-concept? What procurement gotchas exist (licensing traps, multi-year lock-in, professional services dependency)?]

### Sources

[Verified URLs only. Analyst reports: name + date, no guessed URLs.]
```

## Step 5: Write Output to Disk

After synthesizing, write the full output to:
```
~/vendor-intel/landscape-[category-slug]-[YYYY-MM-DD].md
```

- Create `~/vendor-intel/` if it doesn't exist (`mkdir -p ~/vendor-intel`)
- Slug = category name lowercased, spaces replaced with hyphens (e.g., `landscape-ot-security-2026-07-08.md`)
- Confirm path to user after writing: `Saved to ~/vendor-intel/[filename]`
