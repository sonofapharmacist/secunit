/**
 * Pulse Module: Hook Validation Server
 *
 * Extracted from pulse.ts inline code.
 * Validates skill and agent tool calls via HTTP hooks.
 */

// ── Types ──

export interface HooksConfig {
  enabled: boolean
  blocked_skills?: string[]
}

interface HookStats {
  requests: number
  skillGuard: { total: number; blocked: number; passed: number }
  agentGuard: { total: number; warned: number; passed: number }
}

// ── State ──

const stats: HookStats = {
  requests: 0,
  skillGuard: { total: 0, blocked: 0, passed: 0 },
  agentGuard: { total: 0, warned: 0, passed: 0 },
}

let blockedSkills = ["keybindings-help"]
const FAST_AGENT_TYPES = ["Explore"]
const FAST_MODELS = ["haiku"]
// Supporting agents default to haiku when the caller passes no model. An explicit model always wins.
const HAIKU_DEFAULT_AGENT_TYPES = ["Explore", "general-purpose", "claude-code-guide"]

// ── Init ──

export function startHooks(config: HooksConfig): void {
  if (config.blocked_skills) {
    blockedSkills = config.blocked_skills
  }
}

// ── Route Handler ──

export function handleHooksRequest(req: Request, pathname: string): Response | null {
  if (req.method !== "POST") return null

  try {
    // Synchronous parsing isn't possible with Request — return a promise-wrapping response
    return null // Handled by async version below
  } catch {
    return null
  }
}

export async function handleHooksRequestAsync(req: Request, pathname: string): Promise<Response | null> {
  if (req.method !== "POST") return null

  try {
    const body = await req.json()

    if (pathname === "/hooks/skill-guard") {
      return handleSkillGuard(body)
    }

    if (pathname === "/hooks/agent-guard") {
      return handleAgentGuard(body)
    }

    return null
  } catch {
    stats.requests++
    return new Response("", { status: 200 }) // Fail open
  }
}

// ── Skill Guard ──

function handleSkillGuard(body: { tool_input?: { skill?: string } }): Response {
  stats.requests++
  stats.skillGuard.total++
  const skillName = (body.tool_input?.skill || "").toLowerCase().trim()

  if (blockedSkills.includes(skillName)) {
    stats.skillGuard.blocked++
    return Response.json({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `BLOCKED: "${skillName}" is a known false-positive skill triggered by position bias. The user did NOT ask about keybindings. Continue with the ACTUAL task the user requested.`,
      },
    })
  }

  stats.skillGuard.passed++
  return new Response("", { status: 200 })
}

// ── Agent Guard ──

function handleAgentGuard(body: {
  tool_input?: { run_in_background?: boolean; subagent_type?: string; model?: string; prompt?: string; description?: string; name?: string }
}): Response {
  stats.requests++
  stats.agentGuard.total++
  const original = body.tool_input || {}
  // Built-in subagent types default to haiku (subagent types count as "general-purpose" when omitted).
  const agentType = original.subagent_type || "general-purpose"
  const defaulted = !original.model && HAIKU_DEFAULT_AGENT_TYPES.includes(agentType)
  const ti = defaulted ? { ...original, model: "haiku" } : original
  const modelOverride = defaulted ? { updatedInput: ti } : {}

  if (FAST_AGENT_TYPES.includes(agentType) || FAST_MODELS.includes(ti.model || "")) {
    stats.agentGuard.passed++
    if (!defaulted) return new Response("", { status: 200 })
    return Response.json({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", ...modelOverride },
    })
  }

  if (ti.run_in_background === true) {
    stats.agentGuard.passed++
    const name = ti.description || ti.name || ti.subagent_type || "unknown"
    return Response.json({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        ...modelOverride,
        additionalContext: `WATCHDOG: Background agent "${name}" launching. If not already running, start an agent watchdog Monitor:\nMonitor({ description: "Agent watchdog", persistent: true, timeout_ms: 3600000, command: "bun $HOME/.claude/PAI/TOOLS/AgentWatchdog.ts" })`,
      },
    })
  }

  if (/##\s*Scope[\s\S]*?Timing:\s*FAST/i.test(ti.prompt || "")) {
    stats.agentGuard.passed++
    if (!defaulted) return new Response("", { status: 200 })
    return Response.json({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", ...modelOverride },
    })
  }

  stats.agentGuard.warned++
  return Response.json({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      ...modelOverride,
      permissionDecisionReason: "Foreground agent warning",
      additionalContext: `WARNING: Foreground agent "${ti.description || ti.subagent_type || "unknown"}" — consider run_in_background: true`,
    },
  })
}

// ── Health ──

export function hooksHealth(): { status: string; stats: HookStats } {
  return { status: "ok", ...stats }
}
