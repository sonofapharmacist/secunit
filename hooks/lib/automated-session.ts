/**
 * automated-session.ts: tells hooks when a Claude Code session was started by a PAI job,
 * not by the principal.
 *
 * Tools that spawn `claude -p` with user settings (NightlyCodeReview) run every registered
 * hook. Without this marker the memory and learning hooks treat the job's prompt as the
 * principal speaking: ImperativeExtractor stored NightlyCodeReview's "DO NOT FABRICATE
 * findings…" as a standing rule in 16 sessions, and SatisfactionCapture wrote 13 ~5/10
 * ratings that fed the learning loop (found 2026-09-29).
 *
 * The spawning tool sets PAI_AUTOMATED_SESSION=<job name> in the subprocess env; Claude Code
 * passes its environment to hooks. Only hooks that read the prompt as the principal, or
 * write about the principal, call exitIfAutomated(). Security hooks (SecurityPipeline,
 * ContentScanner, PromptGuard, canaries) never do: automated sessions still handle input.
 */

export const AUTOMATED_SESSION_ENV = 'PAI_AUTOMATED_SESSION';

/** The job label when this session was started by a PAI job, else null. */
export function automatedSession(): string | null {
  const v = process.env[AUTOMATED_SESSION_ENV]?.trim();
  return v ? v : null;
}

/** Exits 0 with no output (a no-op for every hook event) when the session is automated. */
export function exitIfAutomated(hookName: string): void {
  const label = automatedSession();
  if (label === null) return;
  console.error(`[${hookName}] skipped: automated session (${label})`);
  process.exit(0);
}
