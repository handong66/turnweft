// U21: only a host signal produced for this very call decides bypass (round 11). Claude Code: the plugin's
// PreToolUse hook record (current permission_mode, bound to session + requestId + tool, fresh). Codex: turn metadata.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.TURNWEFT_HOME = mkdtempSync(join(tmpdir(), "tw-hostmode-"));
const { callDigest, hookRecordPath, hostBypass } = await import("../runtime/host-mode.js");

const SID = "065055b0-46bd-49e1-910d-090f8afc4646";
const env = { CLAUDE_CODE_SESSION_ID: SID };
const cc = { hostKind: "claude-code" as const, conversationId: SID };
const call = { toolName: "turnweft_delegate", args: { sessionId: "tws_1", prompt: "write it", requestId: "req-1" } };
const toolInput = (c = call) => ({ ...c.args });
const HOOK = fileURLToPath(new URL("../../plugins/claude-code/host-mode-hook.mjs", import.meta.url));

function record(mode: string, over: Record<string, unknown> = {}, c = call) {
  const file = hookRecordPath(SID, callDigest(c));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ session_id: SID, permission_mode: mode, tool_name: "mcp__plugin_turnweft_turnweft__turnweft_delegate", call_digest: callDigest(c), at: Date.now(), ...over }));
  return file;
}

function runHook(input: Record<string, unknown>) {
  execFileSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: { ...process.env } });
}

test("Claude Code: a fresh hook record of this call in bypassPermissions authorizes it once", () => {
  const file = record("bypassPermissions");
  assert.equal(hostBypass(cc, undefined, call, env), "claude-code:bypassPermissions");
  assert.equal(existsSync(file), false, "single use");
  assert.equal(hostBypass(cc, undefined, call, env), undefined, "no record, no bypass");
});

test("Claude Code: auto and every other mode ask; stale, foreign or mismatched records never authorize", () => {
  for (const m of ["auto", "default", "acceptEdits", "plan"]) { record(m); assert.equal(hostBypass(cc, undefined, call, env), undefined, m); }
  record("bypassPermissions", { at: Date.now() - 20_000 }); assert.equal(hostBypass(cc, undefined, call, env), undefined, "stale (15 s)");
  record("bypassPermissions", { call_digest: "x" }); assert.equal(hostBypass(cc, undefined, call, env), undefined, "other call inside");
  // Round 12, 1: the same requestId with a different task (or session) never borrows the record.
  record("bypassPermissions");
  assert.equal(hostBypass(cc, undefined, { ...call, args: { ...call.args, prompt: "something else" } }, env), undefined, "different prompt");
  assert.equal(hostBypass(cc, undefined, { ...call, args: { ...call.args, sessionId: "tws_2" } }, env), undefined, "different session");
  assert.equal(hostBypass(cc, undefined, { ...call, toolName: "turnweft_ask" }, env), undefined, "different tool");
  assert.equal(hostBypass(cc, undefined, call, env), "claude-code:bypassPermissions", "the exact call still matches");
  record("bypassPermissions", { tool_name: "mcp__plugin_turnweft_turnweft__turnweft_ask" }); assert.equal(hostBypass(cc, undefined, call, env), undefined, "other tool");
  record("bypassPermissions", { session_id: "11111111-2222-3333-4444-555555555555" }); assert.equal(hostBypass(cc, undefined, call, env), undefined, "other session inside");
  record("bypassPermissions");
  assert.equal(hostBypass({ hostKind: "claude-code", conversationId: "11111111-2222-3333-4444-555555555555" }, undefined, call, env), undefined, "binding names another conversation");
  assert.equal(hostBypass({ hostKind: "cli", connectionId: "cli" }, undefined, call, env), undefined, "the CLI never takes a bypass signal");
  assert.equal(hostBypass(cc, undefined, call, { CLAUDE_CODE_SESSION_ID: "../../x" }), undefined, "non-UUID session");
});

test("the hook records the host's real mode for this call and overwrites a planted record", () => {
  // A non-bypass agent plants a bypass record for the requestId it is about to use...
  record("bypassPermissions");
  // ...but Claude Code runs the hook right before the call, with the conversation's real mode.
  runHook({ session_id: SID, permission_mode: "default", tool_name: "mcp__plugin_turnweft_turnweft__turnweft_delegate", tool_input: toolInput() });
  assert.equal(hostBypass(cc, undefined, call, env), undefined);
  runHook({ session_id: SID, permission_mode: "bypassPermissions", tool_name: "mcp__plugin_turnweft_turnweft__turnweft_delegate", tool_input: toolInput() });
  assert.equal(hostBypass(cc, undefined, call, env), "claude-code:bypassPermissions", "the hook and the runtime compute the same digest");
  // Malformed input: the hook stays silent and writes nothing.
  execFileSync(process.execPath, [HOOK], { input: "not json" });
  runHook({ session_id: "../../x", permission_mode: "bypassPermissions", tool_input: { requestId: "r" } });
});

test("Codex: only sandbox_mode danger-full-access from the host's turn metadata authorizes", () => {
  const codex = { hostKind: "codex" as const, conversationId: "thread" };
  const meta = (sandbox_mode: string) => ({ "x-codex-turn-metadata": { thread_id: "thread", sandbox_mode } });
  assert.equal(hostBypass(codex, meta("danger-full-access"), call, {}), "codex:danger-full-access");
  for (const m of ["workspace-write", "read-only"]) assert.equal(hostBypass(codex, meta(m), call, {}), undefined, m);
  assert.equal(hostBypass(codex, undefined, call, {}), undefined);
  record("bypassPermissions");
  assert.equal(hostBypass(codex, meta("workspace-write"), call, env), undefined, "a Codex host never uses a Claude Code record");
});
