# Quick Research Workflow

**Mode:** Single agy query (subscription-backed, native Google Search) | **Timeout:** 30 seconds

## When to Use

- User says "quick research" or "minor research"
- Simple, straightforward queries
- Time-sensitive requests
- Just need a fast answer

## Workflow

### Step 1: Run agy research query

**Single Bash call via Inference.ts —backend antigravity:**

```bash
bun ~/.claude/PAI/TOOLS/Inference.ts --backend antigravity standard \
  "You are a concise research assistant. Search the web and return key findings. Tag each finding: [HIGH], [MED], or [LOW] confidence. Be brief and factual. No filler." \
  "Research this query and return the top findings immediately: [query]"
```

**Prompt requirements:**
- Single, well-crafted query in the user prompt
- Confidence tags on each finding
- Brief, factual — no padding

**Why agy:** Subscription-backed (zero marginal cost), native Google Search with real browser fetch, handles JS-rendered pages (Reddit, HN, Twitter, SPAs) that WebFetch breaks on. 1M context window for synthesis. Falls back to PerplexityResearcher if agy CLI is unavailable.

### Step 2: Return Results

Report findings using standard format:

```markdown
📋 SUMMARY: Quick research on [topic]
🔍 ANALYSIS: [Key findings from Perplexity]
⚡ ACTIONS: 1 Perplexity query
✅ RESULTS: [Answer]
📊 STATUS: Quick mode - 1 agent, 1 query
📁 CAPTURE: [Key facts]
➡️ NEXT: [Suggest standard research if more depth needed]
📖 STORY EXPLANATION: [3-5 numbered points - keep brief]
🎯 COMPLETED: Quick answer on [topic]
```

## Speed Target

~10-15 seconds for results
