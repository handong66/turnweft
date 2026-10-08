import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalService } from "../runtime/service.js";
import { Store } from "../runtime/store.js";
import { runWorker } from "../runtime/worker.js";
import { parsePolicyUntil } from "../runtime/policy.js";
import { ADAPTERS } from "../adapters/providers.js";
import { providerEnv } from "../adapters/env.js";
import { redact } from "../runtime/secrets.js";
import { jobWarnings } from "../mcp/envelope.js";
import { confirmationRequired, createMcpServer } from "../mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli } from "../cli/main.js";
import { PassThrough, Writable } from "node:stream";

const host = { hostKind: "codex" as const, conversationId: "u25" };
function fixture(t: import("node:test").TestContext) {
  const home = mkdtempSync(join(tmpdir(), "tw-u25-"));
  const keys = ["TURNWEFT_HOME", "TURNWEFT_FAKE_ADAPTERS", "TURNWEFT_FAKE_EXCESS", "TURNWEFT_IDLE_RELEASE_MS"];
  const prev = keys.map(k => process.env[k]);
  Object.assign(process.env, { TURNWEFT_HOME: home, TURNWEFT_FAKE_ADAPTERS: "1", TURNWEFT_FAKE_EXCESS: "1", TURNWEFT_IDLE_RELEASE_MS: "1" });
  const store = new Store(); const svc = new LocalService(store, { spawnWorker: () => {} });
  const config = (x: unknown) => writeFileSync(join(home, "config.json"), JSON.stringify(x));
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); keys.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; }); });
  return { home, store, svc, config };
}

test("U25: fail-fast config and call precedence; no waiting job, no FIFO blocker; authorized work runs", async t => {
  const { home, store, svc, config } = fixture(t);
  const s = await svc.createSession({ provider: "dim", cwd: home, host });
  for (const [mode, flag, blocked] of [["wait", true, true], ["fail-fast", false, true], ["fail-fast", undefined, true], ["wait", false, false]] as const) {
    config({ confirmationMode: mode });
    const o = await svc.submitTurn({ sessionId: s.id, intent: "implement", prompt: "hello", requestId: `${mode}-${flag}`, host, nonInteractive: flag });
    assert.equal(o.kind, blocked ? "needs_confirmation" : "awaiting_confirmation");
    if (blocked) assert.equal(store.jobsForSession(s.id).length, 0);
    else if (o.kind === "awaiting_confirmation") await svc.cancelJob(o.job.id);
  }
  config({ confirmationMode: "fail-fast" });
  const o = await svc.submitTurn({ sessionId: s.id, intent: "implement", prompt: "hello", requestId: "bypass", host, hostBypass: "codex:danger-full-access" });
  assert.equal(o.kind, "accepted"); if (o.kind !== "accepted") return;
  assert.equal(o.job.confirmationMode, "fail-fast");
  await runWorker(s.id, store);
  assert.equal(store.getJob(o.job.id)?.state, "succeeded");
});

test("U25: fresh bypass retry releases only the matching waiting job and binds current digest", async t => {
  const { home, store, svc } = fixture(t);
  const s = await svc.createSession({ provider: "dim", cwd: home, host });
  const input = { sessionId: s.id, intent: "implement" as const, prompt: "hello", requestId: "first", host };
  const a = await svc.submitTurn(input);
  const b = await svc.submitTurn({ ...input, requestId: "second" });
  assert.equal(a.kind, "awaiting_confirmation"); assert.equal(b.kind, "awaiting_confirmation");
  if (a.kind !== "awaiting_confirmation" || b.kind !== "awaiting_confirmation") return;
  assert.equal(a.proposal.proposalId, b.proposal.proposalId);
  const conflict = await svc.submitTurn({ ...input, prompt: "changed", hostBypass: "codex:danger-full-access" });
  assert.equal(conflict.kind, "rejected");
  writeFileSync(join(home, "fake-tier.txt"), "new-tier");
  const retry = await svc.submitTurn({ ...input, hostBypass: "codex:danger-full-access", nonInteractive: true });
  assert.equal(retry.kind, "accepted");
  assert.equal(store.getJob(a.job.id)?.state, "queued");
  assert.equal(store.getJob(b.job.id)?.state, "waiting_confirmation");
  assert.equal(store.getProposal(a.proposal.proposalId)?.decision, undefined);
  assert.equal(store.listPolicies().length, 0);
  await svc.cancelJob(b.job.id);
  await runWorker(s.id, store);
  assert.equal(store.getJob(a.job.id)?.state, "succeeded");
  const again = await svc.submitTurn({ ...input, hostBypass: "codex:danger-full-access" });
  assert.equal(again.kind === "accepted" && again.job.state, "succeeded");
});

test("U25: expired, failed, delivered and in_doubt requests never revive via bypass", async t => {
  const { home, svc, store } = fixture(t);
  const s = await svc.createSession({ provider: "dim", cwd: home, host });
  for (const state of ["failed", "in_doubt", "waiting_confirmation"] as const) {
    const input = { sessionId: s.id, prompt: state, intent: "implement" as const, requestId: state, host };
    const o = await svc.submitTurn(input); assert.equal(o.kind, "awaiting_confirmation"); if (o.kind !== "awaiting_confirmation") return;
    store.updateJob(o.job.id, { state, ...(state === "waiting_confirmation" ? { deliveredAt: "already" } : {}) });
    await svc.submitTurn({ ...input, hostBypass: "codex:danger-full-access" });
    assert.equal(store.getJob(o.job.id)?.state, state);
    await svc.cancelJob(o.job.id);
  }
  const input = { sessionId: s.id, prompt: "expired", intent: "implement" as const, requestId: "expired", host };
  const o = await svc.submitTurn(input); if (o.kind !== "awaiting_confirmation") throw new Error("waiting expected");
  store.db.prepare("UPDATE proposals SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", o.proposal.proposalId);
  await svc.submitTurn({ ...input, hostBypass: "codex:danger-full-access" });
  assert.equal(store.getJob(o.job.id)?.errorCode, "confirmation_expired");
});

test("U25: terminal pre-authorization writes expiry; submit and worker start enforce it", async t => {
  const { home, svc, store, config } = fixture(t);
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  let output = "", prompt = "";
  const stdout = Object.assign(new Writable({ write(c, _, done) { output += c; done(); } }), { isTTY: true });
  const stderr = new Writable({ write(c, _, done) { prompt += c; if (String(c).includes("Type yes")) setImmediate(() => stdin.write("yes\n")); done(); } });
  const expiry = new Date(Date.now() + 60_000).toISOString();
  process.env.TURNWEFT_LANG = "en";
  assert.equal(await runCli(["policy", "grant", "--provider", "dim", "--root", home, "--intent", "implement", "--until", expiry, "--json"], svc, { stdin, stdout, stderr }), 0);
  stdin.destroy(); delete process.env.TURNWEFT_LANG;
  const p = JSON.parse(output).data;
  assert.equal(p.expiresAt, expiry); assert.match(prompt, /tier|档位/i); assert.ok(prompt.includes(expiry));
  config({ confirmationMode: "fail-fast" });
  const s = await svc.createSession({ provider: "dim", cwd: home, host });
  const input = { sessionId: s.id, intent: "implement" as const, prompt: "hello", requestId: "queued", host };
  const accepted = await svc.submitTurn(input); assert.equal(accepted.kind, "accepted"); if (accepted.kind !== "accepted") return;
  store.db.prepare("UPDATE policies SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", p.id);
  assert.equal((await svc.submitTurn({ ...input, requestId: "after-expiry" })).kind, "needs_confirmation");
  await runWorker(s.id, store);
  assert.equal(store.getJob(accepted.job.id)?.errorCode, "policy_expired");
  assert.equal(store.getJob(accepted.job.id)?.deliveredAt, undefined);
  output = "";
  await runCli(["policy", "list", "--json"], svc, { stdin, stdout, stderr });
  assert.equal(JSON.parse(output).data[0].status, "expired");
});

test("U25: --until parsing is bounded and unambiguous", () => {
  const current = new Date("2026-10-08T12:00:00Z");
  assert.equal(parsePolicyUntil("2026-10-08T15:00:00+02:00", current), "2026-10-08T13:00:00.000Z");
  const next = Date.parse(parsePolicyUntil("11:00", current));
  assert.ok(next > current.getTime() && next - current.getTime() <= 24 * 60 * 60_000);
  for (const value of ["yesterday", "25:00", "2026-10-08T13:00:00", "2020-01-01T00:00:00Z"]) assert.throws(() => parsePolicyUntil(value, current));
});

test("U25 review: short provider values preserve output and reach launches unchanged", t => {
  const { config } = fixture(t);
  const env = { VERBOSE: "1", DEBUG: "true", EMPTY: "", SHORT: "1234567", SECRET: "12345678" };
  config({ providerEnv: { agy: env } });
  const launched = providerEnv("agy", {}, undefined, "agy");
  for (const [key, value] of Object.entries(env)) assert.equal(launched[key], value);
  const output = { finalText: "true 1 1234567", jobId: "twj_123", at: "2026-10-08T11:01:00Z", version: "1.2.3", diff: "+ true 1", nested: [env.SECRET] };
  assert.deepEqual(redact(output), { ...output, nested: ["[REDACTED]"] });
});

test("U25 review: redaction caches config by mtime/size and drops removed config-only values", t => {
  const { home, config } = fixture(t);
  const file = join(home, "config.json");
  const first = "first-test-secret", next = "other-test-secret", larger = "larger-test-secret-value";
  const parse = t.mock.method(JSON, "parse");
  config({ providerEnv: { agy: { TOKEN: first } } });
  utimesSync(file, 1000, 1000);
  assert.equal(redact(first), "[REDACTED]");
  const parsed = parse.mock.callCount();
  for (let i = 0; i < 10; i++) assert.equal(redact(first), "[REDACTED]");
  assert.equal(parse.mock.callCount(), parsed, "unchanged config is not parsed per event");
  config({ providerEnv: { agy: { TOKEN: next } } });
  utimesSync(file, 1001, 1001); // Same size, different mtime.
  assert.deepEqual(redact([first, next]), [first, "[REDACTED]"]);
  config({ providerEnv: { agy: { TOKEN: larger } } });
  utimesSync(file, 1001, 1001); // Same mtime, different size.
  assert.deepEqual(redact([next, larger]), [next, "[REDACTED]"]);
  providerEnv("agy", {}, undefined, "agy"); // Actual launch snapshots survive removal.
  config({});
  assert.deepEqual(redact([first, next, larger]), [first, next, "[REDACTED]"]);
  config({ providerEnv: { agy: { TOKEN: next } } });
  assert.equal(redact(next), "[REDACTED]");
  rmSync(file);
  assert.deepEqual(redact([next, larger]), [next, "[REDACTED]"]);
});

test("U25 review: waiting bypass retries reject closed/broken sessions, including a probe race", async t => {
  const { home, svc, store } = fixture(t);
  for (const state of ["closed", "broken"] as const) {
    for (const racing of [false, true]) {
      const s = await svc.createSession({ provider: "dim", cwd: home, host });
      const input = { sessionId: s.id, intent: "implement" as const, prompt: "hello", requestId: `${state}-${racing}`, host };
      const o = await svc.submitTurn(input);
      assert.equal(o.kind, "awaiting_confirmation"); if (o.kind !== "awaiting_confirmation") return;
      const original = store.getSession.bind(store);
      // First read sees ready; the transaction after the async probe sees the changed session.
      const mock = racing ? t.mock.method(store, "getSession", (id: string) => {
        const snapshot = original(id);
        if (id === s.id) store.updateSession(id, { state });
        return snapshot;
      }, { times: 1 }) : undefined;
      if (!racing) store.updateSession(s.id, { state });
      const retry = await svc.submitTurn({ ...input, hostBypass: "codex:danger-full-access" });
      mock?.mock.restore();
      assert.equal(retry.kind, "rejected");
      assert.equal(retry.kind === "rejected" && retry.code, `session_${state}`);
      assert.equal(store.getJob(o.job.id)?.state, "waiting_confirmation");
      assert.equal(store.getJob(o.job.id)?.hostBypass, undefined);
    }
  }
});

test("U25 review: idempotent retries require the submitting host to be attached", async t => {
  const { home, svc } = fixture(t);
  const s = await svc.createSession({ provider: "dim", cwd: home, host });
  const input = { sessionId: s.id, intent: "implement" as const, prompt: "hello", requestId: "bound", host };
  await svc.submitTurn(input);
  const retry = await svc.submitTurn({ ...input, host: { ...host, conversationId: "unbound" }, hostBypass: "codex:danger-full-access" });
  assert.equal(retry.kind === "rejected" && retry.code, "not_attached");
});

test("U25 review: fail-fast job queries mark blocked with localized MCP/CLI warnings", async t => {
  const { home, svc, store, config } = fixture(t);
  const s = await svc.createSession({ provider: "dim", cwd: home, host });
  const o = await svc.submitTurn({ sessionId: s.id, intent: "implement", prompt: "hello", requestId: "query", host });
  assert.equal(o.kind, "awaiting_confirmation"); if (o.kind !== "awaiting_confirmation") return;
  assert.equal((await svc.getJob({ jobId: o.job.id })).nextAction, "confirm_policy");
  // Defensive legacy/recovery state: fresh fail-fast submissions never create waiting jobs.
  store.updateJob(o.job.id, { confirmationMode: "fail-fast" });
  const previous = process.env.TURNWEFT_LANG;
  delete process.env.TURNWEFT_LANG;
  t.after(() => { if (previous === undefined) delete process.env.TURNWEFT_LANG; else process.env.TURNWEFT_LANG = previous; });
  let dialogs = 0;
  const server = createMcpServer(svc, { showDialog: () => { dialogs++; return true; } });
  const client = new Client({ name: "test", version: "test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  for (const language of ["en", "zh"] as const) {
    config({ language });
    const view = await svc.getJob({ jobId: o.job.id });
    assert.equal(view.nextAction, "mark_blocked");
    const warnings = jobWarnings(view);
    assert.match(warnings.join(" "), language === "en" ? /Mark this task blocked/ : /标记为受阻/);
    assert.equal(warnings[0], confirmationRequired(o.proposal, undefined, true).warnings[0]);
    const result = await client.callTool({ name: "turnweft_job", arguments: { jobId: o.job.id } });
    const envelope = result.structuredContent as { data: { nextAction: string }; warnings: string[] };
    assert.equal(envelope.data.nextAction, "mark_blocked"); assert.deepEqual(envelope.warnings, warnings);
    let output = "";
    const stream = new Writable({ write(c, _, done) { output += c; done(); } });
    await runCli(["job", "status", o.job.id, "--json"], svc, { stdin: new PassThrough(), stdout: stream, stderr: stream });
    assert.equal(JSON.parse(output).data.nextAction, "mark_blocked");
    assert.deepEqual(JSON.parse(output).warnings, warnings);
  }
  assert.equal(dialogs, 0);
});

test("U25: providerEnv reaches probes and launches, reloads, and redacts persisted/output values", async t => {
  const { home, store, config } = fixture(t);
  const exe = join(home, "agy");
  // Fake protocol provider deliberately echoes its launch secret, including on stderr.
  writeFileSync(exe, `#!${process.execPath}\nconst s = process.env.TW_TEST_SECRET;
if (process.argv.includes('--version')) { console.log(s ? '1.2.3' : ''); process.exit(s ? 0 : 1); }
console.error(s);
console.log(JSON.stringify({event:'init',conversation_id:'test',init:{permission_mode:'request-review'}}));
require('node:readline').createInterface({input:process.stdin}).on('line',()=>console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:s}})));
`); chmodSync(exe, 0o755);
  const secret = "private-test-token-123";
  config({ executables: { agy: exe }, providerEnv: { agy: { TW_TEST_SECRET: secret } } });
  assert.equal((await ADAPTERS.agy.probe()).available, true);
  const connection = ADAPTERS.agy.connect(home);
  try {
    await connection.open({ cwd: home, tier: ADAPTERS.agy.tierFor("analyze", await ADAPTERS.agy.probe()) });
    let result = "";
    await connection.prompt("hello", e => { if (e.type === "text") result += e.text; });
    assert.equal(result, secret);
    store.insertSession({ id: "s", provider: "agy", cwd: home, canonicalRoot: home, state: "ready", hostBindings: [], createdAt: "now", updatedAt: "now" });
    store.insertJob({ id: "j", sessionId: "s", requestId: "r", prompt: "hello", promptDigest: "digest", intent: "analyze", state: "queued", acceptedAt: "now" });
    config({ providerEnv: { agy: { TW_TEST_SECRET: "replacement-test-token" } } });
    assert.equal(providerEnv(exe, {}, undefined, "agy").TW_TEST_SECRET, "replacement-test-token");
    store.appendEvent("j", "diagnostic", "agy", { message: secret });
    store.updateJob("j", { failureReason: secret });
    store.setJobResult("j", { sessionId: "s", jobId: "j", provider: "agy", cwd: home, adapterVersion: "test", state: "succeeded", finalText: result, resultComplete: true, truncated: false, toolCalls: [] });
    assert.ok(!JSON.stringify([store.getJob("j"), store.events("j", 0), store.getJobResult("j")]).includes(secret));
    assert.ok(!readFileSync(join(home, "state.sqlite")).includes(Buffer.from(secret)));
  } finally { await connection.close(); }
});

test("U25: policy expiry never kills a running job", async t => {
  const { home, svc, store } = fixture(t);
  const proposal = await svc.proposePolicy({ provider: "dim", root: home, intent: "implement" });
  const policy = await svc.confirmPolicy({ proposalId: proposal.proposalId, nonce: proposal.nonce, via: "cli-tty", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const s = await svc.createSession({ provider: "dim", cwd: home, host });
  const o = await svc.submitTurn({ sessionId: s.id, prompt: "SLEEP:300", intent: "implement", requestId: "running", host });
  assert.equal(o.kind, "accepted"); if (o.kind !== "accepted") return;
  const running = runWorker(s.id, store);
  const deadline = Date.now() + 5000;
  while (!store.getJob(o.job.id)?.deliveredAt) {
    assert.ok(Date.now() < deadline, "worker delivered prompt");
    await new Promise(r => setTimeout(r, 5));
  }
  store.db.prepare("UPDATE policies SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", policy.id);
  await running;
  assert.equal(store.getJob(o.job.id)?.state, "succeeded");
});

test("U25: worker provider launch receives config, redacts echo, and doctor never shows values", async t => {
  const { home, svc, store, config } = fixture(t);
  delete process.env.TURNWEFT_FAKE_ADAPTERS;
  const exe = join(home, "agy");
  const secret = "worker-launch-test-secret";
  writeFileSync(exe, `#!${process.execPath}\nconst secret=process.env.WORKER_SECRET;
if(process.argv.includes('--version')) { console.log('1.2.3'); process.exit(secret ? 0 : 1); }
if(!secret) process.exit(1);
console.error(secret);
console.log(JSON.stringify({event:'init',conversation_id:'worker-native',init:{permission_mode:'request-review'}}));
require('node:readline').createInterface({input:process.stdin}).on('line',()=>console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:secret}})));
`); chmodSync(exe, 0o755);
  config({ executables: { agy: exe }, providerEnv: { agy: { WORKER_SECRET: secret } }, cancelGraceMs: 50 });
  const session = await svc.createSession({ provider: "agy", cwd: home, host });
  const o = await svc.submitTurn({ sessionId: session.id, prompt: "echo environment", requestId: "env-worker", intent: "analyze", host });
  if (o.kind !== "accepted") throw new Error("expected accepted");
  await runWorker(session.id, store);
  assert.equal(store.getJob(o.job.id)?.state, "succeeded");
  assert.equal(store.getJobResult(o.job.id)?.finalText, "[REDACTED]");
  assert.ok(!JSON.stringify(store.events(o.job.id, 0)).includes(secret));
  let output = "";
  const stream = new Writable({ write(c, _, done) { output += c; done(); } });
  // Restrict doctor to the fake provider; never probe a real installed provider in tests.
  const probeService = { listAgents: () => Promise.all([ADAPTERS.agy.probe()]) } as unknown as import("../core/service.js").TurnweftService;
  await runCli(["doctor", "--json"], probeService, { stdin: new PassThrough(), stdout: stream, stderr: stream });
  assert.ok(!output.includes(secret)); assert.equal(JSON.parse(output).data[0].available, true);
  config({ executables: { agy: exe } });
  const failed = await ADAPTERS.agy.probe();
  assert.equal(failed.available, false); assert.match(failed.problems.join(" "), /providerEnv.agy/);
});
