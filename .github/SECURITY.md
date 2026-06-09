# Security Policy

## Supported Versions

Only the latest release is maintained. Security fixes are not backported.

| Version | Supported |
|---------|-----------|
| Latest  | ✓         |
| Older   | ✗         |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting: on the Security tab, click **Report a vulnerability**. This creates a private advisory visible only to maintainers.

Include:
- Description of the vulnerability and its impact
- Steps to reproduce
- secunit version (`pai.version` in `settings.json`)
- Whether you have a proposed fix

**Response timeline:** acknowledgment within 72 hours; assessment within 7 days.

## Scope

secunit is a local Claude Code configuration — it runs on your machine, in your user account, against your Anthropic API key. The threat model is prompt injection through LLM inputs (web content, tool arguments, crafted instructions), not network-level attacks.

Reports in scope:
- Prompt injection bypasses that propagate through `SecurityPipeline.hook.ts` into tool execution
- Hook fail-open conditions (hooks that silently allow when they should block or ask)
- Personal data leaks in the `release.ts` pipeline (new identifier patterns that slip through)
- Vulnerabilities in shipped dependencies (`bun audit` findings at HIGH/CRITICAL)

Out of scope:
- Social engineering
- Physical access attacks
- Vulnerabilities in Claude Code itself or the Anthropic API (report to Anthropic)
- Theoretical attacks with no realistic exploitation path
