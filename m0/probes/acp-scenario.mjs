// Real ACP scenario (consumes model quota).
// Usage: node acp-scenario.mjs <agent> [--set key=value ...] [--policy allow|deny]
//   1. new session, apply config options, read back
//   2. turn 1: remember a token + fix bugs + run tests   (write + exec in real cwd)
//   3. turn 2: recall token in same process              (L1)
//   4. kill process, new process, session/load, recall   (L2)
//   5. cancel a long-running turn
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AcpClient, textOf } from "./acp-client.mjs";
import { ACP_AGENTS, M0, freshFixture, gitStatus, runTests } from "./agents.mjs";

const name = process.argv[2];
const sets = [];
let policy = "allow";
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === "--set") sets.push(process.argv[++i].split("="));
  if (process.argv[i] === "--policy") policy = process.argv[++i];
}
const spec = ACP_AGENTS[name];
const tag = `${name}${sets.length ? "-" + sets.map(([k, v]) => `${k}_${v}`).join("-").replace(/[^\w.-]/g, "_") : ""}`;
const cwd = freshFixture(`scenario-${tag}`);
const logFile = join(M0, "results", `scenario-${tag}.jsonl`);
writeFileSync(logFile, "");
const token = "TW-" + randomBytes(3).toString("hex").toUpperCase();
const out = { agent: name, sets, policy, cwd, token, steps: {} };
const save = () => writeFileSync(join(M0, "results", `scenario-${tag}.json`), JSON.stringify(out, null, 2));

const permissionPolicy = (params) => {
  const opts = params.options ?? [];
  const want = policy === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  const pick = want.map((k) => opts.find((o) => o.kind === k)).find(Boolean);
  return pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" };
};

function client() {
  return new AcpClient({ ...spec, cwd, logFile, permissionPolicy });
}

async function prompt(c, sessionId, text, label, { cancelAfterMs } = {}) {
  const start = c.updates.length;
  const permStart = c.permissionRequests.length;
  const t0 = Date.now();
  let timer;
  if (cancelAfterMs) timer = setTimeout(() => c.notify("session/cancel", { sessionId }), cancelAfterMs);
  let res;
  try { res = await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, 900000); }
  catch (e) { res = { error: e.message, rpc: e.rpc }; }
  clearTimeout(timer);
  const ups = c.updates.slice(start);
  const kinds = {};
  for (const u of ups) kinds[u.update?.sessionUpdate] = (kinds[u.update?.sessionUpdate] ?? 0) + 1;
  out.steps[label] = {
    ms: Date.now() - t0,
    result: res,
    text: textOf(ups).slice(-1500),
    updateKinds: kinds,
    toolCalls: ups.filter((u) => u.update?.sessionUpdate === "tool_call").map((u) => ({ kind: u.update.kind, title: u.update.title })),
    permissionRequests: c.permissionRequests.slice(permStart).map((p) => ({
      title: p.toolCall?.title, kind: p.toolCall?.kind, options: (p.options ?? []).map((o) => `${o.kind}:${o.optionId}`),
    })),
  };
  save();
  return out.steps[label];
}

// --- 1. open + configure
let c = client();
out.steps.initialize = (await c.initialize()).agentInfo ?? "ok";
const created = await c.request("session/new", { cwd, mcpServers: [] }, 120000);
const sessionId = created.sessionId;
out.sessionId = sessionId;
out.initialConfig = Object.fromEntries((created.configOptions ?? []).map((o) => [o.id, o.currentValue]));
out.initialMode = created.modes?.currentModeId;
for (const [configId, value] of sets) {
  try {
    const r = await c.request("session/set_config_option", { sessionId, configId, value }, 60000);
    out.steps[`set_${configId}`] = Object.fromEntries((r.configOptions ?? []).map((o) => [o.id, o.currentValue]));
  } catch (e) { out.steps[`set_${configId}`] = { error: e.message }; }
}
save();

// --- 2. implement in the real directory
await prompt(c, sessionId,
  `Remember this token for later: ${token}. Now fix the bugs in src/math.js so that \`npm test\` passes, ` +
  `then run \`npm test\` to confirm. Keep the reply to two sentences.`, "turn1_implement");
out.afterTurn1 = { git: gitStatus(cwd), tests: runTests(cwd) };
save();

// --- 3. same-process recall (L1)
await prompt(c, sessionId, "What token did I ask you to remember? Reply with the token only.", "turn2_recall_L1");

// --- 4. restart + load (L2)
out.closeExit = await c.close();
c = client();
await c.initialize();
const loadStart = Date.now();
let loaded;
try { loaded = await c.request("session/load", { sessionId, cwd, mcpServers: [] }, 120000); }
catch (e) { loaded = { error: e.message, rpc: e.rpc }; }
out.steps.load = {
  ms: Date.now() - loadStart,
  replayedUpdates: c.updates.length,
  config: Object.fromEntries((loaded?.configOptions ?? []).map((o) => [o.id, o.currentValue])),
  error: loaded?.error,
};
// Re-apply settings: a new process must not inherit permission state.
for (const [configId, value] of sets) {
  try {
    const r = await c.request("session/set_config_option", { sessionId, configId, value }, 60000);
    out.steps[`reset_${configId}`] = Object.fromEntries((r.configOptions ?? []).map((o) => [o.id, o.currentValue]));
  } catch (e) { out.steps[`reset_${configId}`] = { error: e.message }; }
}
save();
await prompt(c, sessionId, "What token did I ask you to remember earlier in this conversation? Reply with the token only.", "turn3_recall_L2");

// --- 5. cancel
await prompt(c, sessionId, "Run the shell command `sleep 45 && echo slept` and then tell me what it printed.", "turn4_cancel", { cancelAfterMs: 12000 });
out.afterCancel = { git: gitStatus(cwd) };
out.finalExit = await c.close();
out.stderrTail = c.stderr.slice(-600);
save();

const s = out.steps;
console.log(JSON.stringify({
  agent: name, sets, token, sessionId,
  initialConfig: out.initialConfig,
  setReadback: Object.fromEntries(sets.map(([k]) => [k, s[`set_${k}`]?.[k] ?? s[`set_${k}`]])),
  t1: { stop: s.turn1_implement?.result?.stopReason ?? s.turn1_implement?.result, ms: s.turn1_implement?.ms, perms: s.turn1_implement?.permissionRequests?.length, tools: s.turn1_implement?.toolCalls?.length },
  afterTurn1: out.afterTurn1,
  L1: s.turn2_recall_L1?.text?.trim().slice(-80),
  load: { error: s.load?.error, replayed: s.load?.replayedUpdates, config: s.load?.config },
  L2: s.turn3_recall_L2?.text?.trim().slice(-80),
  cancel: { stop: s.turn4_cancel?.result?.stopReason ?? s.turn4_cancel?.result, ms: s.turn4_cancel?.ms },
}, null, 2));
