// U23: the ACP adapter applies a thinking level after the model, checks it against what the current model
// offers, and trusts only the read-back. Runs the adapter against a scripted ACP agent process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { AcpConnection } from "../adapters/acp.js";
import { AdapterError, type TierSpec } from "../adapters/types.js";

const fixture = fileURLToPath(new URL("./fake-acp-agent.js", import.meta.url));
const tier: TierSpec = { tier: "t", excess: [], decide: () => "deny", satisfiedBy: () => true };

async function open(style: string, input: { model?: string; effort?: string }) {
  const prev = process.env.FAKE_ACP_STYLE;
  process.env.FAKE_ACP_STYLE = style;
  const c = new AcpConnection({ command: process.execPath, args: [fixture], settingsFor: () => [], isSessionNotFound: () => false }, tmpdir());
  if (prev === undefined) delete process.env.FAKE_ACP_STYLE; else process.env.FAKE_ACP_STYLE = prev;
  try { return await c.open({ cwd: tmpdir(), tier, ...input }); } finally { await c.close(); }
}

const invalid = (re: RegExp) => (e: unknown) => e instanceof AdapterError && e.code === "invalid_effort" && re.test(e.message);

test("U23: the level is found by category, set, read back and reported", async () => {
  const r = await open("dim", { effort: "high" });
  assert.deepEqual(r.effort, { requested: "high", effective: "high" });
  assert.equal(r.effective.thought_level, "high");
});

test("U23: without a request the provider's own level is reported and nothing is set", async () => {
  assert.deepEqual((await open("droid", {})).effort, { requested: undefined, effective: "high" });
});

test("U23: values are checked against the model actually set, not the default one", async () => {
  // "none" is offered by m1 but not by m2.
  assert.deepEqual((await open("dim", { model: "m1", effort: "none" })).effort, { requested: "none", effective: "none" });
  await assert.rejects(open("dim", { model: "m2", effort: "none" }), invalid(/offers auto, high, max with model m2/));
});

test("U23: a model switch that resets the level does not undo the request (OpenCode)", async () => {
  const r = await open("opencode", { model: "m2", effort: "max" });
  assert.deepEqual(r.effort, { requested: "max", effective: "max" });
  assert.equal(r.model?.effective, "m2");
});

test("U23: a level reported only through config_option_update is waited for (Droid)", async () => {
  assert.deepEqual((await open("droid", { effort: "xhigh" })).effort, { requested: "xhigh", effective: "xhigh" });
});

test("U23: an option without a category is still found by its known id", async () => {
  assert.deepEqual((await open("legacy", { effort: "low" })).effort, { requested: "low", effective: "low" });
});

test("U23: unknown values, and agents without a thinking-level option, fail with invalid_effort", async () => {
  await assert.rejects(open("dim", { effort: "bogus" }), invalid(/"bogus" is not offered/));
  await assert.rejects(open("none", { effort: "high" }), invalid(/no thinking-level option/));
  assert.deepEqual((await open("none", {})).effort, { requested: undefined, effective: undefined });
  // An offered value the agent silently keeps at another level: only the read-back counts.
  await assert.rejects(open("stubborn", { effort: "low" }), invalid(/requested effort "low" but the agent reports "high"/));
});
