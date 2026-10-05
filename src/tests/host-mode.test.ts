// U21: only the host's own records decide bypass; Claude Code's auto mode and every other mode still ask.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTranscript, hostBypass, latestPermissionMode } from "../runtime/host-mode.js";

const SID = "065055b0-46bd-49e1-910d-090f8afc4646";
const cc = { hostKind: "claude-code" as const, conversationId: SID };

function fixture(modes: string[]) {
  const config = mkdtempSync(join(tmpdir(), "tw-cc-config-"));
  const dir = join(config, "projects", "-Users-me-proj");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${SID}.jsonl`);
  writeFileSync(file, modes.map((m) => JSON.stringify({ type: "user", permissionMode: m, message: { content: "hi" } })).join("\n") + "\n");
  return { config, file, env: { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: SID, CLAUDE_PROJECT_DIR: "/Users/me/proj" } };
}

test("Claude Code: the latest recorded permission mode decides; only bypassPermissions authorizes", () => {
  const f = fixture(["default", "bypassPermissions"]);
  try {
    assert.equal(claudeTranscript(f.env), f.file);
    assert.equal(hostBypass(cc, undefined, f.env), "claude-code:bypassPermissions");
    // The user switches the conversation to auto mode: the next submission asks again.
    appendFileSync(f.file, JSON.stringify({ type: "user", permissionMode: "auto" }) + "\n");
    assert.equal(latestPermissionMode(f.file), "auto");
    assert.equal(hostBypass(cc, undefined, f.env), undefined, "auto mode shows the dialog");
    for (const m of ["default", "acceptEdits", "plan"]) {
      appendFileSync(f.file, JSON.stringify({ type: "user", permissionMode: m }) + "\n");
      assert.equal(hostBypass(cc, undefined, f.env), undefined, m);
    }
    // The CLI run by Claude Code's shell tool reads the same transcript.
    appendFileSync(f.file, JSON.stringify({ type: "user", permissionMode: "bypassPermissions" }) + "\n");
    assert.equal(hostBypass({ hostKind: "cli", connectionId: "cli" }, undefined, f.env), "claude-code:bypassPermissions");
    // Without the project dir hint the transcript is still found by session id.
    assert.equal(claudeTranscript({ ...f.env, CLAUDE_PROJECT_DIR: undefined }), f.file);
  } finally { rmSync(f.config, { recursive: true, force: true }); }
});

test("Claude Code: a missing, non-UUID or unreadable session never authorizes", () => {
  const f = fixture(["bypassPermissions"]);
  try {
    assert.equal(hostBypass(cc, undefined, { ...f.env, CLAUDE_CODE_SESSION_ID: undefined }), undefined);
    assert.equal(hostBypass(cc, undefined, { ...f.env, CLAUDE_CODE_SESSION_ID: "../../etc/passwd" }), undefined);
    assert.equal(hostBypass(cc, undefined, { ...f.env, CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-555555555555" }), undefined);
    assert.equal(latestPermissionMode(join(f.config, "nope.jsonl")), undefined);
  } finally { rmSync(f.config, { recursive: true, force: true }); }
});

test("Codex: only sandbox_mode danger-full-access from the host's turn metadata authorizes", () => {
  const codex = { hostKind: "codex" as const, conversationId: "thread" };
  const meta = (sandbox_mode: string) => ({ "x-codex-turn-metadata": { thread_id: "thread", sandbox_mode } });
  assert.equal(hostBypass(codex, meta("danger-full-access"), {}), "codex:danger-full-access");
  assert.equal(hostBypass(codex, meta("workspace-write"), {}), undefined);
  assert.equal(hostBypass(codex, meta("read-only"), {}), undefined);
  assert.equal(hostBypass(codex, undefined, {}), undefined);
  // A Codex host never falls back to a Claude Code transcript.
  const f = fixture(["bypassPermissions"]);
  try { assert.equal(hostBypass(codex, meta("workspace-write"), f.env), undefined); } finally { rmSync(f.config, { recursive: true, force: true }); }
});
