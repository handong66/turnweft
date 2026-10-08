import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { after } from "node:test";
import { text as messageText } from "../core/i18n.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PassThrough, Readable, Writable } from "node:stream";
import { test } from "node:test";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../cli/main.js";
import { FakeService, policy, proposal } from "./mcp-fixture.test.js";

function harness(input = "", tty = false, stdoutTTY = tty) {
  let out = ""; let err = "";
  const stdin = Object.assign(Readable.from([input]), { isTTY: tty });
  const stdout = Object.assign(new Writable({ write(chunk, _, done) { out += String(chunk); done(); } }), { isTTY: stdoutTTY });
  const stderr = new Writable({ write(chunk, _, done) { err += String(chunk); done(); } });
  return { io: { stdin, stdout, stderr }, stdout: () => out, stderr: () => err, envelope: () => JSON.parse(out) };
}

process.env.TURNWEFT_LANG = "en";
const testHome = mkdtempSync(join(tmpdir(), "tw-cli-test-"));
process.env.TURNWEFT_HOME = testHome;
after(() => rmSync(testHome, { recursive: true, force: true }));

test("policy grant requires both stdin and stdout TTY before service initialization", async () => {
  for (const [inputTTY, outputTTY] of [[false, false], [false, true], [true, false]]) {
    const h = harness("yes\n", inputTTY, outputTTY);
    let loaded = false;
    assert.equal(await runCli(["policy", "grant", "twp_proposal", "--json"], async () => { loaded = true; throw new Error("must not initialize"); }, h.io), 1);
    assert.equal(h.envelope().error.code, "tty_required"); assert.equal(loaded, false);
  }
});

test("actual CLI entrypoint rejects piped policy grant without loading temporary runtime", () => {
  const process = spawnSync(globalThis.process.execPath, [new URL("../cli/main.js", import.meta.url).pathname, "policy", "grant", "twp_proposal", "--json"], { input: "yes\n", encoding: "utf8" });
  assert.equal(process.status, 1); assert.equal(process.stderr, "");
  assert.equal(JSON.parse(process.stdout).error.code, "tty_required");
});

test("CLI invoked through an npm-bin-style symlink prints help", async t => {
  const directory = await mkdtemp(join(tmpdir(), "turnweft-cli-bin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "turnweft");
  await symlink(fileURLToPath(new URL("../cli/main.js", import.meta.url)), bin);
  const result = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0); assert.equal(result.stderr, "");
  assert.match(result.stdout, /^Turnweft\n/); assert.match(result.stdout, /policy grant/);
});

test("automatic approval parameters are rejected even when streams claim TTY", async () => {
  for (const flag of ["--yes", "--approved", "--confirmed", "--via", "--nonce"]) {
    const h = harness("yes\n", true); const service = new FakeService();
    assert.equal(await runCli(["policy", "grant", "twp_proposal", "--json", flag], service, h.io), 1);
    assert.equal(h.envelope().ok, false); assert.deepEqual(service.calls, []);
  }
});

test("TTY grant displays proposal details without nonce and only exact manual yes confirms", async () => {
  for (const json of [false, true]) for (const answer of ["yes", "no", "YES", "true", " yes ", ""]) {
    const h = harness("", true);
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const service = new FakeService();
    let responded = false;
    const terminal = Object.assign(new Writable({ write(chunk, _, done) {
      (json ? h.io.stderr : h.io.stdout).write(chunk);
      if (!responded && String(chunk).includes("Type yes")) { responded = true; setImmediate(() => stdin.write(`${answer}\n`)); }
      done();
    } }), { isTTY: true });
    const code = await runCli(["policy", "grant", "twp_proposal", ...(json ? ["--json"] : [])], service, { ...h.io, stdin, ...(json ? { stderr: terminal } : { stdout: terminal }) });
    stdin.destroy();
    const text = json ? h.stderr() : h.stdout();
    assert.ok(text.startsWith(`${proposal.message}\n\nProvider:`));
    for (const [label, value] of [["Provider", proposal.provider], ["Project", proposal.canonicalRoot], ["Intent", proposal.intent], ["Tier", proposal.tier], ["Expires at", proposal.expiresAt], ["Proposal ID", proposal.proposalId], ["CLI version", proposal.cliVersion], ["Adapter version", proposal.adapterVersion], ["Capability digest", proposal.capabilityDigest]]) {
      assert.ok(text.includes(`${label}: ${value}\n`));
    }
    assert.ok(text.includes("Excess over grant:\n  - git commit\n  - trusted network\n"));
    assert.ok(!`${h.stdout()}${h.stderr()}`.includes("Nonce:"));
    assert.ok(!`${h.stdout()}${h.stderr()}`.includes(proposal.nonce));
    assert.equal(code, answer === "yes" ? 0 : 1);
    assert.deepEqual(service.confirmations, answer === "yes" ? [{ proposalId: proposal.proposalId, nonce: proposal.nonce, via: "cli-tty" }] : []);
    if (json) {
      assert.equal(h.envelope().ok, answer === "yes");
      if (answer === "yes") assert.deepEqual(h.envelope().data, { ...policy, confirmedVia: "cli-tty" });
    } else if (answer === "yes") {
      assert.ok(h.stdout().endsWith(messageText("confirmed", { provider: policy.provider, intent: policy.intent, tier: policy.tier, root: policy.canonicalRoot, id: policy.id }) + "\n"));
      assert.ok(!h.stdout().includes('"confirmedVia"'));
    } else assert.ok(!h.stdout().includes("Confirmed:"));
  }
});

test("missing proposal never asks for consent or grants a policy", async () => {
  const h = harness("", true); const service = new FakeService(); service.foundProposal = undefined;
  assert.equal(await runCli(["policy", "grant", "missing", "--json"], service, h.io), 1);
  assert.equal(h.envelope().error.code, "proposal_not_found"); assert.equal(h.stderr(), "");
  assert.equal(service.confirmations.length, 0);
});

test("TTY EOF during confirmation fails closed and returns an Envelope", async () => {
  const h = harness("", true); const service = new FakeService();
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stderr = new Writable({ write(chunk, _, done) {
    h.io.stderr.write(chunk);
    if (String(chunk).includes("Type yes")) setImmediate(() => stdin.end());
    done();
  } });
  assert.equal(await runCli(["policy", "grant", "twp_proposal", "--json"], service, { ...h.io, stdin, stderr }), 1);
  assert.equal(h.envelope().error.code, "confirmation_cancelled"); assert.equal(service.confirmations.length, 0);
});

test("doctor and agents list probe only, emit an Envelope and never submit tasks", async () => {
  for (const argv of [["doctor"], ["agents", "list", "--refresh"]]) {
    const h = harness(); const service = new FakeService();
    assert.equal(await runCli([...argv, "--json"], service, h.io), 0);
    assert.equal(h.envelope().ok, true);
    assert.deepEqual(service.calls.map(call => call.method), ["listAgents"]);
    assert.equal(service.submissions.length, 0); assert.equal(h.stderr(), "");
  }
});

test("send reads stdin, prints generated requestId before submission and respects explicit retries", async () => {
  const h = harness("Inspect the bounded task"); const service = new FakeService();
  assert.equal(await runCli(["send", "--session", "tws_session", "--json"], service, h.io), 0);
  const requestId = service.submissions[0]!.requestId;
  assert.match(requestId, /^[0-9a-f-]{36}$/); assert.match(h.stderr(), new RegExp(requestId));
  assert.equal(h.envelope().data.requestId, requestId);
  assert.equal(service.submissions[0]!.prompt, "Inspect the bounded task");
  assert.equal(service.submissions[0]!.intent, "analyze");
  const retry = harness("Inspect the bounded task");
  assert.equal(await runCli(["send", "--session", "tws_session", "--request-id", requestId, "--json"], service, retry.io), 0);
  assert.deepEqual(service.submissions[0], service.submissions[1]); assert.equal(retry.stderr(), "");
});

test("send can read a prompt file and never auto-confirms proposals", async () => {
  const h = harness("ignored input"); const service = new FakeService(); service.confirmationNeeded = true;
  const path = new URL("../../src/core/service.ts", import.meta.url).pathname;
  assert.equal(await runCli(["send", "--session", "tws_session", "--intent", "implement", "--prompt-file", path, "--request-id", "saved-request", "--json"], service, h.io), 0);
  assert.equal(service.submissions[0]!.prompt, await readFile(path, "utf8"));
  assert.equal(h.envelope().data.nextAction, "confirm_policy");
  assert.match(h.envelope().warnings.join(" "), /turnweft policy grant twp_proposal/);
  assert.deepEqual(service.confirmations, []); assert.equal(service.submissions.length, 1);
});

test("job queries clamp waits, pass cursors and retain ok for a failed job", async () => {
  for (const [action, wait, includeResult] of [["status", 0, false], ["wait", 25_000, false], ["result", 0, true]] as const) {
    const h = harness(); const service = new FakeService();
    assert.equal(await runCli(["job", action, "twj_job", "--json"], service, h.io), 0);
    assert.equal(h.envelope().data.job.state, "failed"); assert.equal(h.envelope().ok, true);
    const input = service.calls[0]!.input as Record<string, unknown>;
    assert.equal(input.waitMs, wait); assert.equal(input.includeResult, includeResult);
  }
  const h = harness(); const service = new FakeService();
  await runCli(["job", "result", "twj_job", "--json", "--wait-ms", "90000", "--after-seq", "3", "--result-offset", "4", "--result-limit", "5"], service, h.io);
  assert.deepEqual(service.calls[0]!.input, { jobId: "twj_job", waitMs: 25_000, afterSeq: 3, includeResult: true, resultOffset: 4, resultLimit: 5 });
});

test("session, cancellation and policy commands use only service methods", async () => {
  const cases: Array<[string[], string]> = [
    [["session", "create", "--agent", "droid", "--cwd", "/project"], "createSession"],
    [["session", "list"], "listSessions"], [["session", "get", "tws_session"], "getSession"],
    [["session", "attach", "tws_session"], "attachSession"], [["session", "close", "tws_session"], "closeSession"],
    [["session", "update", "tws_session", "--effort", "high"], "updateSession"],
    [["cancel", "twj_job"], "cancelJob"], [["policy", "list"], "listPolicies"], [["policy", "revoke", "twpolicy_policy"], "revokePolicy"],
  ];
  for (const [argv, method] of cases) {
    const h = harness(); const service = new FakeService();
    assert.equal(await runCli([...argv, "--json"], service, h.io), 0);
    assert.equal(h.envelope().ok, true); assert.deepEqual(service.calls.map(call => call.method), [method]);
  }
});

test("U23: session create passes --model and --effort through unchanged", async () => {
  const h = harness(); const service = new FakeService();
  assert.equal(await runCli(["session", "create", "--agent", "dim", "--cwd", "/project", "--model", "m", "--effort", "max", "--json"], service, h.io), 0);
  const input = service.calls[0]!.input as { model?: string; effort?: string };
  assert.equal(input.model, "m"); assert.equal(input.effort, "max");
  const empty = harness(); const passthrough = new FakeService();
  await runCli(["session", "create", "--agent", "dim", "--cwd", "/project", "--effort", "", "--json"], passthrough, empty.io);
  assert.equal((passthrough.calls[0]!.input as { effort?: string }).effort, "", "an empty value reaches the service, which rejects it");
});

test("separate CLI create, attach and send calls use the same CLI host identity", async () => {
  const service = new FakeService();
  await runCli(["session", "create", "--agent", "droid", "--cwd", "/project", "--json"], service, harness().io);
  await runCli(["session", "attach", "tws_session", "--json"], service, harness().io);
  await runCli(["send", "--session", "tws_session", "--request-id", "cli-request", "--json"], service, harness("Analyze this project").io);
  const expected = { hostKind: "cli", connectionId: "cli" };
  for (const call of service.calls) assert.deepEqual((call.input as { host: unknown }).host, expected);
});

test("invalid CLI arguments and empty prompts fail before any task submission", async () => {
  for (const argv of [
    ["session", "create", "--cwd", "/project"], ["session", "get"], ["session", "list", "--agent", "unknown"],
    ["send", "--session", "tws_session", "--intent", "unsafe"], ["send", "--session", "tws_session", "--request-id", ""],
    ["job", "status", "twj_job", "--wait-ms", "-1"], ["job", "status", "twj_job", "--result-limit", "0"],
    ["doctor", "--model", "not-allowed"], ["policy", "grant"], ["session", "close", "id", "--policy", "unsafe"],
  ]) {
    const h = harness(); const service = new FakeService();
    assert.equal(await runCli([...argv, "--json"], service, h.io), 1);
    assert.equal(h.envelope().ok, false); assert.deepEqual(service.calls, []);
  }
  const h = harness(" "); const service = new FakeService();
  assert.equal(await runCli(["send", "--session", "tws_session", "--json"], service, h.io), 1);
  assert.equal(service.submissions.length, 0);
});

test("human output is concise and retains confirmation guidance; --json help is an Envelope", async () => {
  const h = harness(); const service = new FakeService();
  await runCli(["job", "status", "twj_job"], service, h.io);
  assert.equal(h.stdout(), "twj_job: failed; next: none\n");
  const help = harness(); await runCli(["--help", "--json"], service, help.io);
  assert.equal(help.envelope().ok, true); assert.match(help.envelope().data, /policy grant/);
});

test("plugins launch through the shared launcher (U16) and declare skills", async () => {
  const shared = await readFile(new URL("../../plugins/shared/launcher.mjs", import.meta.url), "utf8");
  const codex = new URL("../../plugins/codex/", import.meta.url);
  const registration = JSON.parse(await readFile(new URL(".mcp.json", codex), "utf8"));
  const manifest = JSON.parse(await readFile(new URL(".codex-plugin/plugin.json", codex), "utf8"));
  assert.equal(registration.mcpServers.turnweft.command, "node");
  assert.deepEqual(registration.mcpServers.turnweft.args, ["./launcher.mjs"]);
  assert.ok(registration.mcpServers.turnweft.env_vars.includes("PATH"));
  assert.equal(manifest.skills, "./skills/"); assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(await readFile(new URL("launcher.mjs", codex), "utf8"), shared, "codex launcher must match the shared source");
  const cc = new URL("../../plugins/claude-code/", import.meta.url);
  const ccReg = JSON.parse(await readFile(new URL(".mcp.json", cc), "utf8"));
  assert.deepEqual(ccReg.mcpServers.turnweft.args, ["${CLAUDE_PLUGIN_ROOT}/launcher.mjs"]);
  assert.equal(await readFile(new URL("launcher.mjs", cc), "utf8"), shared, "claude-code launcher must match the shared source");
});


test("Chinese CLI help and confirmation output use the message catalog", async () => {
  process.env.TURNWEFT_LANG = "zh";
  try {
    const help = harness();
    assert.equal(await runCli(["--help"], new FakeService(), help.io), 0);
    assert.equal(help.stdout(), messageText("usage", undefined, "zh") + "\n");
    const h = harness("", true);
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const terminal = Object.assign(new Writable({ write(chunk, _, done) {
      h.io.stdout.write(chunk);
      if (String(chunk).includes(messageText("grantPrompt", undefined, "zh"))) setImmediate(() => stdin.write("yes\n"));
      done();
    } }), { isTTY: true });
    assert.equal(await runCli(["policy", "grant", proposal.proposalId], new FakeService(), { ...h.io, stdin, stdout: terminal }), 0);
    stdin.destroy();
    assert.ok(h.stdout().includes(messageText("confirmed", { provider: policy.provider, intent: policy.intent, tier: policy.tier, root: policy.canonicalRoot, id: policy.id }, "zh")));
    assert.ok(h.stdout().startsWith(proposal.message), "stored proposal text is preserved");
  } finally { process.env.TURNWEFT_LANG = "en"; }
});

test("plugin manifests carry the package version", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const version = JSON.parse(readFileSync(`${root}package.json`, "utf8")).version;
  for (const rel of ["plugins/claude-code/.claude-plugin/plugin.json", "plugins/codex/.codex-plugin/plugin.json"]) {
    assert.equal(JSON.parse(readFileSync(`${root}${rel}`, "utf8")).version, version, `${rel} (run npm version, or node scripts/sync-version.mjs)`);
  }
});

test("U19/U21: send never takes a bypass signal and shows the dialog when a confirmation is needed", async () => {
  const dialogs: string[] = [];
  const h = harness("Implement it"); const service = new FakeService();
  assert.equal(await runCli(["send", "--session", "tws_session", "--intent", "implement", "--json"], service, h.io, { showDialog: (id) => { dialogs.push(id); return true; } }), 0);
  assert.equal(service.submissions.at(-1)!.hostBypass, undefined, "the CLI environment is not a trusted host signal");
  assert.equal(dialogs.length, 0, "accepted: no dialog");
  const waiting = harness("Implement it"); const w = new FakeService(); w.awaitingConfirmation = true;
  assert.equal(await runCli(["send", "--session", "tws_session", "--intent", "implement", "--json"], w, waiting.io, { showDialog: (id) => { dialogs.push(id); return true; } }), 0);
  assert.deepEqual(dialogs, [proposal.proposalId], "the CLI path shows the same dialog as MCP");
});

test("U24: CLI rejects per-task parallelWrites and renders overlap warnings in human and JSON output", async () => {
  const service = new FakeService();
  const rejected = harness();
  assert.equal(await runCli(["send", "--session", "tws_session", "--parallelWrites", "/project", "--json"], service, rejected.io), 1);
  assert.deepEqual(service.calls, []);
  const original = service.getJob.bind(service);
  service.getJob = async input => {
    const view = await original(input);
    return { ...view, job: { ...view.job, concurrentWrites: ["twj_other"] } };
  };
  for (const json of [false, true]) {
    const h = harness();
    assert.equal(await runCli(["job", "result", "twj_job", ...(json ? ["--json"] : [])], service, h.io), 0);
    if (json) assert.match(h.envelope().warnings[0], /twj_other.*overwrite/);
    else assert.match(h.stderr(), /twj_other.*overwrite/);
  }
});


test("R2: doctor explains each ignored parallelWrites entry", async () => {
  const file = join(testHome, "file"); writeFileSync(file, "x");
  writeFileSync(join(testHome, "config.json"), JSON.stringify({ parallelWrites: ["relative", 42, file, join(testHome, "missing"), testHome] }));
  try {
    const h = harness();
    await runCli(["doctor", "--json"], new FakeService(), h.io);
    const warnings = h.envelope().warnings;
    assert.equal(warnings.length, 4);
    for (const reason of ["not an absolute path", "not a string", "not a directory", "missing or inaccessible path"]) assert.ok(warnings.some((x: string) => x.includes(reason)));
  } finally { rmSync(join(testHome, "config.json")); }
});

test("U26: CLI renders deniedActions and empty_output warnings in human and JSON output", async () => {
  for (const code of ["denied_actions", "empty_output"] as const) {
    const service = new FakeService();
    const original = service.getJob.bind(service);
    service.getJob = async input => {
      const view = await original(input);
      return { ...view, result: { sessionId: view.session.id, jobId: view.job.id, provider: "droid" as const, adapterVersion: "test", cwd: "/project", state: "succeeded" as const, resultComplete: true, truncated: false, toolCalls: [], finalText: "", warningCodes: [code], deniedActions: [{ kind: "execute", title: "git show" }] } };
    };
    for (const json of [false, true]) {
      const h = harness();
      assert.equal(await runCli(["job", "result", "twj_job", ...(json ? ["--json"] : [])], service, h.io), 0);
      const output = json ? h.envelope().warnings.join(" ") : h.stderr();
      assert.match(output, code === "denied_actions" ? /execute:git show.*incomplete/ : /empty_output/);
    }
  }
});

test("U25: non-interactive CLI forwards only do-not-wait and never opens a dialog", async () => {
  const h = harness("hello"); const service = new FakeService(); service.confirmationNeeded = true;
  let dialogs = 0;
  assert.equal(await runCli(["send", "--session", "s", "--non-interactive", "--json"], service, h.io, { showDialog: () => { dialogs++; return true; } }), 0);
  assert.equal(service.submissions[0]?.nonInteractive, true);
  assert.equal(service.submissions[0]?.hostBypass, undefined);
  assert.equal(h.envelope().data.kind, "needs_confirmation"); assert.equal(dialogs, 0);
});

test("U25: pre-authorization requires TTY, rejects auto-yes and unbounded scope before initialization", async () => {
  const args = ["policy", "grant", "--provider", "agy", "--root", "/project", "--intent", "implement", "--until", "23:59", "--json"];
  for (const [tty, extra] of [[false, []], [true, ["--yes"]], [true, ["--all-projects"]]] as const) {
    const h = harness("yes\n", tty);
    let loaded = false;
    assert.equal(await runCli([...args, ...extra], async () => { loaded = true; throw new Error("must not initialize"); }, h.io), 1);
    assert.equal(loaded, false);
    if (!tty) assert.equal(h.envelope().error.code, "tty_required");
  }
});
