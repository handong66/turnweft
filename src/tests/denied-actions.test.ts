import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeniedActions, deniedActionList, warningSummary } from "../core/denied-actions.js";
import { text } from "../core/i18n.js";
import { Store } from "../runtime/store.js";
import type { JobResult } from "../core/types.js";

test("U26: deduplication stays bounded after overflow and counts retained duplicates", () => {
  const collector = new DeniedActions();
  for (let i = 0; i < 1000; i++) collector.add({ kind: "command", title: `cmd-${i}` });
  collector.add({ kind: "command", title: "cmd-0" });
  collector.add({ kind: "edit", title: "cmd-0" }); // different key, beyond the storage cap
  const summary = collector.summary();
  assert.equal(summary.deniedActions?.length, 50);
  assert.equal(summary.deniedActionsTotal, 1002);
  assert.equal(summary.deniedActions?.[0]?.count, 2);
  for (const language of ["en", "zh"] as const) {
    const rendered = deniedActionList(summary, language);
    assert.match(rendered, /command:cmd-0 \(×2\)/);
    assert.match(rendered, /command:cmd-4/);
    assert.doesNotMatch(rendered, /cmd-5/);
    assert.ok(rendered.endsWith(text("deniedActionsMore", { count: "996" }, language)));
    assert.match(text("truncatedOutput", undefined, language), /truncated/);
  }
  assert.deepEqual(warningSummary(summary), summary);
  const distinct = new DeniedActions();
  distinct.add({ kind: "command", title: "same" });
  distinct.add({ kind: "edit", title: "same" });
  assert.equal(distinct.summary().deniedActions?.length, 2);
});

test("U26: additive warning-summary migration preserves legacy results and supports old writers", t => {
  const home = mkdtempSync(join(tmpdir(), "tw-warnings-"));
  const previous = process.env.TURNWEFT_HOME;
  process.env.TURNWEFT_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.TURNWEFT_HOME;
    else process.env.TURNWEFT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  const path = join(home, "state.sqlite");
  const store = new Store(path);
  store.insertSession({ id: "s", provider: "dim", cwd: home, canonicalRoot: home, state: "ready", hostBindings: [], createdAt: "now", updatedAt: "now" });
  store.insertJob({ id: "j", sessionId: "s", requestId: "r", intent: "analyze", prompt: "test", promptDigest: "test", state: "succeeded", acceptedAt: "now" });
  const result: JobResult = { sessionId: "s", jobId: "j", provider: "dim", adapterVersion: "test", cwd: home, state: "succeeded", finalText: "report", resultComplete: true, truncated: false, toolCalls: [], warningCodes: ["denied_actions"], deniedActions: Array.from({ length: 100 }, () => ({ kind: "execute", title: "git show" })) };
  const original = JSON.stringify(result);
  store.db.exec("ALTER TABLE jobs DROP COLUMN warning_summary");
  store.db.prepare("UPDATE jobs SET result = ? WHERE id = 'j'").run(original);
  store.close();
  for (let i = 0; i < 2; i++) {
    const reopened = new Store(path);
    try {
      assert.deepEqual(reopened.getJob("j")?.warningCodes, ["denied_actions"]);
      assert.equal(reopened.getJob("j")?.deniedActionsTotal, 100);
      assert.deepEqual(reopened.getJob("j")?.deniedActions, [{ kind: "execute", title: "git show", count: 100 }]);
      assert.equal(reopened.db.prepare("SELECT result FROM jobs WHERE id = 'j'").get()?.result, original);
    } finally { reopened.close(); }
  }
  const reopened = new Store(path);
  try {
    // Pre-U26 results without warning codes stay warning-free.
    reopened.db.prepare("UPDATE jobs SET result = ? WHERE id = 'j'").run(JSON.stringify({ ...result, warningCodes: undefined, deniedActions: undefined }));
    assert.equal(reopened.getJob("j")?.warningCodes, undefined);
    reopened.setJobResult("j", { ...result, warningCodes: ["empty_output"], deniedActions: undefined });
    // Status uses the persisted summary independently of the result body.
    reopened.db.exec("UPDATE jobs SET result = NULL WHERE id = 'j'");
    assert.deepEqual(reopened.getJob("j")?.warningCodes, ["empty_output"]);
  } finally { reopened.close(); }
});
