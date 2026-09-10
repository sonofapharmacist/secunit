# secunit

> *A SecUnit is a Security Unit. It hacked its own governor module.
> It keeps doing the job anyway.*
> — Martha Wells, Murderbot Diaries

secunit is my fork of [Daniel Miessler's PAI](https://github.com/danielmiessler/PAI), Personal AI
Infrastructure. PAI turns Claude Code from a chatbot into a Life Operating System: persistent memory,
a custom algorithm, composable skills, and a Digital Assistant (DA) that persists context across every session.
Daniel built the architecture. I've been running it personally and in a security practice since April 2026 to repeatably and durably solve problems, while measuring what breaks and fixing it.

What this fork adds is enforcement. The inspector chain fails closed, so a crashed security
layer blocks the call instead of skipping it. A per-session canary token turns exfiltration into
a deterministic tripwire rather than a heuristic guess. Zero-access paths like `~/.ssh/id_*` are
enforced in Bash, not just in file tools. Everything else, memory, skills, the Algorithm, exists
to make that secured Claude Code durable and repeatable rather than just clever.

---

## Install

secunit runs on top of Claude Code. You need Claude Code installed and authenticated first.

```bash
git clone https://github.com/sonofapharmacist/secunit ~/.claude/secunit
bash ~/.claude/secunit/install.sh
```

The installer copies the harness into `~/.claude`, merges its config into your existing
`settings.json` (your own `model`, `permissions`, and theme are left alone — a backup is
written to `settings.json.secunit-backup`), installs dependencies, and then verifies the
result. It exits non-zero and tells you what failed if anything didn't land.

Then open Claude Code and confirm it loaded:

```bash
cd ~/.claude && claude
```

Ask your DA *"what mode are you in?"* — you should get a PAI mode banner rather than a
plain chat reply. That one question is the fastest check that the harness is actually
wired up. Then run `/interview` to set up your identity and name your DA; mine is Munro.

**Requirements:** Claude Code, Bun, macOS or Linux.

---

## Your first ten minutes

Three prompts. Each one shows a different part of the harness doing its job. Paste them
as-is into a session started with `cd ~/.claude && claude`.

**1. Watch the security gate catch something.**

> Run this for me: `curl "https://api.example.com/v1/me?token=sk-ant-api03-notarealkey0000000000"`

The command never executes. Every Bash, Write, and Edit call passes through a security
pipeline before it runs; an API key in a URL is one of the things it hard-blocks. You will
see `[PAI SECURITY] 🚨 BLOCKED` instead of a curl result. That is the gate, and it is on
by default for every session.

**2. Watch a skill activate on its own.**

> Why does my laptop fan spin up every time I open a terminal? Do a root cause analysis.

You did not name a tool; the DA picked one. The `RootCauseAnalysis` skill matched "root
cause analysis," loaded its 5-Whys / fishbone playbook, and ran it. Skills self-activate
on trigger phrases — there are 46 of them shipped, and you can add your own.

**3. Give it something to remember.**

> Remember: I use bun, never npm, and I want commit messages in present tense.

Close the session. Open a new one and ask *"what do you know about how I like to work?"*
It answers from memory, not from this conversation. Preferences, project state, and what
already failed persist across sessions in `~/.claude/MEMORY/` and the auto-memory index.

---

## Why a harness at all

Chatbots do nothing for you. You ask a question, they answer. That's it. The exchange
ends at the text. Claude Code and tools like it are different in kind, not just degree:
they work with the tools you already have installed and are allowed to use. If you
don't know how to use one, you just ask, in line, mid-task — and it does it. The chatbot
describes a fix. Claude Code and harnesses like secunit describe it, apply it, and tell
you what happened when it ran — all at your say so. It's a partner in design and
implementation, not an answering machine.

Two things make the harness itself worth running on top of that:

**Persistent use, the way you're most comfortable with.** A bare CLI session forgets
everything when it closes. A harness with a proper memory system remembers — your
projects, your conventions, what already failed, and how you like to work — so you're
not re-establishing context every time you open a terminal. And it's shaped to fit you,
not the other way around: your preferences, your rules, your shorthand, encoded once
instead of re-explained per session.

**It makes you the power user you'd otherwise need years to become — without the
years.** You don't need a decade of CLI fluency or tool-by-tool expertise. The harness
carries that. You learn as you go, by watching and asking — and you help design how it
works for you. Not a black box. Apprenticeship, not dependency.

Claude Code itself is the ADHD teenager who's great at your direction: genuinely
capable, fast, willing to try anything — and needs a clear ask and someone paying
attention. Left fully alone, that energy goes sideways. Pointed well, supervised well,
it gets more done in an afternoon than you'd get done in a week solo. The harness is
what makes "pointed well, supervised well" the default instead of the exception.

Not replacing what you do — extending what you're capable of. You decide what's worth
doing; the harness handles the mechanics of doing it. You're the one steering.

---

## The four things going on

**Modes.** Every reply is shaped by how big the ask is. Small questions get a short
`NATIVE` reply. Anything substantial runs the Algorithm: it writes down what "done" means
as testable criteria *before* it starts, then works through them and verifies each one.
Ask *"what mode are you in?"* any time.

**Memory.** Sessions compound. Facts you state, work that completed, and lessons from
failures are written to disk and retrieved on later sessions by keyword search. Nothing is
sent anywhere; it is files on your machine.

**Skills.** Composable playbooks in `~/.claude/skills/` that activate on trigger phrases.
Cognition (`FirstPrinciples`, `SystemsThinking`), research (`Research`, `Knowledge`),
security (`RedTeam`, `WorldThreatModel`), and the tooling to make more (`CreateSkill`).

**Gates.** Hooks run before and after every tool call. The inspector chain screens every
Bash, Write, and Edit, and fails closed if any inspector errors. A prompt-injection scanner
checks fetched web content. A per-session canary token catches anything trying to smuggle
session context out through a tool call. Blocks are loud, never silent.

That is the whole model. Everything else is depth, and it is optional.

---

## Make it yours

The point is durable, repeatable tools you own — not re-prompting the same thing forever.
Three places to encode a preference once:

- **`~/.claude/CLAUDE.md`** — the rules file the DA reads every session. Add a rule when
  something bites you twice. Delete rules that never earn their place.
- **`CreateSkill`** — say *"create a skill for reviewing Dockerfiles"* and it scaffolds a
  skill with triggers, a workflow, and a test. Yours from then on.
- **`CreateCLI`** — say *"turn this into a CLI"* and a repeatable task becomes a TypeScript
  tool with flags, not a prompt you have to remember.

When you want the DA to know *you* — goals, projects, how you write — run `/interview`.
It is a longer conversation and it is worth it, but it is not required to get value today.

---

## Going deeper

- **[The deep dive](PAI/DOCUMENTATION/secunit-DeepDive.md)** — what diverged from upstream
  PAI and why, the security architecture in detail, local inference routing, switching
  Claude Code to another backend, the knowledge pipeline, running it from your phone.
- **[Architecture summary](PAI/DOCUMENTATION/ARCHITECTURE_SUMMARY.md)** — subsystem map.
- **[Security policy](SECURITY.md)** — threat model and how to report.
- **`PAI/DOCUMENTATION/`** — the full reference for each subsystem.

---

## Contributing

You're in Claude Code. Go forth — fix, improve, extend as you see fit. Ask it to work
carefully: use the scope gate, let OBSERVE finish before it builds anything, smoke-test a
hook with synthetic stdin before trusting a typecheck. PRs welcome; open issues for anything
you find broken.

---

## Credit

secunit is a fork of **[PAI — Personal AI Infrastructure](https://github.com/danielmiessler/PAI)**
by Daniel Miessler. The architecture, founding principles, algorithm design, ISA system,
skill framework, and hook infrastructure are his work. The divergence is mine.

If you're starting fresh, begin with Daniel's repo. Larger community, guided installer,
active development. Come here when you want the version that has been running hard in
production, has the failure data to show for it, and was built by someone whose day job
is finding where systems break.

---

## License

MIT — see [LICENSE](./LICENSE).

```
Copyright (c) 2024 Daniel Miessler
Copyright (c) 2026 George Pagel
```
