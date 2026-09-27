/**
 * local_host.ts — one place the bench tools learn where the local llama-server lives.
 *
 * Order: the caller's env var, then PAI_CONFIG.yaml `ollama.base_url` (the same source as
 * Inference.ts and NightlyCodeReview.ts), then 127.0.0.1. Reading config keeps the host and
 * Tailscale IP out of the source, so the release gate never sees them.
 *
 * Returns the origin with the given port, e.g. `http://<host>:11434`; callers append `/v1/...`.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export function localInferenceOrigin(port = "11434"): string {
  try {
    const cfgPath = join(process.env.PAI_DIR ?? join(homedir(), ".claude", "PAI"), "USER", "Config", "PAI_CONFIG.yaml");
    const cfg = Bun.YAML.parse(readFileSync(cfgPath, "utf-8")) as { ollama?: { base_url?: string } };
    const u = new URL(String(cfg?.ollama?.base_url));
    u.port = port;
    return u.origin;
  } catch (e) {
    console.error(`[local_host] PAI_CONFIG ollama.base_url unreadable (${(e as Error).message}); using 127.0.0.1:${port}`);
    return `http://127.0.0.1:${port}`;
  }
}
