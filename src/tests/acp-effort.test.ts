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

async function open(style: string, input: { model?: string; effort?: string; nativeSessionId?: string }, after?: (c: AcpConnection) => Promise<void>) {
  const prev = process.env.FAKE_ACP_STYLE;
  process.env.FAKE_ACP_STYLE = style;
  const c = new AcpConnection({ command: process.execPath, args: [fixture], settingsFor: () => [], isSessionNotFound: () => false }, tmpdir());
  if (prev === undefined) delete process.env.FAKE_ACP_STYLE; else process.env.FAKE_ACP_STYLE = prev;
  try { const r = await c.open({ cwd: tmpdir(), tier, ...input }); await after?.(c); return r; } finally { await c.close(); }
}

/** The level the agent really runs with, as its prompt reply reports it. */
async function realLevel(c: AcpConnection): Promise<string> {
  let text = "";
  await c.prompt("which level?", (e) => { if (e.type === "text") text += e.text; });
  return text;
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

test("U23 review: a load answer newer than the real state cannot make Turnweft skip the set", async () => {
  let real = "";
  const r = await open("staleload", { nativeSessionId: "fake-acp-1", effort: "high" }, async (c) => { real = await realLevel(c); });
  assert.equal(real, "level=high", "the agent actually runs at the requested level");
  assert.deepEqual(r.effort, { requested: "high", effective: "high" });
});

test("U23 review: an option that disappears after a model switch is not validated against stale values", async () => {
  await assert.rejects(open("vanish", { model: "m2", effort: "high" }), invalid(/no thinking-level option/));
  let live: string | undefined = "unset";
  const r = await open("vanish", { model: "m2" }, async (c) => { live = c.currentEffort(); });
  assert.equal(r.effort?.effective, undefined);
  assert.equal(live, undefined, "the old level is dropped with the option");
});

test("U23 review: an empty effort is a request, not an omission", async () => {
  await assert.rejects(open("dim", { effort: "" }), invalid(/"" is not offered/));
});

test("U23: setEffort changes the level inside the running session and verifies it", async () => {
  const seen: string[] = [];
  await open("dim", {}, async (c) => {
    seen.push(await realLevel(c));
    await c.setEffort("max");
    seen.push(await realLevel(c), String(c.currentEffort()));
    await assert.rejects(c.setEffort("bogus"), invalid(/"bogus" is not offered/));
    seen.push(await realLevel(c));
  });
  assert.deepEqual(seen, ["level=auto", "level=max", "max", "level=max"], "a rejected value leaves the session as it was");
});

test("U23 review 2: the category decides, even against an unrelated option with a known id", async () => {
  let real = "";
  const r = await open("custom", { effort: "low" }, async (c) => { real = await realLevel(c); });
  assert.equal(real, "level=low", "think_depth was set");
  assert.deepEqual(r.effort, { requested: "low", effective: "low" });
  assert.equal(r.effective.effort, "on", "the unrelated option named effort was left alone");
});

test("U23 review 2: without a fresh read-back the cache proves nothing, even when it shows the requested value", async () => {
  // silent keeps "high" (its default) cached and never answers; requesting that same value must still fail.
  await assert.rejects(open("silent", { effort: "high" }), invalid(/did not report its thinking level/));
});

test("U23 review 2: an empty option list is a complete list, not a missing one", async () => {
  await assert.rejects(open("emptied", { effort: "high" }), invalid(/agent reports "nothing"/));
});
