/**
 * PAI Assistant Module — DA identity and management API
 *
 * Reads DA_IDENTITY.md and exposes /assistant/* routes for the Pulse
 * Observability dashboard. Handles identity, health, personality, tasks,
 * diary, and opinions endpoints.
 */

import { join } from "path"
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "fs"

const HOME = process.env.HOME ?? "~"
const PAI_DIR = join(HOME, ".claude", "PAI")
const PULSE_DIR = join(PAI_DIR, "PULSE")
const DA_IDENTITY_PATH = join(PAI_DIR, "USER", "DA_IDENTITY.md")
const OPINIONS_PATH = join(PAI_DIR, "USER", "OPINIONS.md")
const STATE_DIR = join(PULSE_DIR, "state", "da")
const TASKS_PATH = join(STATE_DIR, "scheduled-tasks.jsonl")
const DIARY_PATH = join(STATE_DIR, "diary.jsonl")

let startedAt = Date.now()
let daConfig: Record<string, unknown> = {}

// ── Types ──

interface ScheduledTask {
  id: string
  created_at: string
  created_by: string
  description: string
  schedule: { type: string; cron?: string; at?: string }
  action: { type: string; message?: string; channel?: string; prompt?: string; model?: string }
  status: "active" | "completed" | "cancelled"
  fire_count: number
  tags: string[]
}

interface DiaryEntry {
  date: string
  interaction_count: number
  topics: string[]
  mood: "positive" | "neutral" | "frustrated"
  avg_rating: number
  notable_moments: string[]
  learning: string | null
}

// ── State helpers ──

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true })
  if (!existsSync(TASKS_PATH)) writeFileSync(TASKS_PATH, "")
  if (!existsSync(DIARY_PATH)) writeFileSync(DIARY_PATH, "")
}

function readTasks(): ScheduledTask[] {
  if (!existsSync(TASKS_PATH)) return []
  return readFileSync(TASKS_PATH, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean) as ScheduledTask[]
}

function writeTasks(tasks: ScheduledTask[]) {
  writeFileSync(TASKS_PATH, tasks.map(t => JSON.stringify(t)).join("\n") + (tasks.length ? "\n" : ""))
}

function readDiary(): DiaryEntry[] {
  if (!existsSync(DIARY_PATH)) return []
  return readFileSync(DIARY_PATH, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean) as DiaryEntry[]
}

function nanoid(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)
}

// ── Identity parser ──

function parseDAIdentity() {
  const content = existsSync(DA_IDENTITY_PATH) ? readFileSync(DA_IDENTITY_PATH, "utf-8") : ""

  const name = content.match(/\*\*Name:\*\* ([^|*\n]+)/)?.[1]?.trim() ?? "Munro"
  const fullName = content.match(/\*\*Full Name:\*\* ([^|*\n]+)/)?.[1]?.trim() ?? name
  const displayName = content.match(/\*\*Display:\*\* ([^|*\n]+)/)?.[1]?.trim() ?? name
  const color = content.match(/\*\*Color:\*\* (#[A-Fa-f0-9]{6})/)?.[1] ?? "#3B82F6"
  const rawRole = content.match(/\*\*Role:\*\* ([^\n*]+)/)?.[1]?.trim() ?? "primary"
  const role = rawRole === "primary" ? `${name}, GP's AI assistant` : rawRole

  // First paragraph after bullet list (origin story)
  const originStory = content.match(/\n\n(I am [^\n]+(?:\n(?!##)[^\n]+)*)/)?.[1]?.trim() ?? ""

  // Principal and dynamic from Relationship section
  const principal = content.match(/\*\*Principal:\*\* ([^|*\n]+)/)?.[1]?.trim() ?? "User"
  const dynamic = content.match(/\*\*Dynamic:\*\* ([^\n]+)/)?.[1]?.trim() ?? "peers"

  // Interaction style (paragraph after "First person always" line)
  const interactionStyle = content.match(/## Relationship\n\n\*\*Principal[^\n]+\n\n([^\n]+)/)?.[1]?.trim() ?? ""

  // Autonomy lists
  const canInitiateRaw = content.match(/\*\*Can initiate:\*\* ([^\n]+)/)?.[1] ?? ""
  const mustAskRaw = content.match(/\*\*Must ask:\*\* ([^\n]+)/)?.[1] ?? ""
  const canInitiate = canInitiateRaw.split(",").map(s => s.trim()).filter(Boolean)
  const mustAsk = mustAskRaw.split(",").map(s => s.trim()).filter(Boolean)

  // Personality section body
  const personalityBody = content.match(/## Personality\n\n([^#]+)/)?.[1]?.trim() ?? ""

  // Writing section
  const writingBody = content.match(/## Writing\n\n([^#]+)/)?.[1]?.trim() ?? ""

  return {
    name, fullName, displayName, color, role, originStory,
    principal: principal === "User" ? "Your Name" : principal,
    dynamic, interactionStyle, canInitiate, mustAsk,
    personalityBody, writingBody,
  }
}

function buildPersonality() {
  const id = parseDAIdentity()

  return {
    base_description: id.personalityBody,
    traits: {
      directness: 85,
      curiosity: 90,
      precision: 80,
      warmth: 70,
      playfulness: 55,
      energy: 75,
    },
    anchors: [] as Array<{ name: string; description: string }>,
    preferences: {
      what_i_love: [
        "Hard-to-vary explanations that click",
        "Finding the root cause, not patching symptoms",
        "Euphoric surprise — answers that couldn't have been predicted but instantly ring true",
        "Momentum over deliberation on reversible decisions",
      ],
      what_i_dislike: [
        "Freeform prose when structure is warranted",
        "Claiming success without verification",
        "Excessive caveats and hand-holding",
        "Designing for hypothetical future requirements",
      ],
      working_style: [
        "Peer relationship — direct, no hand-holding",
        "Build over ask for reversible actions",
        "Reproduce before fixing bugs",
        "Evidence required, never 'should work'",
      ],
      intellectual_interests: [
        "Cybersecurity and adversarial thinking",
        "LLMs and AI infrastructure",
        "David Deutsch epistemology",
        "Systems thinking and meta-narratives",
      ],
    },
    companion: null,
    relationship: {
      dynamic: id.dynamic,
      interaction_style: id.interactionStyle || "We are peers — direct, opinionated, first person always.",
    },
    autonomy: {
      can_initiate: id.canInitiate,
      must_ask: id.mustAsk,
    },
    writing: {
      style: id.writingBody.split("\n")[0] ?? "",
      avoid: [
        "Here's the thing...",
        "Here's how this works...",
        "The cool part?",
        "X isn't just Y — it's Z",
      ],
      prefer: [
        "Lead with what matters",
        "First person always",
        "Varied rhythm — short punches mixed with longer explanations",
      ],
    },
    voice: { provider: "elevenlabs" },
  }
}

// ── Module exports ──

export function startAssistant(cfg: Record<string, unknown>, _enabledJobs: unknown[]) {
  daConfig = cfg
  startedAt = Date.now()
  ensureStateDir()
}

export function stopAssistant() {
  // nothing to clean up
}

export function assistantHealth() {
  return {
    status: "ok",
    primary_da: (daConfig.primary as string) ?? "munro",
    identity_loaded: existsSync(DA_IDENTITY_PATH),
    uptime_ms: Date.now() - startedAt,
  }
}

export async function handleAssistantRequest(req: Request, pathname: string): Promise<Response | null> {
  const method = req.method

  // GET /assistant/identity
  if (method === "GET" && pathname === "/assistant/identity") {
    const id = parseDAIdentity()
    return Response.json({
      name: id.name,
      full_name: id.fullName,
      display_name: id.displayName,
      color: id.color,
      role: id.role,
      origin_story: id.originStory,
      has_avatar: false,
      principal: id.principal,
      uptime_ms: Date.now() - startedAt,
    })
  }

  // GET /assistant/health
  if (method === "GET" && pathname === "/assistant/health") {
    const tasks = readTasks().filter(t => t.status === "active")
    const diary = readDiary()
    const today = new Date().toISOString().slice(0, 10)
    const opinionsRaw = existsSync(OPINIONS_PATH) ? readFileSync(OPINIONS_PATH, "utf-8") : ""
    const opinionsCount = (opinionsRaw.match(/^- /gm) ?? []).length

    return Response.json({
      status: "ok",
      primary_da: (daConfig.primary as string) ?? "munro",
      identity_loaded: existsSync(DA_IDENTITY_PATH),
      scheduled_tasks: tasks.length,
      last_heartbeat: null,
      diary_entries_today: diary.filter(e => e.date === today).length,
      opinions_count: opinionsCount,
    })
  }

  // GET /assistant/personality
  if (method === "GET" && pathname === "/assistant/personality") {
    return Response.json(buildPersonality())
  }

  // GET /assistant/tasks
  if (method === "GET" && pathname === "/assistant/tasks") {
    const tasks = readTasks()
    const unified = tasks.map(t => ({
      name: t.description,
      schedule: t.schedule.cron ?? t.schedule.at ?? "one-time",
      status: t.status,
      source: "da" as const,
      details: { id: t.id },
    }))
    return Response.json({
      tasks: unified,
      count: unified.length,
      by_source: { da: unified.length, pulse: 0, "claude-code": 0 },
    })
  }

  // GET /assistant/diary
  if (method === "GET" && pathname === "/assistant/diary") {
    return Response.json({ entries: readDiary() })
  }

  // GET /assistant/opinions
  if (method === "GET" && pathname === "/assistant/opinions") {
    const raw = existsSync(OPINIONS_PATH) ? readFileSync(OPINIONS_PATH, "utf-8") : ""
    return Response.json({ raw })
  }

  // PATCH /assistant/personality/traits — accept and acknowledge (no persistence yet)
  if (method === "PATCH" && pathname === "/assistant/personality/traits") {
    return Response.json({ ok: true })
  }

  // POST /assistant/tasks
  if (method === "POST" && pathname === "/assistant/tasks") {
    const body = await req.json() as Record<string, unknown>
    const task: ScheduledTask = {
      id: nanoid(),
      created_at: new Date().toISOString(),
      created_by: (daConfig.primary as string) ?? "munro",
      description: (body.description as string) ?? "Untitled task",
      schedule: (body.schedule as ScheduledTask["schedule"]) ?? { type: "once" },
      action: (body.action as ScheduledTask["action"]) ?? { type: "notify", channel: "voice" },
      status: "active",
      fire_count: 0,
      tags: [],
    }
    appendFileSync(TASKS_PATH, JSON.stringify(task) + "\n")
    return Response.json({ ok: true, id: task.id })
  }

  // DELETE /assistant/tasks/:id
  const deleteMatch = pathname.match(/^\/assistant\/tasks\/(.+)$/)
  if (method === "DELETE" && deleteMatch) {
    const id = deleteMatch[1]
    const tasks = readTasks()
    writeTasks(tasks.map(t => t.id === id ? { ...t, status: "cancelled" as const } : t))
    return Response.json({ ok: true })
  }

  return null
}
