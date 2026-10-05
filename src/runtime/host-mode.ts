// U21: a job submitted from a host conversation that runs in its bypass mode is authorized by that mode, so no
// U11 confirmation is asked. Only signals written by the host itself count; nothing the model says does.
//   Claude Code: the conversation transcript (~/.claude/projects/<project>/<session>.jsonl) records the
//     permissionMode of every user message; the latest one is the current mode. "auto" is not bypass.
//   Codex: every tools/call carries _meta["x-codex-turn-metadata"].sandbox_mode; full access is
//     "danger-full-access".
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostBinding } from "../core/types.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAIL_BYTES = 1_000_000;

/** The transcript of a Claude Code conversation, or undefined. The session id must be a UUID (no path tricks). */
export function claudeTranscript(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const sessionId = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (!sessionId || !SESSION_ID.test(sessionId)) return undefined;
  const projects = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  const file = `${sessionId}.jsonl`;
  // Claude Code names the folder after the project path with every non-alphanumeric character replaced by "-".
  if (env.CLAUDE_PROJECT_DIR) {
    const guess = join(projects, env.CLAUDE_PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, "-"), file);
    if (existsSync(guess)) return guess;
  }
  try {
    for (const dir of readdirSync(projects)) {
      const p = join(projects, dir, file);
      if (existsSync(p)) return p;
    }
  } catch { /* no projects folder */ }
  return undefined;
}

/** The most recent permissionMode recorded in a transcript (reads only the tail of the file). */
export function latestPermissionMode(transcript: string): string | undefined {
  let fd: number | undefined;
  try {
    const size = statSync(transcript).size;
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fd = openSync(transcript, "r");
    readSync(fd, buf, 0, length, size - length);
    const modes = [...buf.toString("utf8").matchAll(/"permissionMode"\s*:\s*"([A-Za-z]+)"/g)];
    return modes.at(-1)?.[1];
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * The host's own bypass signal for this submission, e.g. "claude-code:bypassPermissions", or undefined when the
 * host is not in its bypass mode or the mode cannot be read (then the normal confirmation applies).
 */
export function hostBypass(host: HostBinding, meta?: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const turn = meta?.["x-codex-turn-metadata"] as Record<string, unknown> | undefined;
  if (host.hostKind === "codex") return turn?.sandbox_mode === "danger-full-access" ? "codex:danger-full-access" : undefined;
  // Claude Code over MCP, or the turnweft CLI run by Claude Code's shell tool (both see CLAUDE_CODE_SESSION_ID).
  const transcript = claudeTranscript(env);
  if (!transcript) return undefined;
  return latestPermissionMode(transcript) === "bypassPermissions" ? "claude-code:bypassPermissions" : undefined;
}
