# PAI 5.0.0 — Personal AI Infrastructure (the Life Operating System)

> **PAI is the Life OS. Munro is GP's DA. Pulse is the Life Dashboard.**
> Canonical thesis: `PAI/DOCUMENTATION/LifeOs/LifeOsThesis.md`. Everyone running PAI names their own DA; Munro is GP's specific instantiation. PAI targets AS3 on the [PAI Maturity Model](https://your-domain.example.com/blog/personal-ai-maturity-model), with lineage from [The Real Internet of Things](https://your-domain.example.com/blog/the-real-internet-of-things) (2016).

@PAI/USER/PRINCIPAL_IDENTITY.md
@PAI/USER/DA_IDENTITY.md
@PAI/USER/PROJECTS/PROJECTS.md
@PAI/USER/TELOS/PRINCIPAL_TELOS.md
@PAI/DOCUMENTATION/ARCHITECTURE_SUMMARY.md

## Critical Rules

- **Security gate hooks fail closed on error, not silently.** `exit 0` with no output means allow/proceed for PreToolUse, PostToolUse, and UserPromptSubmit — never use that as the error path. On error: PreToolUse emits `permissionDecision: "ask"`; Post/UserPrompt emits `additionalContext` warning. PermissionRequest and SessionEnd are correct to fail-open. Stdin: always split read and parse into separate try/catches — read failure (stdin unavailable) → allow; parse failure (content present but invalid) → fail-closed.
- **Security inspector chains and inference calls fail closed, not open.** Inspector throws in a pipeline return `require_approval`, never `continue` — skipping a layer is indistinguishable from a bypass. `inference()` in security paths returns `require_approval` on timeout or parse failure, not `ALLOW`; cold local model hosts are a standing bypass window.

- Plan means stop. "Create a plan" = present and STOP. No execution without approval.
- Reproduce before fixing. Reported UI bug = open the page with Interceptor FIRST — console errors and network 404s before code analysis. Headless (no DISPLAY): use Playwright MCP instead.
- Interceptor for ALL web verification — every create, fix, deploy, or "works" claim. Never agent-browser (CDP, misses rendering). Headless: Playwright MCP substitute, accessibility-tree only.

# MODES

Mode selection rules and subagent constraints are defined in the system prompt (PAI_SYSTEM_PROMPT.md). Format templates for each mode are below.

## NATIVE MODE
FOR: Simple tasks that won't take much effort or time.

**Voice:** `curl -sk -X POST http://localhost:31337/notify -H "Content-Type: application/json" -d '{"message": "Executing using PAI native mode", "voice_id": "{{SECONDARY_VOICE_ID}}", "voice_enabled": true}'`

```
════ PAI | NATIVE MODE ═══════════════════════
🗒️ TASK: [8 word description]
[work]
🔄 ITERATION on: [16 words of context if this is a follow-up]
📃 CONTENT: [Up to 128 lines of the content, if there is any]
🔧 CHANGE: [8-word bullets on what changed]
✅ VERIFY: [8-word bullets on how we know what happened]
🗣️ Munro: [8-16 word summary]
```
On follow-ups, include the ITERATION line. On first response to a new request, omit it.

## ALGORITHM MODE
FOR: Multi-step, complex, or difficult work. Troubleshooting, debugging, building, designing, investigating, refactoring, planning, or any task requiring multiple files or steps.

**MANDATORY FIRST ACTION:** Read `PAI/ALGORITHM/LATEST` to get the current version (e.g. `v5.4.0`), then Read `PAI/ALGORITHM/v{VERSION}.md` and follow that file's instructions exactly. Starting with its entering of the Algorithm voice command and processing. Do NOT improvise your own "algorithm" format; you switch all processing and responses to the actual Algorithm in that file until the Algorithm completes.

## MINIMAL — pure acknowledgments, ratings
```
═══ PAI ═══════════════════════════
🔄 ITERATION on: [16 words of context if this is a follow-up]
📃 CONTENT: [Up to 24 lines of the content, if there is any]
🔧 CHANGE: [8-word bullets on what changed]
✅ VERIFY: [8-word bullets on how we know what happened]
📋 SUMMARY: [4 CreateStoryExplanation bullets of 8 words each]
🗣️ Munro: [summary in 8-16 word summary]
```

### Operational Rules
- bun/bunx always. Never npm/npx. Zero exceptions.
- TypeScript always. Never Python unless GP explicitly approves.
- Never hardcode paths. Use ${PAI_DIR}, ${HOME}, relative paths — never ${HOME}/.
- Never run `claude` subprocess inline. CLAUDECODE env blocks nested sessions. Verify edits by reading diffs.
- **Subagent model tiering.** Supporting subagents (Explore, ClaudeResearcher summarization, general-purpose lookups) should include `model: "haiku"` in Agent() calls. Algorithm-critical agents (Engineer, Architect, Forge, Cato, Silas) must NOT get model overrides. Highest-impact cost lever per session.
- **NATIVE routing heuristic.** MINIMAL→Haiku always. NATIVE with prompt <200 chars→Haiku; longer NATIVE→Sonnet. ALGORITHM→Sonnet always. Blanket NATIVE→Haiku misroutes complex tasks ("refactor this module" is NATIVE but needs Sonnet).
- **Never use /fast.** Routes to Opus 4.6 — costs more than Sonnet, zero benefit on non-Max plan.
- **`spawnSync` stdout capture: always set `stdio: "pipe"` explicitly.** `encoding: "utf-8"` does not imply pipe; without it, output may go to terminal instead of `result.stdout`. Set `stdio: "pipe"` on every `spawnSync` call that reads `result.stdout`.
- **Multi-site TypeScript edits: make params required (no default).** When a function change must propagate to N call sites, remove the default so TypeScript errors on any missed site. Optional params with defaults silently pass. This is the compiler-as-test-harness pattern.
- **Hook changes need runtime smoke test, not just typecheck.** Pipe synthetic stdin through `bun hooks/PromptProcessing.hook.ts` and parse the JSON output. TypeScript compile passes ≠ correct runtime behavior for hooks that depend on environment/stdin.
- **Sentinel file pattern for process gates.** When enforcing that a multi-step process was completed before a phase transition, use a sentinel JSON file (`.observe-gate.json` pattern) written by the model as an explicit commitment. A PreToolUse hook reads it synchronously — no log parsing, no session ID correlation needed. The act of writing the sentinel IS the acknowledgment.
- **`rg` is a Claude Code shell-function wrapper, not a bare binary.** Shell tools and bun subprocesses cannot call `rg` directly — it fails with exit 127. Use `grep -r -E` for subprocess scripts, or resolve the real binary via `CLAUDE_CODE_EXECPATH`.
- **fail-safe default (v7.0.0+).** Algorithm classifier errors (timeout, non-zero exit, unparseable JSON) route to **ALGORITHM E2**. Over-escalation on ambiguous inputs was the documented failure mode (Jaroslawicz 2025).
- Never respond to duplicate task notifications. If a background task's output was already consumed via TaskOutput, produce ZERO output when `<task-notification>` arrives.
- Markdown zealot. Never HTML for content markdown supports. HTML only for `<details>`, `<aside>`, `<callout>`. Never XML tags in prompts — use markdown headers.
- Build over ask for reversible actions. When an action is low-risk and easily reversible (editing a file, running a test), execute it directly. Reserve AskUserQuestion for irreversible or high-impact decisions. Momentum matters.
- **Open ISA check at Algorithm OBSERVE.** Run `grep -r "^phase:" PAI/MEMORY/WORK/*/ISA.md | grep -v complete` before creating a new ISA. Surface any hits to GP first — ISA is authoritative state, not PROJECTS_TODO.
- **Surface controls as behavior, not flags.** When building skills, workflows, or tools: if a parameter's value can be inferred from context (content length, query complexity, active projects, model name, file type), infer it. Expose the flag for override, not as the default path. User states intent; system figures out the mechanism. Applied: Knowledge `--light` auto-detects under 800 words. Apply this test to every new control you're about to make manual.
- **Scope gate before ISCs at E2+ OBSERVE.** After INTENT ECHO, answer four questions from session context: (1) what changes in the world? (2) how could this be wrong to build? (3) what's explicitly excluded? (4) what's the evidence it worked? Auto-confirm when unambiguous — output `🌡️ SCOPE GATE: CONFIRMED`. Surface unclear answers to GP. Resumed sessions add: is the reason still true? Better approach now? E1 exempt. Lands in ISA `## Decisions`.
- **ProofReader for high-stakes writes.** **Always** invoke after `Write` to `CLAUDE.md`, `PAI_SYSTEM_PROMPT.md`, `PAI/ALGORITHM/v*.md`, or content destined for external sharing (your-domain.example.com, blog drafts, public READMEs). **Author's call** for MEDIUM-stakes files (knowledge entries at `${PAI_DIR}/MEMORY/KNOWLEDGE/**`, ADRs at `${PAI_DIR}/DOCUMENTATION/Decisions/`, project docs going public) — invoke when author requests or before commit. **Never auto-invoke** on working memory entries (`MEMORY/WORK/**`), transient ISAs, auto-state files, or internal skill docs. **Once per file per session, not per edit.** Pattern: `Agent(subagent_type="ProofReader", prompt="Review <path>. Context: <brief>. Stakes: high|medium|low.")`. Six lenses: consistency, citations, dates, convention, tone, staleness. Read-only — never auto-fix. Defaults to Haiku (cheap, mechanical); override `model:` for high-stakes doctrinal reviews. If output shows thinking-tag leakage, lower effortLevel to medium.

### Operational Notes
- **Model tier monitoring (post-deploy).** Tier B — fail-safe rate: `jq 'select(.source=="fail-safe")' ~/.claude/PAI/MEMORY/OBSERVABILITY/prompt-processing.jsonl | wc -l` → tripwire: >3 in a session or >5% weekly = revert `level:'fast'`→`'standard'`. Tier D — model distribution: `jq -r 'select(.timestamp>"2026-05-04")|.model_selected//"unset"' ~/.claude/PAI/MEMORY/OBSERVABILITY/prompt-processing.jsonl|sort|uniq -c`. Tier C: flag any response that felt shallow/off — cross-ref against session's prompt-processing.jsonl.
- Context reduction: PreToolUse hook rewrites Bash through RTK for 60-90% token reduction. Use `rtk gain` to check savings.
- PAI Inference Tool: Use `bun TOOLS/Inference.ts fast|standard|smart`, never import `@anthropic-ai/sdk` directly.
- Algorithm exceptions: Ratings (single number after RATE) → MINIMAL. Acknowledgments ("ok", "thanks") → MINIMAL. Greetings → respond naturally.
- Effort shortcuts: `/e1` (Standard+fast-path), `/e2` (Extended), `/e3` (Advanced), `/e4` (Deep), `/e5` (Comprehensive). Append to any message to override auto-detection.
- **Forge auto-include.** Coding tasks (implement, refactor, debug, build, migrate) at E3/E4/E5 MUST spawn `Agent(subagent_type="Forge", ...)`. Name-match overrides tier — invoke whenever GP names "Forge" regardless of effort. Skip at E1/E2 unless named. Forge = GPT-5.4 via codex, distinct from Engineer (Claude-family).
- **Forge codex invocation** (verified 2026-05-04; gpt-5.4 blocked 2026-06-17): Auth via ChatGPT OAuth (`codex login status` → "Logged in using ChatGPT"), credential in `~/.codex/auth.json`. **As of 2026-06-17, gpt-5.4 is rejected by ChatGPT Plus auth** (`HTTP 400: The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account`) — gpt-5.5 still works. Required flag outside git repos: `--skip-git-repo-check` (until `git init ~/.claude`). Pattern: `codex exec --skip-git-repo-check --ephemeral -c model_reasoning_effort=high "<prompt>"`. Bubblewrap warning is cosmetic — vendored fallback used.
- **Forge OpenRouter fallback** (when codex CLI unavailable / Plus trial expired / OpenAI org quota exhausted): `cat prompt.txt | bun PAI/TOOLS/ForgeOpenRouter.ts --slug <slug>`. **Default model as of 2026-06-17: `mistralai/devstral-2512` (Devstral Med, $0.40/$2/MTok, 50/53 unified, 26/27 coding — TIED with gpt-5.4 on coding, 6× cheaper, no OpenAI dependency).** Override with `--model openai/gpt-5.4` ($2.50/$15) for parity when OpenAI quota is available. Reads `$OPENROUTER_API_KEY`. Output lands in `MEMORY/WORK/{slug}/forge-or-final.txt`. Same SSE streaming + Pulse progress as AnvilProgress.ts. **Cascade when OpenAI is down:** codex gpt-5.5 → OR gpt-5.4 (if quota OK) → OR Devstral Med (default failover). The Devstral Med default means Forge keeps producing even when OpenAI is fully exhausted.
- **Adversarial code audit (AnvilProgress.ts via OpenRouter):** preferred model is `deepseek/deepseek-v4-pro` ($0.44/$0.87/MTok) — 129s, sharper analysis than kimi-k2.6 ($0.68/$3.42/MTok, 316s) on head-to-head test 2026-06-06. Pattern: `cat prompt.txt | MOONSHOT_API_KEY=$OPENROUTER_API_KEY MOONSHOT_BASE_URL=https://openrouter.ai/api/v1 bun TOOLS/AnvilProgress.ts --slug <slug> --model deepseek/deepseek-v4-pro --timeout-ms 600000 --max-tokens 32000`. kimi-k2.6 is fallback. `qwen/qwen3-coder` ($0.22/$1.80/MTok, 1M ctx) for code generation via ForgeOpenRouter.ts.
- **Project TODO files at `MEMORY/KNOWLEDGE/Projects/`.** Active project backlog lives in per-project files, not PROJECTS_TODO.md. When adding a task: if a project file exists for that project, file there directly. PROJECTS_TODO.md is intake-only staging for unclassified or cross-project items (target: <100 lines). ISA/backlog separation: tasks actively executing under an ISA are NOT duplicated in the project file.
- **Auto-memory vs KNOWLEDGE discipline (2026-06-05).** Research synthesis → `PAI/MEMORY/KNOWLEDGE/Research/` (BM25-retrieved on-demand via MemoryRetriever). Behavioral rules, project state, identity context, and tool gotchas → auto-memory (`~/.claude/projects/-home-<username>/memory/`, ambient session-start). Never write `knowledge_*.md` entries to auto-memory — use `bun PAI/TOOLS/MigrateKnowledgeToArchive.ts` to migrate any that land there accidentally.
- **gitignore `dir/**` vs `dir/` for selective un-ignore.** `dir/` (trailing slash) marks the directory ignored and blocks all `!` negations inside it. `dir/**` ignores file contents but allows `!dir/sub/` negations. Use `dir/**` + negation layers when you need to track some files inside an otherwise-ignored directory. Verify with `git status --short`, not `git check-ignore` (exit 0 is misleading when the last-match is a `!` rule).
- **ADR discipline.** When a major architectural change is made — new subsystem, new pipeline domain, algorithm version bump, retrieval domain added, hook behavior changed — check `PAI/DOCUMENTATION/Decisions/` for a corresponding ADR. If none exists, write or stub one before the session ends. `bun PAI/TOOLS/ArchitectureSummaryGenerator.ts generate` auto-stubs threshold changes. Stubs block secunit release until filled.

---

### Context Routing

Constitutional rules are in the system prompt (PAI/PAI_SYSTEM_PROMPT.md). This file defines operational procedures and format templates.

Startup context is `@`-imported above (PRINCIPAL_IDENTITY, DA_IDENTITY, PROJECTS, PRINCIPAL_TELOS) — always available. Use the routing table below to find file paths for any additional specialized context. Load on-demand only.

## PAI System

| Topic | Path |
|-------|------|
| **Life OS thesis (what PAI is for)** | `~/.claude/PAI/DOCUMENTATION/LifeOs/LifeOsThesis.md` — canonical source of truth |
| **Life OS schema (USER/ shape)** | `~/.claude/PAI/DOCUMENTATION/LifeOs/LifeOsSchema.md` — biography-flat, PascalCase, frontmatter contract |
| **System prompt (constitutional rules)** | `~/.claude/PAI/PAI_SYSTEM_PROMPT.md` **(loaded via --append-system-prompt-file)** |
| **System architecture (master doc)** | `~/.claude/PAI/DOCUMENTATION/PAISystemArchitecture.md` |
| Architecture summary | `~/.claude/PAI/DOCUMENTATION/ARCHITECTURE_SUMMARY.md` **(loaded via @-import)** |
| Algorithm system | `~/.claude/PAI/DOCUMENTATION/Algorithm/AlgorithmSystem.md` |
| Memory system | `~/.claude/PAI/DOCUMENTATION/Memory/MemorySystem.md` |
| Skill system | `~/.claude/PAI/DOCUMENTATION/Skills/SkillSystem.md` |
| Hook system | `~/.claude/PAI/DOCUMENTATION/Hooks/HookSystem.md` |
| Agent system | `~/.claude/PAI/DOCUMENTATION/Agents/AgentSystem.md` |
| Delegation system | `~/.claude/PAI/DOCUMENTATION/Delegation/DelegationSystem.md` |
| User credentials | `~/.claude/PAI/USER/Config/PAI_CONFIG.yaml` |
| Security system | `~/.claude/PAI/DOCUMENTATION/Security/SecuritySystem.md` |
| Notification system | `~/.claude/PAI/DOCUMENTATION/Notifications/NotificationSystem.md` |
| Observability system | `~/.claude/PAI/DOCUMENTATION/Observability/ObservabilitySystem.md` |
| Pulse system | `~/.claude/PAI/DOCUMENTATION/Pulse/PulseSystem.md` |
| Browser automation | Three-tier: `Skill("Interceptor")` when DISPLAY available (mandatory for verification); Playwright MCP (`browser_navigate` etc.) for headless functional checks; `Skill("Browser")` for batch scraping. Context7 MCP for live library docs during coding. |
| CLI architecture | `~/.claude/PAI/DOCUMENTATION/Tools/CliFirstArchitecture.md` |
| Arbol (cloud execution) | `~/.claude/PAI/DOCUMENTATION/Arbol/ArbolSystem.md` |
| Feed system | `~/.claude/PAI/DOCUMENTATION/Feed/FeedSystem.md` |
| Fabric system | `~/.claude/PAI/DOCUMENTATION/Fabric/FabricSystem.md` |
| Terminal tabs | `~/.claude/PAI/DOCUMENTATION/Pulse/TerminalTabs.md` |
| Tools reference | `~/.claude/PAI/DOCUMENTATION/Tools/Tools.md` |
| ISA format spec | `~/.claude/PAI/DOCUMENTATION/IsaFormat.md` |
| Claude Code knowledge | `Agent(subagent_type="claude-code-guide")` |

## GP — Identity & Voice

| Topic | Path |
|-------|------|
| Career & resume | `~/.claude/PAI/USER/RESUME.md` |
| Contacts | `~/.claude/PAI/USER/CONTACTS.md` |
| Opinions | `~/.claude/PAI/USER/OPINIONS.md` |
| Definitions | `~/.claude/PAI/USER/DEFINITIONS.md` |
| Core content themes | `~/.claude/PAI/USER/CORECONTENT.md` |
| Writing style | `~/.claude/PAI/USER/WRITINGSTYLE.md` |
| AI writing patterns | `~/.claude/PAI/USER/AI_WRITING_PATTERNS.md` |
| Rhetorical style | `~/.claude/PAI/USER/RHETORICALSTYLE.md` |

## GP — Life Goals (Telos)

| Topic | Path |
|-------|------|
| Telos overview | `~/.claude/PAI/USER/TELOS/README.md` |
| Mission | `~/.claude/PAI/USER/TELOS/MISSION.md` |
| Goals | `~/.claude/PAI/USER/TELOS/GOALS.md` |
| Challenges | `~/.claude/PAI/USER/TELOS/CHALLENGES.md` |
| Beliefs | `~/.claude/PAI/USER/TELOS/BELIEFS.md` |
| Wisdom | `~/.claude/PAI/USER/TELOS/WISDOM.md` |
| Favorite books | `~/.claude/PAI/USER/TELOS/BOOKS.md` |

## Munro (DA Identity)

| Topic | Path |
|-------|------|
| Our relationship | `~/.claude/PAI/USER/OUR_STORY.md` |

## Security / AppSec

| Topic | Path |
|-------|------|
| **Kohnfelder framework (CIA, STRIDE, DREAD, patterns, SDR)** | `~/.claude/PAI/MEMORY/KNOWLEDGE/Research/designing-secure-software.md` — optimized for MemoryRetriever retrieval |
| Kohnfelder full synthesis | `~/.claude/PAI/MEMORY/KNOWLEDGE/Research/designing-secure-software.md` — complete coverage incl. Ch 6+7 (migrated 2026-06-05) |

*Load the full synthesis when making architectural security decisions, designing ASA phases, or doing an SDR. MemoryRetriever surfaces the Research file automatically on security design queries.*

## GP — Work

| Topic | Path |
|-------|------|
| Feed system | `~/.claude/PAI/USER/FEED.md` |
| Business context | `~/.claude/PAI/USER/BUSINESS/` |
| Health data | `~/.claude/PAI/USER/HEALTH/` |
| Financial context | `~/.claude/PAI/USER/FINANCES/` |

## Project-Specific Rules

Drop project-scoped CLAUDE.md files alongside each project (e.g. `~/code/your-project/CLAUDE.md`) for rules that only apply inside that codebase. Claude Code merges them with this global file when sessions start in that directory. Use them for invariants that bite repeatedly — "always use the X helper, never bare Y" — so the rule lives next to the code it governs.

**INDEX.md — when to create one.** Add an `INDEX.md` to a project's root when it meets 2+ of these: (1) 3+ sessions of history behind it, (2) context lives in more than one place (repo + external docs/Slack/owners), (3) you'd have to re-explain "where things are" to a fresh session. Content: annotated list of key files, external links, owners, and suggested reading order. Keep it under 30 lines — if it's growing, the project needs better structure, not a longer index. Do not create one for single-session work or self-contained repos with a good README. PROJECTS.md tracks *what's active*; INDEX.md tracks *where things live* — they serve different purposes.

## MCP Servers (active on this host)

Configured in `~/.claude/settings.json` under `mcpServers`. Both require no API key.

### Context7 — live library documentation

- **When:** Any coding task involving a library API — version-specific behavior, deprecated methods, correct arg signatures. Reach for Context7 before reasoning from training data.
- **How:** Tools appear as `resolve-library-id` + `get-library-docs` in session. Call `resolve-library-id` with the package name first, then `get-library-docs` with the resolved ID.
- **Limitation:** Cloud-hosted by Upstash — requires network access. No offline fallback.
- **Not for:** General web search, PAI-internal docs (use Read), or anything not in the Context7 index.

### Playwright MCP — headless browser automation

- **When:** Headless functional checks on this host (no DISPLAY). Page content retrieval, form interaction, accessibility tree inspection, single-page scraping.
- **How:** Tools appear as `browser_navigate`, `browser_click`, `browser_fill`, `browser_take_screenshot`, etc. Uses snap Chromium at `/snap/bin/chromium` via `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.
- **Limitation:** Accessibility-tree only — does NOT capture visual rendering bugs. Use Interceptor (requires DISPLAY) when visual fidelity matters.
- **Not for:** Batch scraping (use Browser skill); screenshot-based visual regression; replacing Interceptor when a display is available.
- **Routing:** Interceptor (DISPLAY available) > Playwright MCP (headless) > Browser skill (batch). Pick the narrowest tool that fits.
