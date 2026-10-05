// U21: a job submitted from a host conversation that runs in its bypass mode is authorized by that mode, so no
// U11 confirmation is asked. Only signals the host itself produces for this very call count:
//   Claude Code: the plugin's PreToolUse hook (plugins/claude-code/host-mode-hook.mjs) receives the
//     conversation's current permission_mode from Claude Code right before each turnweft_ask / turnweft_delegate
//     call and records it with the call's requestId. Only "bypassPermissions" counts; "auto" and others ask.
//   Codex: every tools/call carries _meta["x-codex-turn-metadata"].sandbox_mode; full access is "danger-full-access".
// The CLI never auto-authorizes: its environment can be set by whoever runs it (round 11, 2).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HostBinding } from "../core/types.js";
import { stateDir } from "./paths.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The hook runs immediately before the MCP request; anything older belongs to another call. */
export const HOOK_RECORD_MAX_AGE_MS = 60_000;

export interface HookRecord { session_id: string; permission_mode: string; tool_name: string; request_id: string; at: number }

/** Where the hook writes the record for one call (shared with the hook script; keep in sync). */
export function hookRecordPath(sessionId: string, requestId: string, home = stateDir()): string {
  return join(home, "host-mode", sessionId, `${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}.json`);
}

export interface CallContext { toolName: string; requestId: string }

/**
 * The host's own bypass signal for one tool call, e.g. "claude-code:bypassPermissions", or undefined when the host
 * is not in its bypass mode or the mode cannot be established for this call (then the normal confirmation applies).
 */
export function hostBypass(host: HostBinding, meta: Record<string, unknown> | undefined, call: CallContext,
  env: NodeJS.ProcessEnv = process.env, now = Date.now()): string | undefined {
  if (host.hostKind === "codex") {
    const turn = meta?.["x-codex-turn-metadata"] as Record<string, unknown> | undefined;
    return turn?.sandbox_mode === "danger-full-access" ? "codex:danger-full-access" : undefined;
  }
  if (host.hostKind !== "claude-code") return undefined;
  // The MCP server's own environment comes from Claude Code; the binding must name the same conversation.
  const sessionId = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (!sessionId || !SESSION_ID.test(sessionId) || host.conversationId !== sessionId) return undefined;
  const file = hookRecordPath(sessionId, call.requestId);
  let record: HookRecord;
  try { record = JSON.parse(readFileSync(file, "utf8")) as HookRecord; } catch { return undefined; }
  try { rmSync(file, { force: true }); } catch { /* single use; best effort */ }
  const fresh = typeof record.at === "number" && now - record.at >= -5_000 && now - record.at <= HOOK_RECORD_MAX_AGE_MS;
  const sameCall = record.session_id === sessionId && record.request_id === call.requestId
    && typeof record.tool_name === "string" && record.tool_name.endsWith(`__${call.toolName}`);
  return fresh && sameCall && record.permission_mode === "bypassPermissions" ? "claude-code:bypassPermissions" : undefined;
}

/** Remove hook records older than an hour (calls that never reached the server). */
export function pruneHookRecords(home = stateDir(), now = Date.now()): void {
  const root = join(home, "host-mode");
  try {
    for (const dir of readdirSync(root)) {
      for (const f of readdirSync(join(root, dir))) {
        const p = join(root, dir, f);
        try { if (now - statSync(p).mtimeMs > 3_600_000) rmSync(p, { force: true }); } catch { /* raced */ }
      }
    }
  } catch { /* nothing recorded yet */ }
}
