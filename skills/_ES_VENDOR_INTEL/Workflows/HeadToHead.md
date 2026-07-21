# HeadToHead — Vendor Comparison Workflow

**Mode:** Two named vendors, four parallel research angles | **Output:** Structured comparison + decision matrix + consulting angle

## When to Use

User names two vendors explicitly: "Armis vs Claroty", "compare CrowdStrike and SentinelOne", "how does Wiz compare to Orca".

## Step 1: Extract Vendors and Category

From the user's request, identify:
- `VENDOR_A` — first vendor named
- `VENDOR_B` — second vendor named
- `CATEGORY` — inferred market category (e.g., "CPS Protection Platforms", "EDR", "CSPM")

## Step 2: Craft Four Parallel Queries

One query per angle, optimized for source type:

**Angle 1 — Analyst positioning (Gartner/Forrester):**
> "[VENDOR_A] vs [VENDOR_B] Gartner Magic Quadrant [CATEGORY] Forrester Wave analyst positioning 2024 2025 leader challenger"

**Angle 2 — Practitioner sentiment (G2/PeerSpot/Reddit):**
> "[VENDOR_A] vs [VENDOR_B] review comparison G2 PeerSpot practitioner feedback pros cons 2024 2025"

**Angle 3 — Architecture and technical differentiation:**
> "[VENDOR_A] [VENDOR_B] technical architecture comparison [CATEGORY] deployment model differentiators wins loses"

**Angle 4 — Funding, M&A, business trajectory:**
> "[VENDOR_A] [VENDOR_B] funding valuation acquisition IPO 2024 2025 business trajectory"

## Step 3: Launch Four Researchers in Parallel

```
Single message with 4 parallel Agent calls:

Agent(subagent_type="PerplexityResearcher", description="[VENDOR_A] vs [VENDOR_B] analyst positioning", prompt="Search for: [Angle 1 query]. Focus on Gartner Magic Quadrant positioning, Forrester Wave placement, and any analyst commentary comparing these two vendors. Tag findings [HIGH]/[MED]/[LOW]. Return with source citations.")

Agent(subagent_type="GeminiResearcher", description="[VENDOR_A] vs [VENDOR_B] practitioner sentiment", prompt="Search for: [Angle 2 query]. Focus on G2, PeerSpot, Reddit r/netsec, r/cybersecurity, and practitioner forum comparisons. What do real users say each does better or worse? Tag findings [HIGH]/[MED]/[LOW].")

Agent(subagent_type="ClaudeResearcher", description="[VENDOR_A] vs [VENDOR_B] technical differentiation", prompt="Search for: [Angle 3 query]. Focus on architecture, deployment model, protocol coverage, integration ecosystem, and specific technical scenarios where each vendor wins. Tag findings [HIGH]/[MED]/[LOW].")

Agent(subagent_type="GrokResearcher", description="[VENDOR_A] vs [VENDOR_B] business trajectory", prompt="Search for: [Angle 4 query]. Focus on recent funding rounds, acquisitions, IPO status, valuation changes, leadership changes, and market momentum signals. Look for contrarian signals — is either vendor's position stronger or weaker than the headline suggests? Tag findings [HIGH]/[MED]/[LOW].")
```

## Step 4: Synthesize into Structured Output

Combine all four angles into this output structure:

---

```markdown
## [VENDOR_A] vs [VENDOR_B] — Competitive Intelligence

**Category:** [CATEGORY] | **Researched:** [DATE]

### Analyst Position

[Gartner MQ / Forrester Wave placement for each, with report name and year]
[Any mindshare, peer ratings, or ranking data — tag [HIGH]/[MED]/[LOW]]

### Architecture & Technical Differentiation

[Core architectural difference — 2-3 sentences]
[Where VENDOR_A wins technically]
[Where VENDOR_B wins technically]

### Practitioner Sentiment

**[VENDOR_A]:** [What practitioners say — strengths and complaints]
**[VENDOR_B]:** [What practitioners say — strengths and complaints]

### Business Trajectory

**[VENDOR_A]:** [Funding, valuation, M&A status, momentum]
**[VENDOR_B]:** [Funding, valuation, M&A status, momentum]

### Where Each Wins Deals

| [VENDOR_A] wins | [VENDOR_B] wins |
|---|---|
| [scenario] | [scenario] |
| [scenario] | [scenario] |

### Technical Differentiator Matrix

| Factor | [VENDOR_A] | [VENDOR_B] |
|--------|-----------|-----------|
| [factor] | [assessment] | [assessment] |
| [factor] | [assessment] | [assessment] |

### Bottom Line

**Choose [VENDOR_A] when:** [2-3 decision criteria]

**Choose [VENDOR_B] when:** [2-3 decision criteria]

### Consulting Angle

[How to frame this comparison for a client. What question is the client really asking — cost, risk, compliance, integration? Which vendor fits which buyer profile? What objections will each vendor's sales team raise, and how to respond? What's the procurement gotcha (licensing complexity, acquisition uncertainty, etc.)?]

### Sources

[Verified URLs only. Paywalled analyst reports: cite name + date, no URL.]
```

---

## Step 5: Write Output to Disk

After synthesizing, write the full output to:
```
~/vendor-intel/[vendor-a-slug]-vs-[vendor-b-slug]-[YYYY-MM-DD].md
```

- Create `~/vendor-intel/` if it doesn't exist (`mkdir -p ~/vendor-intel`)
- Slugs = vendor names lowercased, spaces replaced with hyphens (e.g., `armis-vs-claroty-2026-07-08.md`)
- Confirm path to user after writing: `Saved to ~/vendor-intel/[filename]`

## URL Verification (mandatory before delivery)

Before including any URL in Sources:
1. Confirm the URL was returned by a research agent with a citation, not inferred
2. If uncertain, omit the URL and note "[source: cite report name + date]"
3. Analyst report paywalls (Gartner.com, Forrester.com) — cite the report name only, never guess a direct link
