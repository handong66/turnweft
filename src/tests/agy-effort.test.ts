// U23: agy takes the thinking level only at launch. Runs AgyConnection against a scripted stand-in.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgyConnection } from "../adapters/agy.js";
import { AdapterError, type TierSpec } from "../adapters/types.js";

const dir = mkdtempSync(join(tmpdir(), "tw-fake-agy-"));
const exe = join(dir, "agy");
writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("./fake-agy.js", import.meta.url))}" "$@"\n`);
chmodSync(exe, 0o755);
after(() => rmSync(dir, { recursive: true, force: true }));
const tier: TierSpec = { tier: "request-review", excess: [], decide: () => "deny", satisfiedBy: () => true };

async function run(effort: string | undefined, nativeSessionId?: string) {
  const c = new AgyConnection(exe, tmpdir());
  try {
    const r = await c.open({ cwd: tmpdir(), tier, effort, nativeSessionId });
    let text = "";
    await c.prompt("which level?", (e) => { if (e.type === "text") text += e.text; });
    return { r, text, live: c.currentEffort(), hasSetEffort: "setEffort" in c };
  } finally { await c.close(); }
}

test("U23: agy gets --effort at launch and reports that flag as its level", async () => {
  const { r, text, live, hasSetEffort } = await run("xhigh");
  assert.equal(text, "effort=xhigh", "the flag reached agy");
  assert.deepEqual(r.effort, { requested: "xhigh", effective: "xhigh" });
  assert.equal(live, "xhigh");
  assert.equal(hasSetEffort, false, "no in-session change: the runtime relaunches the same conversation instead");
  assert.equal(r.nativeSessionId, "agy-new-conv");
  const resumed = await run("low", "agy-earlier-conv");
  assert.equal(resumed.r.nativeSessionId, "agy-earlier-conv", "a new level resumes the same conversation");
  assert.equal(resumed.text, "effort=low");
});

test("U23: without a request agy gets no flag", async () => {
  const { r, text } = await run(undefined);
  assert.equal(text, "effort=default");
  assert.deepEqual(r.effort, { requested: undefined, effective: undefined });
});

test("U23 review 2: agy rejecting a level is invalid_effort, even when the value is long", async () => {
  for (const bad of ["bogus", "x".repeat(1000), "x".repeat(5000)]) { // the last one is longer than the kept stderr tail
    await assert.rejects(new AgyConnection(exe, tmpdir()).open({ cwd: tmpdir(), tier, effort: bad }),
      (e) => e instanceof AdapterError && e.code === "invalid_effort");
  }
});
