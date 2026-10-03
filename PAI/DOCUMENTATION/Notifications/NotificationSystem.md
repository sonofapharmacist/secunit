# The Notification System

**Desktop and push notifications for PAI workflows and task execution.**

> **Infrastructure:** The notification endpoint (`http://localhost:31337/notify`) is served by the unified Pulse daemon (`~/.claude/PAI/PULSE/`). It is implemented at `~/.claude/PAI/PULSE/Notify.ts` and routed through Pulse -- there is no separate notification process. One daemon, one port, run by launchd (`com.pai.pulse`) on macOS or a systemd user unit on Linux.

> **Text-to-speech was removed on 2026-08-08.** PAI previously synthesized spoken audio through ElevenLabs. That integration -- the API key, voice IDs, prosody and `voice_settings` tuning, and audio playback -- is gone with no replacement provider. `/notify` remains the general notification and progress ingestion endpoint; it now delivers a desktop notification and nothing more. Requests that still carry `voice_id`, `voice_enabled`, or `voice_settings` fields are accepted and ignored, so existing callers keep working unchanged.

This system provides:
- Desktop notification feedback when workflows start
- Severity-routed alerts to your phone through ntfy (P0 / P1 / P2), with quiet hours, dedup and flood control
- A daily delivery self-test, a local-LLM health check and a morning digest, all as Pulse jobs

---

## What `/notify` Does

`Notify.ts` exports `handleNotifyRequest()`; it does not run its own HTTP server. The parent `pulse.ts` imports it as `notifyModule`, calls `startNotify({ enabled: true })` at boot, and exposes `notifyHealth()` in the health subsystem list.

| Route | Method | Behavior |
|-------|--------|----------|
| `/notify` | POST | Main endpoint. Body: `title` (default `"PAI Notification"`), `message`, `severity` (`P0` / `P1` / `P2`, default `P2`), `source`, `id`, `link`, `markdown`. Governs the alert, then sends it to every channel whose threshold it reaches. |
| `/notify/personality` | POST | Compatibility shim for legacy callers. Sends the notification under the title `"PAI Notification"`. |
| `/voice` | POST | Legacy path alias, kept so existing callers do not need updating. Default title `"PAI Assistant"`. No audio despite the name. |
| `/notify/health` | GET | Channels with their `min_severity` and last delivery, `quiet_hours`, `held`, `flood_suppressed`, and a `warning` when no channel is configured. |

On the way through, every request gets:

1. **Input sanitization** -- message text is cleaned and escaped before it reaches a desktop notifier
2. **Rate limiting** -- 10 requests per 60-second window per client IP; over the limit returns HTTP 429. P0 is never rate-limited.
3. **The governor** -- dedup, quiet hours and flood control (see *Severity and the Governor* below)
4. **Delivery** -- each configured channel at or above its threshold; the result comes back as `deliveries` and is logged to `MEMORY/OBSERVABILITY/alerts.jsonl`

Success responses are `{"status": "success", "message": "...", "deliveries": [...]}`. Failures return `{"status": "error", "message": "..."}` with 400 for invalid input and 500 otherwise.

**What it does not do:** text-to-speech synthesis, ElevenLabs API calls, audio playback, or voice ID resolution.

---

## Task Start Announcements

**When STARTING a task, do BOTH:**

1. **Send notification**:
   ```bash
   curl -s -X POST http://localhost:31337/notify \
     -H "Content-Type: application/json" \
     -d '{"message": "[Doing what {PRINCIPAL.NAME} asked]"}' \
     > /dev/null 2>&1 &
   ```

2. **Output text notification**:
   ```
   [Doing what {PRINCIPAL.NAME} asked]...
   ```

**Skip curl for conversational responses** (greetings, acknowledgments, simple Q&A).

---

## Context-Aware Announcements

**Match your announcement to what {PRINCIPAL.NAME} asked.** Start with the appropriate gerund:

| {PRINCIPAL.NAME}'s Request | Announcement Style |
|------------------|-------------------|
| Question ("Where is...", "What does...") | "Checking...", "Looking up...", "Finding..." |
| Command ("Fix this", "Create that") | "Fixing...", "Creating...", "Updating..." |
| Investigation ("Why isn't...", "Debug this") | "Investigating...", "Debugging...", "Analyzing..." |
| Research ("Find out about...", "Look into...") | "Researching...", "Exploring...", "Looking into..." |

**Examples:**
- "Where's the config file?" → "Checking the project for config files..."
- "Fix this bug" → "Fixing the null pointer in auth handler..."
- "Why isn't the API responding?" → "Investigating the API connection..."
- "Create a new component" → "Creating the new component..."

---

## Workflow Invocation Notifications

**For skills with `Workflows/` directories, use "Executing..." format:**

```
Executing the **WorkflowName** workflow within the **SkillName** skill...
```

**Examples:**
- "Executing the **GIT** workflow within the **CORE** skill..."
- "Executing the **Publish** workflow within the **Blogging** skill..."

**NEVER announce fake workflows:**
- "Executing the file organization workflow..." - NO SUCH WORKFLOW EXISTS
- If it's not listed in a skill's Workflow Routing, DON'T use "Executing" format
- For non-workflow tasks, use context-appropriate gerund

### The curl Pattern (Workflow-Based Skills Only)

When executing an actual workflow file from a `Workflows/` directory:

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the WORKFLOWNAME workflow in the SKILLNAME skill to ACTION", "title": "{DA_IDENTITY.NAME}"}' \
  > /dev/null 2>&1 &
```

**Parameters:**
- `message` - The notification text (workflow and skill name)
- `title` - Display name for the notification

Legacy `voice_id`, `voice_enabled`, and `voice_settings` fields are ignored if present.

---

## Copy-Paste Templates

### Template A: Skills WITH Workflows

For skills that have a `Workflows/` directory:

```markdown
## Workflow Notification

**When executing a workflow, do BOTH:**

1. **Send notification**:
   ```bash
   curl -s -X POST http://localhost:31337/notify \
     -H "Content-Type: application/json" \
     -d '{"message": "Running the WORKFLOWNAME workflow in the SKILLNAME skill to ACTION"}' \
     > /dev/null 2>&1 &
   ```

2. **Output text notification**:
   ```
   Running the **WorkflowName** workflow in the **SkillName** skill to ACTION...
   ```
```

Replace `WORKFLOWNAME`, `SKILLNAME`, and `ACTION` with actual values when executing. ACTION should be under 6 words describing what the workflow does.

### Template B: Skills WITHOUT Workflows

For skills that handle requests directly (no `Workflows/` directory), **do NOT include a notification section**. These skills just describe what they're doing naturally in their responses.

If you need to indicate this explicitly:

```markdown
## Task Handling

This skill handles requests directly without workflows. When executing, simply describe what you're doing:
- "Let me [action]..."
- "I'll [action]..."
```

---

## Why Direct curl (Not Shell Script)

Direct curl is:
- **More reliable** - No script execution dependencies
- **Faster** - No shell script overhead
- **Visible** - The command is explicit in the skill file
- **Debuggable** - Easy to test in isolation

The backgrounded `&` and redirected output (`> /dev/null 2>&1`) ensure the curl doesn't block workflow execution.

---

## When to Skip Notifications

**Always skip notifications when:**
- **Conversational responses** - Greetings, acknowledgments, simple Q&A
- **Skill has no workflows** - The skill has no `Workflows/` directory
- **Direct skill handling** - SKILL.md handles request without invoking a workflow file
- **Quick utility operations** - Simple file reads, status checks
- **Sub-workflows** - When a workflow calls another workflow (avoid double notification)

**The rule:** Only notify when actually loading and following a `.md` file from a `Workflows/` directory, or when starting significant task work.

---

## Alerting: Severity, Channels and the Governor

Anything that needs a human posts to `/notify` with a severity. Pulse decides whether and where it goes. Callers never talk to a phone service directly.

### Severity

| Severity | Meaning | Phone (ntfy) | Quiet hours | Dedup window |
|---|---|---|---|---|
| **P0** | Act now: a canary token tripped, a security gate fired | Priority 5 | Delivered | 1 h, so an unresolved P0 pages again hourly |
| **P1** | Act today: a job stopped, a local model is down, a high-severity review finding | Priority 4 | Held, sent as one summary when quiet hours end | 24 h |
| **P2** | FYI: recoveries, tallies, task titles | Not sent | Not applicable | 24 h |

P2 stays on the desktop and lands in the morning digest.

### Channels

Channels come from `settings.json → notifications` (`PULSE/NotifyChannels.ts`):

| Channel | Threshold | Notes |
|---|---|---|
| **Desktop** | P2 | macOS `osascript`, Linux `notify-send`, WSL PowerShell toast. Auto-detected; disable with `desktop.enabled: false`. |
| **ntfy** | P1 | Any ntfy server: ntfy.sh or self-hosted. Token via `tokenEnv` (sent as `Authorization: Bearer`, never in the URL). |

**`trusted` controls what leaves the machine.** With `trusted: false` (the default) ntfy gets ids only: severity, source and alert id, no title or message text. Set `trusted: true` only for a server you control, such as one on your tailnet, because alert text can carry paths, findings and session details.

### The Governor

`PULSE/NotifyGovernor.ts` runs before delivery. State is kept in `PULSE/state/notify-governor.json`.

- **Dedup.** An alert's fingerprint is its severity, source, title and message. An identical alert inside its dedup window sends nothing.
- **Quiet hours.** P1s arriving inside `quietHours` are held. On the first tick after the window ends, they are released as one summary. Windows may wrap midnight. P0 always goes through.
- **Flood control.** More than 5 P1s from one source in an hour are collapsed: the rest are counted, and one summary is sent when the hour ends.

### Configuration

In `~/.claude/settings.json`:

```json
{
  "notifications": {
    "ntfy": {
      "enabled": true,
      "server": "https://ntfy.example.net",
      "topic": "${NTFY_TOPIC}",
      "tokenEnv": "NTFY_TOKEN",
      "trusted": false
    },
    "quietHours": { "start": "22:00", "end": "07:00", "timeZone": "America/New_York" }
  }
}
```

`${VAR}` values are expanded from Pulse's environment, so the topic and token stay out of `settings.json`. Point Pulse at an env file (for systemd, a drop-in with `EnvironmentFile=`) holding `NTFY_TOPIC`, `NTFY_TOKEN` and, optionally, `NTFY_BACKUP_TOPIC`.

### Setting Up ntfy

**Hosted (quickest).** Generate an unguessable topic: `echo "pai-$(openssl rand -hex 8)"`. Anyone who knows it can read and post, so keep `trusted: false`. Install the ntfy app on your phone, subscribe to the topic, and leave `server` empty (it defaults to ntfy.sh).

**Self-hosted (recommended).** Run the ntfy server on a machine you control, and bind it to a private interface such as a tailnet address, not to the internet.
1. In `server.yml`, set `auth-default-access: deny-all` and turn sign-ups off.
2. Create two users: one for your phone (read-write on your topics), and one write-only user for PAI, with an access token.
3. Put the token in the env file as `NTFY_TOKEN`, set `server` to the private address, and set `trusted: true`.
4. Subscribe from the phone app using the phone user.

**Backup path.** If `NTFY_BACKUP_TOPIC` is set, the daily self-test also checks a topic on public ntfy.sh. When the primary path fails, it posts an ids-only alert there, so a dead server still reaches you. Subscribe to the backup topic too.

**Test it:**

```bash
curl -s -X POST localhost:31337/notify -H 'Content-Type: application/json' \
  -d '{"title":"Test","message":"P1 test, not a real alert","severity":"P1","source":"manual"}'
curl -s localhost:31337/notify/health
```

### Pulse Jobs That Alert

| Job | Schedule | What it does |
|---|---|---|
| Job breaker (built into `pulse.ts`, `PULSE/JobBreaker.ts`) | Every job run | A job that keeps failing is stopped (P1 "Pulse job stopped"). It is retried at its next scheduled run, at most once a day, and sends P2 on recovery. |
| `notify-selftest` | Daily 12:00 | Round-trips a message through the primary ntfy server (and the backup, if configured). P1 on failure. |
| `llm-health` | Every 2 min | Probes local model servers from `PAI_PULSE_LLM_TIERS` (`name\|baseUrl\|alias,...`). P1 after 10 minutes down, P2 on recovery. Does nothing when unset. |
| `morning-digest` | Daily 07:02 | The last 24 h of alerts, review findings, job failures and disk status, as one silent ntfy message. Archived to `MEMORY/OBSERVABILITY/digests/`. |

### Discord and SMS

Discord is not supported. The `notifications.discord` and `routing` keys may still appear in older `settings.json` files, but nothing reads them.

SMS is not supported. US carriers require A2P 10DLC registration, which means weeks of brand and campaign verification plus monthly fees. ntfy reaches the same phone without any of that.

---

## Event Log Channel (events.jsonl)


Events are emitted via `~/.claude/hooks/lib/observability-transport.ts`, which is synchronous and fire-and-forget. This channel is additive -- it does not replace any of the notification channels above, and hooks emit events alongside their existing state writes and notifications.

---

### Design Principles

1. **Fire and forget** - Notifications never block hook execution
2. **Fail gracefully** - Missing services don't cause errors
3. **Conservative defaults** - Avoid notification fatigue
4. **Severity decides reach** - Only P0 and P1 reach the phone; P2 stays on the desktop and in the digest
