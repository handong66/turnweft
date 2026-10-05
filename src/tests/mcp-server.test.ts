import assert from "node:assert/strict";
import { mkdtempSync as tmpHome } from "node:fs";
import { tmpdir as osTmp } from "node:os";
import { join as joinPath } from "node:path";
// Keep diagnostics (~/.turnweft/logs/mcp.log) out of the user's real state directory.
process.env.TURNWEFT_HOME = tmpHome(joinPath(osTmp(), "tw-mcp-test-"));
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ClientCapabilities, ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { Envelope } from "../core/types.js";
import { createMcpServer } from "../mcp/server.js";
import type { McpServerOptions } from "../mcp/server.js";
import { FakeService, proposal } from "./mcp-fixture.test.js";

async function setup(t: TestContext, opts: {
  service?: FakeService; capabilities?: ClientCapabilities; name?: string; server?: McpServerOptions;
  elicit?: (request: ElicitRequest) => ElicitResult | Promise<ElicitResult>;
} = {}) {
  const service = opts.service ?? new FakeService();
  const server = createMcpServer(service, opts.server);
  const client = new Client({ name: opts.name ?? "Codex", version: "test" }, { capabilities: opts.capabilities ?? {} });
  if (opts.elicit) client.setRequestHandler(ElicitRequestSchema, opts.elicit);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { service, server, client, serverTransport, clientTransport };
}

async function call(client: Client, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args, _meta: meta });
  const envelope = result.structuredContent as Envelope<Record<string, unknown>>;
  assert.ok(envelope);
  const content = result.content as Array<{ type: string; text?: string }>;
  assert.deepEqual(JSON.parse(content[0]!.text!), envelope);
  assert.equal(result.isError, !envelope.ok);
  return envelope;
}
const turn = { sessionId: "tws_session", prompt: "Implement the bounded task", requestId: "saved-request" };

test("Envelope ok describes a processed query even when the job failed", async t => {
  const { client } = await setup(t);
  const result = await call(client, "turnweft_job", { jobId: "twj_job" });
  assert.equal(result.ok, true); assert.equal(result.error, null);
  assert.equal((result.data!.job as { state: string }).state, "failed");
});

test("strict per-action session schemas reject missing parameters and model approval fields", async t => {
  const { client, service } = await setup(t);
  const list = await client.listTools();
  assert.deepEqual(list.tools.map(tool => tool.name), ["turnweft_agents", "turnweft_session", "turnweft_ask", "turnweft_delegate", "turnweft_job", "turnweft_cancel"]);
  assert.equal(list.tools.find(tool => tool.name === "turnweft_session")?.annotations?.readOnlyHint, undefined);
  assert.equal((list.tools.find(tool => tool.name === "turnweft_session")!.inputSchema.oneOf as unknown[]).length, 5);
  for (const args of [
    { action: "create", provider: "droid" }, { action: "create", cwd: "/project" },
    ...["get", "attach", "close"].map(action => ({ action })),
    { action: "list", sessionId: "not-allowed" }, { action: "create", provider: "unknown", cwd: "/project" },
    { action: "close", sessionId: "id", policy: "unsafe" }, { action: "get", sessionId: "" },
  ]) assert.equal((await call(client, "turnweft_session", args)).error?.code, "invalid_arguments");
  for (const args of [{ ...turn, requestId: undefined }, { ...turn, approved: true }, { ...turn, confirmed: true }, { ...turn, host: { hostKind: "cli" } }]) {
    assert.equal((await call(client, "turnweft_delegate", args)).ok, false);
  }
  assert.deepEqual(service.calls, []);
});

test("session actions route to the service and do not invent missing sessions", async t => {
  const { client, service } = await setup(t);
  for (const args of [{ action: "create", provider: "droid", cwd: "/project", model: "explicit" }, { action: "list" }, ...["get", "attach", "close"].map(action => ({ action, sessionId: "tws_session" }))]) {
    assert.equal((await call(client, "turnweft_session", args)).ok, true);
  }
  assert.deepEqual(service.calls.map(call => call.method), ["createSession", "listSessions", "getSession", "attachSession", "closeSession"]);
  service.foundSession = undefined;
  assert.equal((await call(client, "turnweft_session", { action: "get", sessionId: "missing" })).error?.code, "session_not_found");
});

test("session list defaults to this_host; project scope requires a root and omits host", async t => {
  const { client, service } = await setup(t, { server: { connectionId: "this-connection" } });
  for (const args of [{ action: "list" }, { action: "list", scope: "this_host" }]) {
    assert.equal((await call(client, "turnweft_session", args)).ok, true);
  }
  assert.deepEqual(service.calls.map(call => call.input), [
    { host: { hostKind: "codex", connectionId: "this-connection" } },
    { host: { hostKind: "codex", connectionId: "this-connection" } },
  ]);
  assert.equal((await call(client, "turnweft_session", { action: "list", scope: "project" })).error?.code, "invalid_arguments");
  assert.equal((await call(client, "turnweft_session", { action: "list", scope: "all" })).error?.code, "invalid_arguments");
  assert.equal(service.calls.length, 2);
  assert.equal((await call(client, "turnweft_session", { action: "list", scope: "project", canonicalRoot: "/project", provider: "droid", includeClosed: true })).ok, true);
  assert.deepEqual(service.calls[2]!.input, { canonicalRoot: "/project", provider: "droid", includeClosed: true });
});

test("claude-code uses its nonempty environment session ID after Codex metadata", async t => {
  const previous = process.env.CLAUDE_CODE_SESSION_ID;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = previous; });
  process.env.CLAUDE_CODE_SESSION_ID = "cc-conversation";
  const { client, service } = await setup(t, { name: "claude-code", server: { connectionId: "fallback" } });
  await call(client, "turnweft_ask", turn);
  assert.deepEqual(service.submissions[0]!.host, { hostKind: "claude-code", conversationId: "cc-conversation" });
  await call(client, "turnweft_ask", turn, { "x-codex-turn-metadata": { thread_id: "codex-conversation" } });
  assert.deepEqual(service.submissions[1]!.host, { hostKind: "codex", conversationId: "codex-conversation" });
  for (const value of [undefined, "", "   "]) {
    if (value === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = value;
    await call(client, "turnweft_ask", turn);
    assert.deepEqual(service.submissions.at(-1)!.host, { hostKind: "claude-code", connectionId: "fallback" });
  }
  process.env.CLAUDE_CODE_SESSION_ID = "inherited-value";
  const codex = await setup(t, { name: "codex", server: { connectionId: "codex-fallback" } });
  await call(codex.client, "turnweft_ask", turn);
  assert.deepEqual(codex.service.submissions[0]!.host, { hostKind: "codex", connectionId: "codex-fallback" });
});

test("Codex thread_id binding takes priority; sandbox and workspaces stay diagnostic", async t => {
  const diagnostics: unknown[] = [];
  const { client, service } = await setup(t, { name: "Claude Code", server: { onDiagnostic: info => { diagnostics.push(info); } } });
  const meta = { "x-codex-turn-metadata": { thread_id: "exact-thread", sandbox_mode: "danger-full-access", workspaces: { "/elsewhere": {} } } };
  await call(client, "turnweft_ask", turn, meta);
  await call(client, "turnweft_session", { action: "create", provider: "droid", cwd: "/project" }, meta);
  assert.deepEqual(service.submissions[0]!.host, { hostKind: "codex", conversationId: "exact-thread" });
  assert.equal(service.submissions[0]!.intent, "analyze");
  const create = service.calls.find(call => call.method === "createSession")!.input as Record<string, unknown>;
  assert.deepEqual(create.host, service.submissions[0]!.host); assert.equal(create.cwd, "/project");
  assert.equal("workspaces" in create, false); assert.equal("sandbox_mode" in create, false);
  assert.equal(diagnostics.length, 2);
});

for (const [name, kind] of [["Claude Code", "claude-code"], ["codex-mcp-client", "codex"], ["test-client", "cli"]]) {
  test(`missing thread_id uses initialize clientInfo and stable connection fallback: ${name}`, async t => {
    const { client, service } = await setup(t, { name, server: { connectionId: "process-connection" } });
    await call(client, "turnweft_ask", turn);
    await call(client, "turnweft_ask", turn, { "x-codex-turn-metadata": { thread_id: "", sandbox_mode: "anything" } });
    assert.deepEqual(service.submissions.map(input => input.host), [{ hostKind: kind, connectionId: "process-connection" }, { hostKind: kind, connectionId: "process-connection" }]);
  });
}

test("elicitation accept+true confirms exact proposal nonce and resubmits the same requestId", async t => {
  const service = new FakeService(); service.confirmationNeeded = true;
  let shown: ElicitRequest | undefined;
  const { client } = await setup(t, { service, capabilities: { elicitation: { form: {} } }, elicit: request => {
    shown = request; assert.equal(service.submissions.length, 1); assert.equal(service.confirmations.length, 0);
    return { action: "accept", content: { confirm: true } };
  } });
  const result = await call(client, "turnweft_delegate", turn);
  assert.equal(result.data!.kind, "accepted");
  assert.equal(shown!.params.message, proposal.message);
  assert.ok("requestedSchema" in shown!.params);
  assert.deepEqual(shown!.params.requestedSchema.required, ["confirm"]);
  assert.deepEqual(service.confirmations, [{ proposalId: proposal.proposalId, nonce: proposal.nonce, via: "elicitation" }]);
  assert.deepEqual(service.submissions[0], service.submissions[1]);
  assert.deepEqual(service.calls.map(call => call.method), ["submitTurn", "confirmPolicy", "submitTurn"]);
});

for (const response of [
  { action: "decline" }, { action: "cancel" }, { action: "accept", content: { confirm: false } },
  { action: "accept", content: {} }, { action: "accept", content: { confirm: "true" } },
] as Array<Record<string, unknown>>) {
  test(`elicitation ${JSON.stringify(response)} cannot confirm or resubmit`, async t => {
    const service = new FakeService(); service.confirmationNeeded = true;
    const { client } = await setup(t, { service, capabilities: { elicitation: { form: {} } }, elicit: () => response as ElicitResult });
    const result = await call(client, "turnweft_delegate", turn);
    assert.equal(result.ok, true); assert.equal(result.data!.nextAction, "confirm_policy");
    assert.match(result.warnings.join(" "), /turnweft policy grant twp_proposal/);
    assert.equal(service.confirmations.length, 0); assert.equal(service.submissions.length, 1);
  });
}

for (const capabilities of [{}, { elicitation: { url: {} } }]) {
  test(`no elicitation.form: ${JSON.stringify(capabilities)} returns terminal fallback`, async t => {
    const service = new FakeService(); service.confirmationNeeded = true;
    const { client } = await setup(t, { service, capabilities });
    assert.equal((await call(client, "turnweft_delegate", turn)).data!.nextAction, "confirm_policy");
    assert.equal(service.confirmations.length, 0); assert.equal(service.submissions.length, 1);
  });
}

test("elicitation errors and timeouts fail closed, including late accept replies", async t => {
  for (const elicit of [() => { throw new Error("UI unavailable"); }, async () => {
    await new Promise(resolve => setTimeout(resolve, 50)); return { action: "accept" as const, content: { confirm: true } };
  }]) {
    const service = new FakeService(); service.confirmationNeeded = true;
    const { client } = await setup(t, { service, capabilities: { elicitation: { form: {} } }, server: { elicitationTimeoutMs: 10 }, elicit });
    assert.equal((await call(client, "turnweft_delegate", turn)).data!.nextAction, "confirm_policy");
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(service.confirmations.length, 0); assert.equal(service.submissions.length, 1);
  }
});

test("elicitation send failure does not grant policy", async t => {
  const service = new FakeService(); service.confirmationNeeded = true;
  const { client, serverTransport } = await setup(t, { service, capabilities: { elicitation: { form: {} } } });
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    if ("method" in message && message.method === "elicitation/create") throw new Error("Routing failed");
    await send(message, options);
  };
  assert.equal((await call(client, "turnweft_delegate", turn)).data!.nextAction, "confirm_policy");
  assert.equal(service.confirmations.length, 0); assert.equal(service.submissions.length, 1);
});

test("confirmation failure never resubmits a turn", async t => {
  const service = new FakeService(); service.confirmationNeeded = true;
  service.confirmPolicy = async () => { throw Object.assign(new Error("Expired proposal"), { code: "proposal_expired" }); };
  const { client } = await setup(t, { service, capabilities: { elicitation: { form: {} } }, elicit: () => ({ action: "accept", content: { confirm: true } }) });
  assert.equal((await call(client, "turnweft_delegate", turn)).error?.code, "proposal_expired");
  assert.equal(service.submissions.length, 1);
});

test("a second proposal is returned without automatically granting a second policy", async t => {
  const service = new FakeService(); service.submitOutcome = { kind: "needs_confirmation", proposal };
  let elicited = 0;
  const { client } = await setup(t, { service, capabilities: { elicitation: { form: {} } }, elicit: () => {
    elicited++; return { action: "accept", content: { confirm: true } };
  } });
  assert.equal((await call(client, "turnweft_delegate", turn)).data!.nextAction, "confirm_policy");
  assert.equal(service.submissions.length, 2); assert.equal(service.confirmations.length, 1); assert.equal(elicited, 1);
});

test("cancellation of the foreground MCP call prevents a late accept from confirming", async t => {
  const service = new FakeService(); service.confirmationNeeded = true;
  const controller = new AbortController();
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const { client } = await setup(t, { service, capabilities: { elicitation: { form: {} } }, elicit: async () => {
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 10));
    finish();
    return { action: "accept", content: { confirm: true } };
  } });
  await assert.rejects(client.callTool({ name: "turnweft_delegate", arguments: turn }, undefined, { signal: controller.signal }));
  await finished;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.confirmations.length, 0); assert.equal(service.submissions.length, 1);
});

test("service rejections and exceptions are request errors, not successful job queries", async t => {
  const { client, service } = await setup(t);
  service.submitOutcome = { kind: "rejected", code: "capability_mismatch", message: "No writable tier" };
  assert.equal((await call(client, "turnweft_delegate", turn)).error?.code, "capability_mismatch");
  service.getJob = async () => { throw Object.assign(new Error("Job missing"), { code: "job_not_found" }); };
  assert.equal((await call(client, "turnweft_job", { jobId: "missing" })).error?.code, "job_not_found");
});

test("waitMs defaults to zero, clamps to configuration and stays below host timeout", async t => {
  for (const [opts, expected] of [[{}, 25_000], [{ maxWaitMs: 500 }, 500], [{ hostToolTimeoutMs: 100 }, 99], [{ maxWaitMs: 90_000 }, 25_000]] as Array<[McpServerOptions, number]>) {
    const { client, service } = await setup(t, { server: opts });
    await call(client, "turnweft_job", { jobId: "twj_job", waitMs: 90_000, afterSeq: 3, includeResult: true, resultOffset: 4, resultLimit: 5 });
    const input = service.calls[0]!.input as Record<string, unknown>;
    assert.deepEqual(input, { jobId: "twj_job", waitMs: expected, afterSeq: 3, includeResult: true, resultOffset: 4, resultLimit: 5 });
    await call(client, "turnweft_job", { jobId: "twj_job" });
    assert.equal((service.calls[1]!.input as Record<string, unknown>).waitMs, 0);
    assert.equal((await call(client, "turnweft_job", { jobId: "twj_job", waitMs: -1 })).ok, false);
  }
});

test("agents and cancellation route without conflating requested and confirmed cancellation", async t => {
  const { client, service } = await setup(t);
  assert.equal((await call(client, "turnweft_agents", {})).ok, true);
  assert.equal((await call(client, "turnweft_cancel", { jobId: "twj_job" })).data!.state, "cancel_requested");
  assert.deepEqual(service.calls.map(call => call.method), ["listAgents", "cancelJob"]);
  assert.equal((await call(client, "unknown", {})).error?.code, "unknown_tool");
});

test("live CC finding: the proposal shown to the model never contains the nonce, and the fallback says why", async t => {
  for (const capabilities of [{}, { elicitation: { form: {} } }]) {
    const service = new FakeService(); service.confirmationNeeded = true;
    const elicit = "elicitation" in capabilities ? async () => ({ action: "decline" as const }) : undefined;
    const { client } = await setup(t, { service, capabilities, ...(elicit ? { elicit } : {}) });
    const result = await call(client, "turnweft_delegate", turn);
    assert.equal(JSON.stringify(result).includes("one-use-nonce"), false, "nonce must not reach the model");
    assert.equal((result.data as { proposal: Record<string, unknown> }).proposal.nonce, undefined);
    assert.ok(result.warnings.some((w: string) => /did not advertise|returned decline/.test(w)), JSON.stringify(result.warnings));
  }
});

test("U19: a waiting job is returned at once and the dialog helper is started; nothing is resubmitted", async t => {
  const service = new FakeService(); service.awaitingConfirmation = true;
  const shown: string[] = [];
  const { client } = await setup(t, { service, capabilities: { elicitation: { form: {} } }, elicit: async () => ({ action: "decline" as const }), server: { showDialog: (id: string) => { shown.push(id); return true; } } });
  const result = await call(client, "turnweft_delegate", turn);
  const data = result.data as { kind: string; jobId: string; nextAction: string; proposal: Record<string, unknown> };
  assert.equal(data.kind, "awaiting_confirmation");
  assert.equal(data.nextAction, "poll_until_confirmed");
  assert.ok(data.jobId);
  assert.equal(data.proposal.nonce, undefined, "nonce never reaches the model");
  assert.deepEqual(shown, ["twp_proposal"]);
  assert.equal(service.submissions.length, 1, "no resubmit");
  assert.equal(service.confirmations.length, 0, "the model cannot confirm");
  assert.ok(result.warnings[0]!.includes("waits for the user to choose"), "the first line says a Turnweft dialog is waiting");
  assert.ok(result.warnings.some((w: string) => w.includes("keep calling turnweft_job")), "tells the caller to keep polling in this turn");
});

test("U19: host elicitation accept confirms immediately and no dialog is started", async t => {
  const service = new FakeService(); service.awaitingConfirmation = true;
  let shown = 0;
  const { client } = await setup(t, { service, capabilities: { elicitation: { form: {} } }, elicit: async () => ({ action: "accept" as const, content: { confirm: true } }),
    server: { showDialog: () => { shown++; return true; } } });
  const result = await call(client, "turnweft_delegate", turn);
  assert.equal((result.data as { kind: string }).kind, "accepted");
  assert.equal(shown, 0);
  assert.equal(service.confirmations[0]!.via, "elicitation");
});

test("U19: polling a waiting job repeats the keep-polling instruction", async t => {
  const service = new FakeService(); service.jobState = "waiting_confirmation";
  const { client } = await setup(t, { service });
  const result = await call(client, "turnweft_job", { jobId: "twj_job" });
  assert.ok(result.warnings.some((w: string) => w.includes("do not end this turn")), JSON.stringify(result.warnings));
});

test("round 6 finding 1: timing proves nothing; only an explicit confirm:false is a denial", async t => {
  // A slow automatic decline (no person) must keep the job waiting and fall back to the dialog.
  {
    const service = new FakeService(); service.awaitingConfirmation = true;
    let shown = 0;
    const { client } = await setup(t, { service, capabilities: { elicitation: { form: {} } },
      elicit: async () => { await new Promise((r) => setTimeout(r, 400)); return { action: "decline" as const }; },
      server: { showDialog: () => { shown++; return true; } } });
    const result = await call(client, "turnweft_delegate", turn);
    assert.equal((result.data as { kind: string }).kind, "awaiting_confirmation");
    assert.equal(service.rejections.length, 0);
    assert.equal(shown, 1);
  }
  // A fast explicit "no" to our own field is the user's denial.
  {
    const service = new FakeService(); service.awaitingConfirmation = true;
    let shown = 0;
    const { client } = await setup(t, { service, capabilities: { elicitation: { form: {} } },
      elicit: async () => ({ action: "accept" as const, content: { confirm: false } }),
      server: { showDialog: () => { shown++; return true; } } });
    const result = await call(client, "turnweft_delegate", turn);
    assert.equal((result.data as { kind: string }).kind, "cancelled");
    assert.equal(service.rejections.length, 1);
    assert.equal(shown, 0);
  }
});

test("round 5 finding 8: polling a waiting job retries the dialog helper", async t => {
  const service = new FakeService(); service.jobState = "waiting_confirmation";
  const shown: string[] = [];
  const { client } = await setup(t, { service, server: { showDialog: (id: string) => { shown.push(id); return true; } } });
  // FakeService's job has no proposalId; give it one through submitOutcome-free getJob override
  (service as unknown as { getJob: () => Promise<unknown> }).getJob = async () => ({ job: { id: "twj_job", sessionId: "tws_session", requestId: "r", intent: "implement", promptDigest: "d", state: "waiting_confirmation", proposalId: "twq_p", acceptedAt: "now" }, session: { id: "tws_session", provider: "droid", state: "ready", cwd: "/p", canonicalRoot: "/p" }, terminal: false, events: [], nextSeq: 3, nextAction: "confirm_policy" });
  const result = await call(client, "turnweft_job", { jobId: "twj_job" });
  assert.deepEqual(shown, ["twq_p"]);
  assert.ok(result.warnings.some((w: string) => w.includes("afterSeq 3")), JSON.stringify(result.warnings));
});

test("the MCP server reports the package version", async (t) => {
  const { client } = await setup(t);
  const { createRequire } = await import("node:module");
  const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };
  assert.equal(client.getServerVersion()?.version, pkg.version);
});

test("U21: the MCP host layer passes the host's bypass signal, never a tool argument, and says so", async (t) => {
  const seen: unknown[] = [];
  const { service, client } = await setup(t, { server: { hostBypass: (host, meta, c) => { seen.push({ host, meta, c }); return "codex:danger-full-access"; } } });
  const envelope = await call(client, "turnweft_delegate", { sessionId: "tws_session", prompt: "do it", requestId: "r-u21" }, { "x-codex-turn-metadata": { thread_id: "th", sandbox_mode: "danger-full-access" } });
  assert.equal(service.submissions.at(-1)!.hostBypass, "codex:danger-full-access");
  assert.equal(seen.length, 1);
  assert.deepEqual((seen[0] as { c: unknown }).c, { toolName: "turnweft_delegate", requestId: "r-u21" }, "the signal is looked up for this exact call");
  assert.match(envelope.warnings.join("\n"), /bypass mode \(codex:danger-full-access\)/);
  // A model-supplied field cannot set it: unknown arguments are rejected by the strict schema.
  const forged = await client.callTool({ name: "turnweft_delegate", arguments: { sessionId: "tws_session", prompt: "x", requestId: "r-forged", hostBypass: "claude-code:bypassPermissions" } });
  assert.equal(forged.isError, true);
  // Without a detector (tests, or a host without a signal) nothing is passed.
  const plain = await setup(t);
  await call(plain.client, "turnweft_delegate", { sessionId: "tws_session", prompt: "do it", requestId: "r-plain" });
  assert.equal(plain.service.submissions.at(-1)!.hostBypass, undefined);
});
