// U21: a job submitted from a host conversation that runs in its bypass mode is authorized by that mode, so no
// U11 confirmation is asked. Only signals the host itself produces for this very call count:
//   Claude Code: the plugin's PreToolUse hook (plugins/claude-code/host-mode-hook.mjs) receives the
//     conversation's current permission_mode from Claude Code right before each turnweft_ask / turnweft_delegate
//     call and records it for that call. Only "bypassPermissions" counts; "auto" and others ask.
//   Codex: every tools/call carries _meta["x-codex-turn-metadata"].sandbox_mode; full access is "danger-full-access".
// The record is bound to the tool and the full task arguments, read once, valid for 15 s, and consumed even when the
// call's arguments are invalid. This relies on the hook running; without a fresh matching record the dialog is shown.
// The CLI never auto-authorizes: its environment can be set by whoever runs it (round 11, 2).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HostBinding } from "../core/types.js";
import { stateDir } from "./paths.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The hook runs immediately before the MCP request; anything older belongs to another call. */
export const HOOK_RECORD_MAX_AGE_MS = 15_000;

export interface HookRecord { session_id: string; permission_mode: string; tool_name: string; call_digest: string; at: number }

/** The tool call a record belongs to: the tool and its full task arguments, not just the requestId (round 12, 1). */
export interface CallContext { toolName: string; args: { sessionId?: unknown; prompt?: unknown; requestId?: unknown } }

/** Digest of one call; the hook computes the same from Claude Code's tool_input (keep in sync with the hook). */
export function callDigest(call: CallContext): string {
  const a = call.args;
  return createHash("sha256").update(JSON.stringify([call.toolName, String(a.sessionId ?? ""), String(a.prompt ?? ""), String(a.requestId ?? "")])).digest("hex");
}

/** Where the hook writes the record for one call (shared with the hook script; keep in sync). */
export function hookRecordPath(sessionId: string, digest: string, home = stateDir()): string {
  return join(home, "host-mode", sessionId, `${digest.slice(0, 32)}.json`);
}

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
  const digest = callDigest(call);
  const file = hookRecordPath(sessionId, digest);
  let record: HookRecord;
  try { record = JSON.parse(readFileSync(file, "utf8")) as HookRecord; } catch { return undefined; }
  try { rmSync(file, { force: true }); } catch { /* single use; best effort */ }
  const fresh = typeof record.at === "number" && now - record.at >= -5_000 && now - record.at <= HOOK_RECORD_MAX_AGE_MS;
  const sameCall = record.session_id === sessionId && record.call_digest === digest
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
