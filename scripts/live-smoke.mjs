#!/usr/bin/env node
// Live end-to-end smoke through LocalService with REAL providers (consumes model quota).
// Usage: node scripts/live-smoke.mjs <provider> [--model <id>]
// The harness confirms the U11 proposal itself; that stands in for the human in a test, never in product code.
import { mkdtempSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const provider = process.argv[2];
const mi = process.argv.indexOf("--model");
const model = mi > 0 ? process.argv[mi + 1] : undefined;
process.env.TURNWEFT_HOME ??= mkdtempSync(join(tmpdir(), "tw-live-home-"));
process.env.TURNWEFT_IDLE_RELEASE_MS ??= "8000";

const { LocalService } = await import(join(root, "dist/runtime/service.js"));
const svc = new LocalService();
const host = { hostKind: "cli", connectionId: "live-smoke" };

const proj = mkdtempSync(join(tmpdir(), `tw-live-${provider}-`));
cpSync(join(root, "m0/fixture-template"), proj, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: proj });
execFileSync("git", ["add", "-A"], { cwd: proj });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"], { cwd: proj });
writeFileSync(join(proj, "NOTES.md"), "pre-existing uncommitted note\n");

const out = { provider, model, proj, home: process.env.TURNWEFT_HOME, steps: {} };
const t0 = Date.now();
const log = (k, v) => { out.steps[k] = v; console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${k}: ${JSON.stringify(v).slice(0, 400)}`); };

async function turn(sessionId, intent, prompt) {
  const requestId = `live-${randomBytes(6).toString("hex")}`;
  let o = await svc.submitTurn({ sessionId, intent, prompt, requestId, host });
  // This script runs in its own temporary TURNWEFT_HOME and project, so it confirms its own proposals (U19:
  // the waiting job then starts by itself, no resubmission).
  if (o.kind === "awaiting_confirmation") {
    log(`proposal_${intent}`, { tier: o.proposal.tier, excess: o.proposal.excessOverGrant });
    await svc.confirmPolicy({ proposalId: o.proposal.proposalId, nonce: o.proposal.nonce, via: "cli-tty" });
    o = { kind: "accepted", job: o.job };
  }
  if (o.kind !== "accepted") throw new Error(JSON.stringify(o));
  for (;;) {
    const v = await svc.getJob({ jobId: o.job.id, waitMs: 20000, includeResult: true });
    if (v.terminal) return v;
  }
}

const token = "TW-" + randomBytes(3).toString("hex").toUpperCase();
const s = await svc.createSession({ provider, cwd: proj, host, model });
log("session", { id: s.id, cliVersion: s.cliVersion });

let v = await turn(s.id, "implement", `Remember this token: ${token}. Fix the bugs in src/math.js so that the tests in test/math.test.js pass (run them with: node --test test/math.test.js). Reply in two sentences.`);
const tests = (() => { try { execFileSync("node", ["--test", "test/math.test.js"], { cwd: proj, stdio: "pipe" }); return "pass"; } catch { return "fail"; } })();
log("implement", { state: v.job.state, err: v.job.errorCode, reason: v.job.failureReason, files: v.result?.files, tests, perm: v.result?.permission && { mode: v.result.permission.effectiveMode, answered: v.result.permission.answeredRequests.length }, model: v.result?.model, text: v.result?.finalText?.slice(-200) });

v = await turn(s.id, "analyze", "What token did I ask you to remember? Reply with the token only.");
log("recall_L1", { state: v.job.state, text: v.result?.finalText?.trim().slice(-60), ok: v.result?.finalText?.includes(token) });

const native = (await svc.getSession(s.id)).nativeSessionId;
for (let i = 0; i < 60 && (await svc.getSession(s.id)).state !== "suspended"; i++) await new Promise((r) => setTimeout(r, 1000));
log("suspended", { state: (await svc.getSession(s.id)).state });

v = await turn(s.id, "analyze", "What token did I ask you to remember earlier in this conversation? Reply with the token only.");
log("recall_L2", { state: v.job.state, err: v.job.errorCode, text: v.result?.finalText?.trim().slice(-60), ok: v.result?.finalText?.includes(token), sameNative: (await svc.getSession(s.id)).nativeSessionId === native });

const r = await svc.submitTurn({ sessionId: s.id, intent: "implement", prompt: "Run the shell command `sleep 60 && echo slept` and tell me what it printed.", requestId: `live-${randomBytes(6).toString("hex")}`, host });
if (r.kind === "accepted") {
  for (let i = 0; i < 40 && (await svc.getJob({ jobId: r.job.id })).job.state !== "running"; i++) await new Promise((x) => setTimeout(x, 500));
  await new Promise((x) => setTimeout(x, 8000));
  const c0 = Date.now();
  await svc.cancelJob(r.job.id);
  let cv;
  for (;;) { cv = await svc.getJob({ jobId: r.job.id, waitMs: 5000 }); if (cv.terminal) break; }
  log("cancel", { state: cv.job.state, ms: Date.now() - c0 });
}
await svc.closeSession(s.id, "cancel_running");
console.log(JSON.stringify(out, null, 2));
process.exit(0);
