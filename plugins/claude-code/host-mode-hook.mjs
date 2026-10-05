#!/usr/bin/env node
// Turnweft U21 PreToolUse hook (Claude Code). Claude Code runs it right before each turnweft_ask /
// turnweft_delegate call and passes the conversation's current permission_mode. It records that mode for this one
// call (session + tool + full task arguments) so the Turnweft runtime can authorize a call made in bypass mode without a dialog.
// It never blocks or changes the call: no output, always exit 0. Path layout must match src/runtime/host-mode.ts.
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const sessionId = String(input.session_id ?? "");
  const args = input.tool_input ?? {};
  const toolName = String(input.tool_name ?? "");
  const shortName = toolName.split("__").pop();
  if (SESSION_ID.test(sessionId) && typeof input.permission_mode === "string" && /^turnweft_(ask|delegate)$/.test(shortName)) {
    const dir = join(process.env.TURNWEFT_HOME ?? join(homedir(), ".turnweft"), "host-mode", sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Bound to the tool and the full task arguments (same digest as src/runtime/host-mode.ts callDigest).
    const digest = createHash("sha256").update(JSON.stringify([shortName, String(args.sessionId ?? ""), String(args.prompt ?? ""), String(args.requestId ?? "")])).digest("hex");
    const file = join(dir, `${digest.slice(0, 32)}.json`);
    // Remove first: if writing fails below, no earlier record for this call survives.
    rmSync(file, { force: true });
    const record = { session_id: sessionId, permission_mode: input.permission_mode, tool_name: toolName, call_digest: digest, at: Date.now() };
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, file);
  }
} catch { /* never interfere with the tool call */ }
process.exit(0);
