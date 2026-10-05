#!/usr/bin/env node
// Turnweft U21 PreToolUse hook (Claude Code). Claude Code runs it right before each turnweft_ask /
// turnweft_delegate call and passes the conversation's current permission_mode. It records that mode for this one
// call (session + requestId) so the Turnweft runtime can authorize a call made in bypass mode without a dialog.
// It never blocks or changes the call: no output, always exit 0. Path layout must match src/runtime/host-mode.ts.
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const sessionId = String(input.session_id ?? "");
  const requestId = input.tool_input?.requestId;
  if (SESSION_ID.test(sessionId) && typeof requestId === "string" && requestId && typeof input.permission_mode === "string") {
    const dir = join(process.env.TURNWEFT_HOME ?? join(homedir(), ".turnweft"), "host-mode", sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}.json`);
    const record = { session_id: sessionId, permission_mode: input.permission_mode, tool_name: String(input.tool_name ?? ""), request_id: requestId, at: Date.now() };
    // Always overwrite: whatever was there before (stale or planted) is replaced by the host's real mode.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, file);
  }
} catch { /* never interfere with the tool call */ }
process.exit(0);
