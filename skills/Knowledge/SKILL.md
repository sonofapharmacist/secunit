---
name: Knowledge
description: "Manage the PAI Knowledge Archive — a curated, typed graph of notes across four entity domains: People, Companies, Ideas, and Research. Operations: search (3-pass: lexical + frontmatter + wikilink), add (creates note with typed cross-links), harvest (KnowledgeHarvester pulls from PAI sources), develop (surfaces seedling notes for enrichment), ingest (fetch URL or file, create primary note, ripple updates to related notes), contradictions (find conflicting claims via tag-overlap pairs), graph (stats or 2-hop traversal via KnowledgeGraph.ts), retrieve (BM25-lite compressed context via MemoryRetriever.ts), mine (SessionHarvester extracts memory candidates from recent conversations). Notes carry typed related: frontmatter links (8 relationship types: supports, contradicts, extends, part-of, instance-of, caused-by, preceded-by, related). USE WHEN knowledge, knowledge base, search knowledge, what do we know about, archive, harvest, knowledge status, develop note, add to knowledge, ingest, contradictions, knowledge graph, graph, retrieve, mine conversations. NOT FOR session/ISA context recovery (use ContextSearch)."
argument-hint: [search|add|harvest|develop|ingest|contradictions|graph|retrieve|mine|<query>]
effort: low
context: fork
---

# Knowledge Skill

Manage the PAI Knowledge Archive at `~/.claude/PAI/MEMORY/KNOWLEDGE/`.

## Command Routing

| Input | Command | Action |
|-------|---------|--------|
| `/knowledge` (no args) | **status** | Health dashboard |
| `/knowledge <query>` | **search** | Search for notes matching query |
| `/knowledge search <query>` | **search** | Explicit search |
| `/knowledge add <type>` | **add** | Create a new note (People, Companies, or Ideas) |
| `/knowledge harvest` | **harvest** | Run KnowledgeHarvester on all sources |
| `/knowledge develop` | **develop** | Surface seedlings and enrich them |
| `/knowledge ingest <url-or-file> [--light]` | **ingest** | Read source, create note, ripple updates to related notes. `--light`: cap ripple at 3 (index rebuild always runs) |
| `/knowledge contradictions` | **contradictions** | Find and review conflicting claims across notes |
| `/knowledge graph` | **graph** | Knowledge graph stats and navigation |
| `/knowledge graph <slug>` | **graph** | Traverse graph from a note |
| `/knowledge retrieve <query>` | **retrieve** | Compressed context retrieval |
| `/knowledge mine` | **mine** | Mine recent conversations for memory candidates |

If `$ARGUMENTS` doesn't match a subcommand, treat it as a search query.

---

## status (default, no args)

Run the harvester status command and display results:

```bash
bun ~/.claude/PAI/TOOLS/KnowledgeHarvester.ts status
```

Also show:
- Quick summary of domains with note counts
- Any orphan wikilinks
- Any stale seedlings
- Time since last harvest

Present in NATIVE mode.

---

## search <query>

Search the Knowledge Archive for notes matching `$ARGUMENTS`.

**Step 1 — Lexical search:**
```bash
rg -i "$ARGUMENTS" ~/.claude/PAI/MEMORY/KNOWLEDGE/ --type md -l
```

**Step 2 — Frontmatter search (tags and titles):**
```bash
rg -i "title:.*$ARGUMENTS|tags:.*$ARGUMENTS" ~/.claude/PAI/MEMORY/KNOWLEDGE/ --type md -l
```

**Step 3 — Wikilink search:**
```bash
rg "\[\[.*$ARGUMENTS.*\]\]" ~/.claude/PAI/MEMORY/KNOWLEDGE/ --type md -l
```

Deduplicate results across all three. For each match, read the first 5 lines of frontmatter to show title, domain, status, tags.

Present results as a table:
```
| Note | Domain | Status | Tags | Relevance |
```

If no results found, say so and suggest checking the full MEMORY/ system or running a harvest.

---

## add <type>

Create a new note manually in the specified entity type.

1. Validate type is one of: People, Companies, Ideas, Research
2. Ask for a title (or use remaining args after type)
3. Generate kebab-case filename from title
4. **Search for real relations first.** Before writing the new note, grep existing Knowledge for related entities by topic/tags/name. What you find becomes the `related:` frontmatter array — 0-4 entries, however many you can actually defend. See Canonical Linking Requirement below.
5. Create the note with proper frontmatter — required fields: `title`, `type`, `tags` (min 1), `created`, `updated`, `quality` (0-10), plus type-specific body sections. The `related:` array is always present and may be empty: `related: []`.
6. Write the file to `KNOWLEDGE/<Type>/<kebab-case-title>.md` — slug max 60 chars
7. Verify every slug in `related:` exists in the archive before saving
8. Regenerate the type's MOC:
```bash
bun ~/.claude/PAI/TOOLS/KnowledgeHarvester.ts index
```

**Topic is a tag, not a type.** A security insight is an Idea with a `security` tag. A security company is a Company with a `security` tag. The entity type determines the schema; the tag determines the topic.

## Canonical Linking Requirement

**Every new Knowledge note ships with typed cross-links — what it can defend, no more.** A note with zero defensible relations ships zero, not a padded `related:`.

**Every write produces:**

1. **`related:` frontmatter array** — 0-4 typed entries linking to other Knowledge entries (any domain: People, Companies, Ideas, Research); the array is always present, its contents can be empty when nothing is defensible
2. **Body wikilinks** — 0-3 `[[slug]]` references woven into the prose where natural (Implications, Evidence, or Context sections)

**0-4 is a ceiling, not a target.** Add every relation you can defend and none that you can't. If a note genuinely connects to nothing in the archive yet, ship it with `related:` empty — an honest orphan is repairable later, a padded edge is not. A false edge is indistinguishable from a real one at retrieval time, carries identical weight in traversal, and outlives the session that invented it.

**The test for each edge:** state the mechanism in one sentence — "A raises the threshold B assumed," "A is the implementation B describes," "A's benchmark contradicts B's claim." If the best you can manage is "both are about security," that's a tag, not a relation.

**Bare `related` is a smell.** The eight types exist to force that precision. If nothing but generic `related` fits, the relation usually isn't there. Genuine exceptions: sibling artifacts from one source, and companion notes that share provenance without a directional claim.

**Candidate count is never a link target.** The ripple pass evaluates up to 10 candidates (3 under `--light`). That number measures search effort, not expected output — evaluating ten and linking one is a correct result, not an incomplete one.

**8 relationship types** (pick the most accurate, prefer specific over generic):

| Type | Meaning |
|------|---------|
| `related` | Generic association (default only if no better fit) |
| `supports` | Provides evidence for the linked note |
| `contradicts` | Conflicts with the linked note |
| `extends` | Builds upon the linked note |
| `part-of` | Component of a larger whole |
| `instance-of` | Example of a pattern |
| `caused-by` | Result of the linked note |
| `preceded-by` | Came before temporally |

**Frontmatter format:**
```yaml
related:
  - slug: other-note-slug
    type: extends
  - slug: another-note-slug
    type: supports
```

**How to find related notes before writing:**
```bash
# By topic/keyword
rg -l "TOPIC" ~/.claude/PAI/MEMORY/KNOWLEDGE/ --type md

# By tag overlap
rg "^tags:.*TAG" ~/.claude/PAI/MEMORY/KNOWLEDGE/ --type md -l

# For People/Companies — grep by name
rg -l "Person Name" ~/.claude/PAI/MEMORY/KNOWLEDGE/
```

**Enforcement:**
- Writes that skip `related:` are incomplete and must be fixed before the skill/workflow returns success
- The `ingest` workflow splits this across two steps: frontmatter links on the primary note (Step 2), reverse-direction links on the related notes (Step 4). Both are required — Step 2 alone leaves the edge dangling
- The Algorithm LEARN phase includes this in its knowledge capture step
- All agents writing Knowledge entries must follow this rule — it is part of the schema, not an optional enhancement

---

## harvest

Run the KnowledgeHarvester to pull new knowledge from all PAI sources:

```bash
bun ~/.claude/PAI/TOOLS/KnowledgeHarvester.ts harvest
```

Display results. If nothing was harvested, explain that sources are already up to date.

Optionally accept `--source` filter: `/knowledge harvest work` or `/knowledge harvest memory`.

---

## develop

The weekly gardening workflow. Surface seedling notes that are ready for enrichment.

**Step 1 — Find seedlings:**
```bash
rg "^status: seedling" ~/.claude/PAI/MEMORY/KNOWLEDGE/ --type md -l
```

**Step 2 — For each seedling:**
- Read the note
- Read related notes (follow wikilinks, search for same tags)
- Check if newer WORK/ ISAs or auto-memory entries have relevant context
- Enrich the note: add context, suggest wikilinks, flesh out content

**Step 3 — Present the diff to the user for approval.**

**Step 4 — If approved:**
- Write the updated note
- Promote status from `seedling` to `budding` (or `evergreen` if comprehensive)
- Update the `updated` date
- Regenerate affected MOCs

If no seedlings exist, report archive is clean.

---

## ingest <url-or-file> [--light]

Ingest a source into the Knowledge Archive. This is the key Karpathy-inspired upgrade: reading a source doesn't just create one note — it **ripples updates through existing related notes**.

**If no argument provided:** Show usage: `/knowledge ingest <url-or-file-path>`

**`--light` flag:** Quick-save mode for articles and short reads. Caps ripple candidates at 3 (vs 10), and does nothing else. Use for routine article saves; omit for research-grade sources where full graph integration matters.

**Auto-light detection (affects the ripple cap only):** After fetching the source, *measure* its length — do not estimate it. Write the fetched content to a temp file and run `wc -w`, or count programmatically. If the measured count is under 800, apply the `--light` ripple cap. Log the literal integer in the ripple plan header: `(auto-light: 412 words)`.

Two rules on that measurement:

- **No measurement, no cap.** If you did not actually count, treat the source as over-threshold and run the full 10-candidate ripple. The cap is an optimization; skipping it costs a little time, and wrongly applying it silently degrades the graph.
- **The justification must be an integer.** "roughly under," "in spirit," "effectively short," "about 800" are not measurements — a hedge in this slot is the tell that the count was never taken. Treat your own hedging as a signal to go measure.

**Multi-source ingests sum across every source.** Two documents of 600 words each are a 1200-word ingest, not a light one. Count the total you actually read, not the smallest piece of it.

The 800 threshold is a tunable, not a law. If you change it, grep the file for `800` and update every hit — it is stated here and restated in the Gotchas entry.

### Step 1 — Fetch the source

- **Reddit URL** (domain matches `reddit.com`): Use `agy -p <url>` via Bash. Reddit blocks headless browsers and WebFetch — `agy` is the only reliable path.
- **Other URL:** Use WebFetch to retrieve and read the content. If WebFetch fails, try `curl -sL` via Bash.
- **File path:** Use Read tool to read the local file.

Summarize the source in 2-3 sentences. Identify key entities, claims, and insights.

### Step 2 — Classify and create primary note

Determine entity type (People, Companies, Ideas, or Research). Most ingested sources become Ideas.

Create the primary note using the schema for that type:
- Generate kebab-case slug from title (max 60 chars)
- Write to `KNOWLEDGE/<Type>/<slug>.md` with proper frontmatter
- Include `source_url:` or `source_path:` in frontmatter
- **Include `related:` array with 0-4 typed links** — the ripple pass (Step 3) surfaces candidates; link the ones you can defend, per the Canonical Linking Requirement. Whatever you do link must be baked into the primary note's frontmatter at creation time, not added after

### Step 3 — Ripple pass (the key innovation)

Search for existing notes that relate to this new content:

```bash
# Search by extracted tags
rg -i "TAG1|TAG2|TAG3" ~/.claude/PAI/MEMORY/KNOWLEDGE/ --type md -l --glob '!_*'

# Search by key entities/concepts mentioned
rg -i "ENTITY1|ENTITY2" ~/.claude/PAI/MEMORY/KNOWLEDGE/ --type md -l --glob '!_*'
```

For each related note found (up to **10**, or **3** if `--light`):
1. Read the note
2. Determine if the new source adds information, context, or contradicts existing claims
3. If yes, propose the specific update (add wikilink, add evidence, note contradiction)

**Present the ripple plan to the user:**
```
📥 INGEST RIPPLE PLAN:
  PRIMARY: Ideas/new-note-slug — "Title" (created)
  PRIMARY related: frontmatter links (0–4, defensible only — examples below; ship empty when none):
    → Ideas/existing-note-1 — type: extends
    → Ideas/existing-note-2 — type: supports
    → People/person-slug — type: related
  RIPPLE (reverse-direction updates to existing notes):
    → Ideas/existing-note-1 — add body [[new-note-slug]] wikilink + add to its related: array (type: extends)
    → Ideas/existing-note-2 — update Evidence section with new data point + add to related:
    → Ideas/existing-note-3 — ⚠️ CONTRADICTION: new source says X, note says Y — type: contradicts
  NO CHANGE: Ideas/tangentially-related — mentioned same tag but no substantive connection
```

### Step 4 — Execute ripple updates

After the user approves (or you determine updates are low-risk cross-references):
- **Primary note**: `related:` frontmatter array holds 0-4 typed entries — every one defensible, none padded to reach a count
- **Related notes**: add reverse-direction `related:` entries to their frontmatter with appropriate types
- **Body wikilinks**: add `[[wikilinks]]` in existing prose where natural (not forced)
- Update `updated:` date on modified notes
- For contradictions: add a `> ⚠️ **Contradiction:** [note] claims X — see [[new-note]] for counter-evidence` callout, AND add `type: contradicts` in related: arrays

### Step 5 — Log and index

Append to `KNOWLEDGE/_log.md`:
```
## [YYYY-MM-DD] ingest | Title
- Source: <url or path>
- Primary: <Type>/<slug>
- Ripple: N notes updated, N contradictions flagged
```

Regenerate MOCs — **always, including under `--light`**:
```bash
bun ~/.claude/PAI/TOOLS/KnowledgeHarvester.ts index
```

This takes about a second and regenerates all five MOCs. Skipping it leaves the new note absent from both its domain MOC and the master index — invisible to every later lookup, with nothing downstream raising an error about it. See Gotchas for why this step is unconditional.

Present in NATIVE mode.

---

## contradictions

Find and review conflicting claims across Knowledge notes.

### Step 1 — Get contradiction candidates

Run the KnowledgeHarvester contradiction finder:
```bash
bun ~/.claude/PAI/TOOLS/KnowledgeHarvester.ts contradictions
```

This outputs pairs of notes with high tag overlap (2+ shared tags), ranked by overlap count.

### Step 2 — Semantic review

For each pair (up to 10 highest-overlap pairs):
1. Read both notes
2. Extract key claims from each (Thesis, Evidence, Key Facts sections)
3. Check for:
   - **Direct contradictions** — Note A says X, Note B says not-X
   - **Temporal supersession** — Note A's claim is outdated by Note B's newer evidence
   - **Scope conflicts** — Both claim authority on the same topic but reach different conclusions

### Step 3 — Report

Present findings:
```
🔍 CONTRADICTION SCAN:
  Pairs checked: N
  Contradictions found: N
  Superseded claims: N

  ⚠️ CONTRADICTION:
    [[note-a]] claims: "X"
    [[note-b]] claims: "Y"
    Resolution: [suggest which is correct, or flag for the user]

  📅 SUPERSEDED:
    [[older-note]] (2026-01-15): "X was true"
    [[newer-note]] (2026-03-20): "X is no longer true because Y"
    Action: Update older note with correction
```

### Step 4 — Fix (with approval)

If the user approves resolutions:
- Update contradicted notes with correction callouts
- Update superseded notes with `> 📅 **Updated:** See [[newer-note]] for current information`
- Update `updated:` dates
- Regenerate MOCs

Present in NATIVE mode.

---

## graph [slug]

Navigate the Knowledge Archive as a graph.

**No argument — stats overview:**
```bash
bun ~/.claude/PAI/TOOLS/KnowledgeGraph.ts stats
```

Show node count, edge count, top clusters, most connected hubs, and isolated nodes.

**With slug — traverse from a note:**
```bash
bun ~/.claude/PAI/TOOLS/KnowledgeGraph.ts traverse <slug> --hops 2
```

Show all notes connected within 2 hops via tags, wikilinks, and typed relationships. Useful for exploring how knowledge connects across domains.

**Related notes only:**
```bash
bun ~/.claude/PAI/TOOLS/KnowledgeGraph.ts related <slug>
```

Present in NATIVE mode.

---

## retrieve <query>

Compressed context retrieval over the Knowledge Archive using BM25-lite scoring.

```bash
bun ~/.claude/PAI/TOOLS/MemoryRetriever.ts "<query>" --top 5
```

Returns the top matching notes with compressed summaries, ranked by title match, tag overlap, and content frequency. Useful for loading relevant knowledge context without reading full files.

For raw excerpts without LLM compression:
```bash
bun ~/.claude/PAI/TOOLS/MemoryRetriever.ts "<query>" --raw
```

Present in NATIVE mode.

---

## mine

Mine recent conversations for memory candidates (decisions, preferences, milestones, problems).

```bash
bun ~/.claude/PAI/TOOLS/SessionHarvester.ts --mine --recent 10
```

Candidates are written to `KNOWLEDGE/_harvest-queue/` for review — never directly to KNOWLEDGE/. Use `/knowledge harvest` to process the queue.

For dry run (preview only):
```bash
bun ~/.claude/PAI/TOOLS/SessionHarvester.ts --mine --recent 10 --dry-run
```

Present in NATIVE mode.

---

## Gotchas

- **4 entity types now.** People (human beings), Companies (organizations), Ideas (insights/theses/analyses), Research (multi-source investigations with methodology). If it doesn't fit one of these, it's not knowledge — it belongs in WORK/ or LEARNING/.
- **Topic = tag, not domain.** A security insight is an Idea with a `security` tag. Never create topic-based folders.
- **The lookup test.** "Would the user look this up by name?" — if not, it's not knowledge.
- **Schema enforcement.** Required frontmatter fields: `title`, `type`, `tags` (min 1), `created`, `updated`, `quality` (0-10). `related:` is always present (may be empty).
- **Algorithm LEARN phase writes directly.** The LEARN phase has the best context — it writes to KNOWLEDGE/ with proper schemas. Harvester reflections are disabled.
- **Never delete notes without asking.** Pruning is automatic (90-day seedling expiry via harvester). Manual deletion requires the user's approval.
- **Quality score reflects insight value, not source length.** A 50-word blog aside that shifts a frame is quality 9. A 10,000-word paper that restates known facts is quality 4. Never anchor quality to how much you read — anchor it to how much the world looks different after reading it.
- **Wikilinks use strict kebab-case.** `[[prompt-injection]]` not `[[Prompt Injection]]`.
- **All harvested notes start as seedlings.** Only `/knowledge develop` promotes them.
- **Temporal validity is optional.** Notes can have `valid_from`/`valid_until` frontmatter fields to track when facts were true. The contradiction detector uses these to skip non-overlapping time windows.
- **Reddit requires `agy -p`.** WebFetch and Playwright MCP are blocked by Reddit's network security. Always route `reddit.com` URLs through `agy -p <url>` in Bash.
- **An empty `related:` beats a padded one.** The array used to be a mandatory 2-4, and it showed: among linked Research/Ideas notes the mode sat exactly on 4, the ceiling, with a clean decay above it — the shape of a form being filled, not relations being found. Meanwhile 79.5% of archive nodes have zero semantic edges. Padding never fixed coverage; it just made the orphan problem harder to see. Link what you can defend, ship zero when zero is true. Step 5's `KnowledgeHarvester.ts index` runs on every ingest, `--light` included. It used to be gated by `--light`, and the failure mode was not the flag but the 800-word threshold feeding it: a multi-source ingest well over the line got classified as short on a qualitative estimate ("under 800 words in spirit") rather than a measured count, and the rebuild went with it. Learn the tell — a hedged threshold claim means the count was never taken. The gate was removed rather than tightened, because a step that costs a second should never depend on model judgment at all.
- **Frontmatter `related:` is a claim; the reverse link is what makes it real.** Writing `- slug: foo / type: extends` into a new note does nothing to `foo` — Step 4's reverse-direction pass is what creates the edge. Verify after every ingest with `bun ~/.claude/PAI/TOOLS/KnowledgeGraph.ts related <new-slug>`; a relation living in only one file's frontmatter is a dangling assertion.
