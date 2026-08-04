/**
 * PAI Installer v5.0 — CLI Interactive Prompts
 * readline-based input collection with proper cleanup.
 *
 * Non-interactive mode: when PAI_TEST_AUTOMATED=1 or stdin is not a TTY
 * (CI, ssh-without-tty, headless test harnesses), every prompt returns the
 * documented sensible default without ever touching readline. This keeps
 * the wizard runnable end-to-end from automation.
 */

import * as readline from "readline";
import { c, print, printError, printQuestion, printWarning } from "./display";

const ANSWER_PREFIX = `  ${c.green}❯ you:${c.reset} `;

type PromptChoiceOption = {
  label: string;
  value: string;
  description?: string;
  voiceId?: string;
};

function isAutomated(): boolean {
  // `isTTY` is `true` for a real terminal, but NOT reliably `false` for every
  // non-interactive stream — Bun (and Node in some configurations) reports
  // `undefined` for piped/redirected stdin rather than `false`. Checking
  // `=== false` missed that case: a genuinely non-interactive pipe with no
  // env flags set would fall through to `rl.question` and could resolve an
  // answer from whatever happened to be on stdin (e.g. an empty line reading
  // as "accept default"). `!== true` treats anything that isn't confirmed to
  // be a real terminal as non-interactive, which is the safe direction here.
  return process.env.PAI_TEST_AUTOMATED === "1" || process.stdin.isTTY !== true;
}

// Destructive-action confirmations (e.g. "resume into an existing install,
// which deletes and overwrites live files") must not be answered by the same
// flag that auto-defaults config-value prompts. PAI_TEST_AUTOMATED exists so
// automated/CI runs don't hang on "what should we call your DA?" — it was
// never meant to also mean "yes, overwrite the live tree." A separate,
// narrowly-named opt-in is required for those.
function isExplicitlyConfirmed(): boolean {
  return process.env.PAI_CONFIRM_OVERWRITE === "1";
}

/**
 * Prompt for text input with optional default value.
 *
 * In automated mode we return an empty string and let the caller's own
 * fallback ("User", "PAI", etc.) take effect. The `defaultValue` here is
 * really a UI placeholder hint ("Your name", "e.g., Atlas, Nova, Sage"),
 * NOT a sensible install-time default — returning it as the answer
 * persisted those literal hint strings into settings.json on automated
 * runs.
 */
export async function promptText(
  question: string,
  defaultValue?: string,
  daName?: string
): Promise<string> {
  if (isAutomated()) return "";

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const defaultHint = defaultValue ? ` ${c.gray}(default: ${defaultValue})${c.reset}` : "";

  printQuestion(question + defaultHint, daName);
  return new Promise<string>((resolve) => {
    rl.question(ANSWER_PREFIX, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

/**
 * Prompt for a password/key (masked input).
 */
export async function promptSecret(
  question: string,
  placeholder?: string,
  daName?: string
): Promise<string> {
  if (isAutomated()) return "";

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const hint = placeholder ? ` ${c.gray}(${placeholder})${c.reset}` : "";

  printQuestion(question + hint + `\n${c.dim}(input will be visible — paste your key)${c.reset}`, daName);
  return new Promise<string>((resolve) => {
    rl.question(ANSWER_PREFIX, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt for a choice from a list.
 */
export async function promptChoice(
  question: string,
  choices: PromptChoiceOption[],
  daName?: string
): Promise<string> {
  if (isAutomated()) return choices[0]?.value ?? "";

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  printQuestion(question, daName);
  for (let i = 0; i < choices.length; i++) {
    const choice = choices[i];
    print(`  ${c.blue}${i + 1})${c.reset} ${c.bold}${choice.label}${c.reset}${choice.description ? ` ${c.gray}— ${choice.description}${c.reset}` : ""}`);
  }

  return new Promise<string>((resolve) => {
    rl.question(ANSWER_PREFIX, (answer) => {
      rl.close();
      const idx = parseInt(answer.trim()) - 1;
      if (idx >= 0 && idx < choices.length) {
        resolve(choices[idx].value);
      } else {
        // Default to first choice
        resolve(choices[0].value);
      }
    });
  });
}

export async function promptChoiceWithPreview(
  question: string,
  choices: { label: string; value: string; description?: string; voiceId?: string }[],
  onPreview: (choice: { label: string; value: string; voiceId?: string }) => Promise<void>,
  daName?: string,
): Promise<string> {
  if (isAutomated()) return choices[0]?.value ?? "";

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> => new Promise((resolve) => {
    rl.question(prompt, resolve);
  });

  printQuestion(question, daName);
  for (let i = 0; i < choices.length; i++) {
    const choice = choices[i];
    print(`  ${c.lightBlue}┌────────────────────────────────────────────────────────────┐${c.reset}`);
    print(`  ${c.lightBlue}│${c.reset} ${c.blue}${i + 1})${c.reset} ${c.bold}${choice.label}${c.reset}${choice.voiceId ? ` ${c.gray}— ${choice.voiceId}${c.reset}` : ""}`);
    if (choice.description) {
      print(`  ${c.lightBlue}│${c.reset} ${c.gray}${choice.description}${c.reset}`);
    }
    print(`  ${c.lightBlue}│${c.reset} ${choice.voiceId ? `${c.lightBlue}▶ p${i + 1} to preview${c.reset}` : `${c.gray}No preview available${c.reset}`}`);
    print(`  ${c.lightBlue}└────────────────────────────────────────────────────────────┘${c.reset}`);
  }

  try {
    while (true) {
      const trimmed = (await ask(ANSWER_PREFIX)).trim();

      if (trimmed === "") {
        continue;
      }

      const selectedMatch = /^(\d+)$/.exec(trimmed);
      if (selectedMatch) {
        const idx = parseInt(selectedMatch[1], 10) - 1;
        if (idx >= 0 && idx < choices.length) {
          return choices[idx].value;
        }
        printWarning(`pick a number between 1 and ${choices.length}`);
        continue;
      }

      const previewMatch = /^p(\d+)$/i.exec(trimmed);
      if (previewMatch) {
        const idx = parseInt(previewMatch[1], 10) - 1;
        if (idx < 0 || idx >= choices.length) {
          printWarning(`preview number must be between 1 and ${choices.length}`);
          continue;
        }

        const choice = choices[idx];
        if (!choice.voiceId) {
          printWarning("no preview available");
          continue;
        }

        try {
          await onPreview({ label: choice.label, value: choice.value, voiceId: choice.voiceId });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          printError(`preview unavailable: ${reason}`);
        }
        continue;
      }

      printWarning(`didn't understand ${trimmed}`);
    }
  } finally {
    rl.close();
  }
}

/**
 * Prompt for yes/no confirmation.
 *
 * requireExplicit: set this for any confirmation that gates a destructive or
 * hard-to-reverse action (overwriting/deleting existing files, resuming into
 * an existing install, etc). When set, PAI_TEST_AUTOMATED / non-TTY stdin no
 * longer auto-answers the question — only PAI_CONFIRM_OVERWRITE=1 does, and
 * everything else (including plain automated mode with no explicit opt-in)
 * fails closed to `false`, never to `defaultYes`. This deliberately does NOT
 * fall back to readline in automated mode even if stdin happens to be a TTY,
 * since the whole point is that automation must not silently consent to a
 * destructive action it never explicitly asked for.
 */
export async function promptConfirm(
  question: string,
  defaultYes: boolean = true,
  daName?: string,
  requireExplicit: boolean = false
): Promise<boolean> {
  if (requireExplicit) {
    // isExplicitlyConfirmed() is gated on isAutomated() too — PAI_CONFIRM_OVERWRITE=1
    // is meant to be automation's explicit opt-in, not a standing bypass. Without
    // this gate, a real human at a real interactive terminal with the var set in
    // their shell (leftover from testing, a dotfile, etc.) would get silently
    // auto-resumed with no prompt shown at all — the exact "silent consent to a
    // destructive action" shape this fix exists to prevent, just under a
    // different trigger. Found by DualCheck's MiniMax M3 pass, verified against
    // this function before fixing.
    if (isAutomated() && isExplicitlyConfirmed()) return true;
    if (isAutomated()) return false;
  } else if (isAutomated()) {
    return defaultYes;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const hint = defaultYes ? `${c.gray}(Y/n)${c.reset}` : `${c.gray}(y/N)${c.reset}`;

  printQuestion(`${question} ${hint}`, daName);
  return new Promise<boolean>((resolve) => {
    rl.question(ANSWER_PREFIX, (answer) => {
      rl.close();
      const val = answer.trim().toLowerCase();
      if (val === "") resolve(defaultYes);
      else resolve(val === "y" || val === "yes");
    });
  });
}
