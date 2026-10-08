import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../runtime/store.js";
import { loadConfig } from "../runtime/config.js";
import type { JobResult } from "../core/types.js";

const alive = () => false;
const gone = () => true;
function fixture(t: import("node:test").TestContext) {
  const home = mkdtempSync(join(tmpdir(), "tw-locks-"));
  const path = join(home, "state.sqlite");
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  for (const id of ["a", "b", "c"]) {
    store.insertSession({ id, provider: "dim", cwd: home, canonicalRoot: home, state: "ready", hostBindings: [], createdAt: "now", updatedAt: "now" });
    store.insertJob({ id, sessionId: id, requestId: id, intent: "implement", prompt: "test", promptDigest: id, state: "queued", acceptedAt: "now" });
  }
  const lock = (id: string, mode: "shared" | "exclusive" = "exclusive", dead = alive, stopped = gone) =>
    store.acquireProjectLock(home, id, 1, id, dead, stopped, mode);
  return { store, home, path, lock };
}

test("U24: only absolute existing user-config directories opt in; realpath exact match", t => {
  const { home } = fixture(t);
  const prev = process.env.TURNWEFT_HOME;
  process.env.TURNWEFT_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.TURNWEFT_HOME; else process.env.TURNWEFT_HOME = prev; });
  const project = join(home, "project"); mkdirSync(project);
  const worktree = join(project, "worktree"); mkdirSync(worktree);
  const alias = join(home, "alias"); symlinkSync(project, alias);
  const file = join(home, "file"); writeFileSync(file, "x");
  const config = join(home, "config.json");
  writeFileSync(config, JSON.stringify({ parallelWrites: [alias + "/../alias/", project, "relative", 42, null, {}, file, join(home, "missing")] }));
  assert.deepEqual(loadConfig().parallelWrites, [realpathSync(project)]);
  assert.equal(loadConfig().parallelWrites?.includes(realpathSync(worktree)), false);
  for (const value of [false, "all", {}, null, ["relative", 1]]) {
    writeFileSync(config, JSON.stringify({ parallelWrites: value }));
    assert.deepEqual(loadConfig().parallelWrites, []);
  }
  for (const raw of ["{invalid", "null", "{}", "[]"]) {
    writeFileSync(config, raw); assert.deepEqual(loadConfig().parallelWrites, []);
  }
});

test("U24: shared/exclusive compatibility, per-holder release and separate roots", t => {
  const { store, home, lock } = fixture(t);
  assert.equal(lock("a", "shared"), true);
  assert.equal(lock("b", "shared"), true);
  assert.equal(lock("c"), false);
  store.releaseProjectLock(home, "a");
  assert.equal(lock("c"), false, "exclusive waits for every shared holder");
  store.releaseProjectLock(home, "b");
  assert.equal(lock("c"), true);
  assert.equal(lock("a", "shared"), false);
  assert.equal(lock("b"), false);
  assert.equal(store.acquireProjectLock(join(home, "worktree"), "a", 1, "a", alive), true);
  store.releaseProjectLock(home, "c");
  assert.equal(lock("a", "shared"), true);
});

test("U24: dead owners require native-stop proof; live frozen shared holders block either mode", t => {
  const { store, home, lock } = fixture(t);
  assert.equal(store.claimLease("a", 1, "a", gone), 1);
  store.setLeaseNative("a", "a", 2, "native-a");
  assert.equal(lock("a", "shared"), true);
  for (const mode of ["shared", "exclusive"] as const) {
    assert.equal(lock("b", mode, gone, alive), false, "owner death alone is insufficient");
    store.updateJob("a", { state: "failed" });
    assert.equal(lock("b", mode), false, "frozen live holder remains blocking");
  }
  assert.equal(lock("b", "shared", gone, gone), true);
  assert.deepEqual(store.projectLockHolders(home).map(x => x.jobId), ["b"]);
  assert.equal(lock("a", "shared"), true, "recovered job may reacquire its hold");
});

test("U24: delivery records overlap symmetrically and preserves it through completion and recovery", t => {
  const { store, lock, home } = fixture(t);
  for (const id of ["a", "b", "c"]) {
    assert.equal(store.claimLease(id, 1, id, gone), 1);
    assert.equal(lock(id, "shared"), true);
    assert.ok(store.claimJob(id, id, { ownerGeneration: 1 }));
  }
  assert.equal(store.fencedTransition("a", 1, ["starting"], "running", { deliveredAt: "now" }), true);
  assert.equal(store.getJob("a")?.concurrentWrites, undefined, "opening alone is not concurrent execution");
  assert.equal(store.fencedTransition("b", 99, ["starting"], "running", { deliveredAt: "now" }), false);
  assert.equal(store.fencedTransition("b", 1, ["starting"], "running", { deliveredAt: "now" }), true);
  assert.equal(store.fencedTransition("a", 1, ["running"], "waiting_permission"), true);
  assert.equal(store.fencedTransition("c", 1, ["starting"], "running", { deliveredAt: "now" }), true);
  const result: JobResult = { sessionId: "a", jobId: "a", provider: "dim", adapterVersion: "test", cwd: home, state: "succeeded", finalText: "ok", resultComplete: true, truncated: false, toolCalls: [] };
  assert.equal(store.completeJob("a", 1, "succeeded", {}, result, { type: "turn.completed", payload: {} }), true);
  assert.deepEqual(store.getJobResult("a")?.concurrentWrites, ["b", "c"]);
  assert.deepEqual(store.getJob("b")?.concurrentWrites, ["a", "c"]);
  store.recoverOrphans("b", 2);
  assert.equal(store.getJob("b")?.state, "in_doubt");
  assert.deepEqual(store.getJob("b")?.concurrentWrites, ["a", "c"]);
});

test("U24: legacy SQLite migration preserves locks as exclusive and is repeatable", t => {
  const { store, home, path, lock } = fixture(t);
  assert.equal(lock("a"), true);
  store.db.exec(`ALTER TABLE project_locks RENAME TO new_locks;
    CREATE TABLE project_locks (canonical_root TEXT PRIMARY KEY, job_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_token TEXT NOT NULL, acquired_at TEXT NOT NULL);
    INSERT INTO project_locks SELECT canonical_root, job_id, owner_pid, owner_token, acquired_at FROM new_locks;
    DROP TABLE new_locks;
    ALTER TABLE jobs DROP COLUMN concurrent_writes;
    UPDATE meta SET value = '1' WHERE key = 'schema_version';`);
  for (let i = 0; i < 2; i++) {
    const reopened = new Store(path);
    try {
      assert.equal(reopened.getJob("a")?.state, "queued");
      assert.equal(reopened.projectLockHolders(home)[0]?.mode, "exclusive");
      assert.equal(reopened.acquireProjectLock(home, "b", 1, "b", alive, gone, "shared"), false);
      assert.equal(reopened.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value, "2");
    } finally { reopened.close(); }
  }
});
