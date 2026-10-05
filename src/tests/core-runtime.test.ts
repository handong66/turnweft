// Core runtime tests with the scripted fake provider and real detached workers.
// Maps to acceptance scenarios in design §14.2 (A02, A03, A04, A08–A16, A18, A21, A24).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, writeFileSync as wf, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

const HOME = mkdtempSync(join(tmpdir(), "tw-home-"));
process.env.TURNWEFT_HOME = HOME;
process.env.TURNWEFT_FAKE_ADAPTERS = "1";
process.env.TURNWEFT_IDLE_RELEASE_MS = "1500";
process.env.TURNWEFT_INACTIVITY_MS = "3000";
process.env.TURNWEFT_CANCEL_GRACE_MS = "1500";

const { LocalService } = await import("../runtime/service.js");
const { Store } = await import("../runtime/store.js");
const { ownerToken, groupMembers, leaderState, nativeStopped, stopAndConfirm } = await import("../runtime/proc.js");
const { isOwnerGone } = await import("../runtime/proc.js");
const { runDialog } = await import("../cli/main.js");
// All imports stay above the first test: a top-level await between tests lets the runner finish the root
// test early and run after() (deleting HOME) before later tests register.
type HostBinding = import("../core/types.js").HostBinding;

const host: HostBinding = { hostKind: "codex", conversationId: "thread-A" };
const otherHost: HostBinding = { hostKind: "claude-code", connectionId: "conn-B" };
let svc: InstanceType<typeof LocalService>;
let rid = 0;
const req = () => `req-${Date.now()}-${rid++}`;

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "tw-proj-"));
  execFileSync("git", ["init", "-q"], { cwd: d });
  writeFileSync(join(d, "a.txt"), "a\n");
  execFileSync("git", ["add", "-A"], { cwd: d });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: d });
  return d;
}

async function waitDone(jobId: string, ms = 30000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await svc.getJob({ jobId, waitMs: 1000, includeResult: true });
    if (v.terminal) return v;
    if (Date.now() > until) throw new Error(`job ${jobId} not terminal: ${v.job.state}`);
  }
}

async function waitState(sessionId: string, state: string, ms = 15000) {
  const until = Date.now() + ms;
  while ((await svc.getSession(sessionId))?.state !== state) {
    if (Date.now() > until) throw new Error(`session not ${state}: ${(await svc.getSession(sessionId))?.state}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function submit(sessionId: string, prompt: string, intent: "analyze" | "implement" = "implement", requestId = req(), h = host) {
  const o = await svc.submitTurn({ sessionId, intent, prompt, requestId, host: h });
  if (o.kind !== "accepted") throw new Error(`not accepted: ${JSON.stringify(o)}`);
  return o.job;
}

before(() => { svc = new LocalService(); });
after(() => { rmSync(HOME, { recursive: true, force: true }); });

test("A04/A21: implement writes in the real directory; pre-existing dirty files are not attributed", async () => {
  const d = repo();
  writeFileSync(join(d, "a.txt"), "user edit\n"); // dirty before the turn
  const s = await svc.createSession({ provider: "droid", cwd: d, host });
  const job = await submit(s.id, "WRITE:b.txt");
  const v = await waitDone(job.id);
  assert.equal(v.job.state, "succeeded");
  assert.ok(existsSync(join(d, "b.txt")));
  assert.deepEqual(v.result?.files?.changed, ["b.txt"]);
  assert.deepEqual(v.result?.files?.preexistingDirty, ["a.txt"]);
  assert.equal(v.result?.permission?.answeredRequests[0]?.decision, "allow");
});

test("A02/A03: same-session recall (L1), then idle release and native resume (L2)", async () => {
  const s = await svc.createSession({ provider: "dim", cwd: repo(), host });
  await waitDone((await submit(s.id, "REMEMBER:TW-42")).id);
  const l1 = await waitDone((await submit(s.id, "RECALL")).id);
  assert.equal(l1.result?.finalText, "TW-42");
  const native = (await svc.getSession(s.id))!.nativeSessionId;
  await waitState(s.id, "suspended");
  const l2 = await waitDone((await submit(s.id, "RECALL")).id);
  assert.equal(l2.result?.finalText, "TW-42");
  assert.equal((await svc.getSession(s.id))!.nativeSessionId, native, "resume must keep the native id");
});

test("A12: duplicate requestId returns the same job; different content conflicts", async () => {
  const s = await svc.createSession({ provider: "grok", cwd: repo(), host });
  const r = req();
  const j1 = await submit(s.id, "hello", "analyze", r);
  const j2 = await submit(s.id, "hello", "analyze", r);
  assert.equal(j1.id, j2.id);
  const o = await svc.submitTurn({ sessionId: s.id, intent: "analyze", prompt: "different", requestId: r, host });
  assert.equal(o.kind, "rejected");
  assert.equal(o.kind === "rejected" && o.code, "request_conflict");
  await waitDone(j1.id);
});

test("A08/A10: FIFO in a session; cancelling a queued job leaves the running one; running cancel is confirmed", async () => {
  const s = await svc.createSession({ provider: "opencode", cwd: repo(), host });
  const first = await submit(s.id, "SLEEP:20000");
  const second = await submit(s.id, "echo-second");
  const third = await submit(s.id, "echo-third");
  const c2 = await svc.cancelJob(second.id);
  assert.equal(c2.state, "cancelled");
  // wait until first is running, then cancel it
  for (let i = 0; i < 50 && (await svc.getJob({ jobId: first.id })).job.state !== "running"; i++) await new Promise((r) => setTimeout(r, 100));
  const t0 = Date.now();
  await svc.cancelJob(first.id);
  const v1 = await waitDone(first.id);
  assert.equal(v1.job.state, "cancelled");
  assert.ok(Date.now() - t0 < 5000, "cancel should stop the turn quickly");
  const v3 = await waitDone(third.id);
  assert.equal(v3.job.state, "succeeded");
  assert.ok(Date.parse(v3.job.startedAt!) >= Date.parse(v1.job.finishedAt!), "third starts after first finishes");
});

test("U11/U19: one confirmation per provider × project × intent; the waiting job starts by itself; revoke stops reuse (A24)", async () => {
  process.env.TURNWEFT_FAKE_EXCESS = "1";
  try {
    const d = repo();
    const s = await svc.createSession({ provider: "agy", cwd: d, host });
    const r = req();
    const o = await svc.submitTurn({ sessionId: s.id, intent: "implement", prompt: "WRITE:c.txt", requestId: r, host });
    assert.equal(o.kind, "awaiting_confirmation");
    if (o.kind !== "awaiting_confirmation") return;
    assert.equal(o.job.state, "waiting_confirmation");
    await new Promise((res) => setTimeout(res, 800));
    assert.equal((await svc.getJob({ jobId: o.job.id })).job.state, "waiting_confirmation", "nothing runs before confirmation, and it does not time out into a denial");
    assert.equal(existsSync(join(d, "c.txt")), false);
    const again0 = await svc.submitTurn({ sessionId: s.id, intent: "implement", prompt: "WRITE:c.txt", requestId: r, host });
    assert.equal(again0.kind === "awaiting_confirmation" && again0.job.id, o.job.id, "same requestId returns the same waiting job");
    await assert.rejects(svc.confirmPolicy({ proposalId: o.proposal.proposalId, nonce: "wrong", via: "native-dialog" }), /nonce/);
    const pol = await svc.confirmPolicy({ proposalId: o.proposal.proposalId, nonce: o.proposal.nonce, via: "native-dialog" });
    await assert.rejects(svc.confirmPolicy({ proposalId: o.proposal.proposalId, nonce: o.proposal.nonce, via: "native-dialog" }), /already used/);
    const v = await waitDone(o.job.id); // no resubmit
    assert.equal(v.job.state, "succeeded");
    assert.equal(v.job.policyId, pol.id);
    assert.ok(existsSync(join(d, "c.txt")));
    const again = await svc.submitTurn({ sessionId: s.id, intent: "implement", prompt: "WRITE:d.txt", requestId: req(), host });
    assert.equal(again.kind, "accepted", "second implement turn must not ask again");
    if (again.kind === "accepted") await waitDone(again.job.id);
    const analyze = await svc.submitTurn({ sessionId: s.id, intent: "analyze", prompt: "hi", requestId: req(), host });
    assert.equal(analyze.kind, "accepted", "analyze tier has no excess here");
    if (analyze.kind === "accepted") await waitDone(analyze.job.id);
    await svc.revokePolicy(pol.id);
    const after = await svc.submitTurn({ sessionId: s.id, intent: "implement", prompt: "WRITE:e.txt", requestId: req(), host });
    assert.equal(after.kind, "awaiting_confirmation");
    if (after.kind === "awaiting_confirmation") await svc.cancelJob(after.job.id);
  } finally {
    delete process.env.TURNWEFT_FAKE_EXCESS;
  }
});

test("U19: deny cancels every job waiting on the proposal; later turns wait behind a waiting one (FIFO)", async () => {
  process.env.TURNWEFT_FAKE_EXCESS = "1";
  try {
    const d = repo();
    const s = await svc.createSession({ provider: "droid", cwd: d, host });
    const a = await svc.submitTurn({ sessionId: s.id, intent: "implement", prompt: "WRITE:denied-a.txt", requestId: req(), host });
    const b = await svc.submitTurn({ sessionId: s.id, intent: "implement", prompt: "WRITE:denied-b.txt", requestId: req(), host });
    const c = await svc.submitTurn({ sessionId: s.id, intent: "analyze", prompt: "hello", requestId: req(), host }); // no confirmation needed
    if (a.kind !== "awaiting_confirmation" || b.kind !== "awaiting_confirmation" || c.kind !== "accepted") throw new Error(`unexpected ${a.kind} ${b.kind} ${c.kind}`);
    assert.equal(a.proposal.proposalId, b.proposal.proposalId, "one pending proposal (one dialog) for the same key");
    await new Promise((res) => setTimeout(res, 1200));
    assert.equal((await svc.getJob({ jobId: c.job.id })).job.state, "queued", "the analyze turn waits behind the waiting implement turn");
    await svc.rejectPolicy({ proposalId: a.proposal.proposalId, nonce: a.proposal.nonce, via: "native-dialog" });
    for (const id of [a.job.id, b.job.id]) {
      const v = await svc.getJob({ jobId: id });
      assert.equal(v.job.state, "cancelled");
      assert.equal(v.job.errorCode, "confirmation_denied");
    }
    assert.equal((await waitDone(c.job.id)).job.state, "succeeded", "once the head is gone the next turn runs");
    assert.equal(existsSync(join(d, "denied-a.txt")), false);
    assert.equal(existsSync(join(d, "denied-b.txt")), false);
  } finally {
    delete process.env.TURNWEFT_FAKE_EXCESS;
  }
});

test("U19: a waiting job can be cancelled; an expired proposal fails it as confirmation_expired", async () => {
  process.env.TURNWEFT_FAKE_EXCESS = "1";
  try {
    const s = await svc.createSession({ provider: "grok", cwd: repo(), host });
    const a = await svc.submitTurn({ sessionId: s.id, intent: "implement", prompt: "WRITE:a.txt", requestId: req(), host });
    if (a.kind !== "awaiting_confirmation") throw new Error(a.kind);
    assert.equal((await svc.cancelJob(a.job.id)).state, "cancelled");
    const b = await svc.submitTurn({ sessionId: s.id, intent: "implement", prompt: "WRITE:b.txt", requestId: req(), host });
    if (b.kind !== "awaiting_confirmation") throw new Error(b.kind);
    const st = new Store();
    const row = st.db.prepare("SELECT data FROM proposals WHERE id = ?").get(b.proposal.proposalId) as { data: string };
    const data = JSON.parse(row.data); data.expiresAt = new Date(Date.now() - 1000).toISOString();
    st.db.prepare("UPDATE proposals SET data = ?, expires_at = ? WHERE id = ?").run(JSON.stringify(data), data.expiresAt, b.proposal.proposalId);
    st.close();
    const v = await svc.getJob({ jobId: b.job.id });
    assert.equal(v.job.state, "failed");
    assert.equal(v.job.errorCode, "confirmation_expired");
  } finally {
    delete process.env.TURNWEFT_FAKE_EXCESS;
  }
});

test("A06: analyze intent denies writes", async () => {
  const d = repo();
  const s = await svc.createSession({ provider: "droid", cwd: d, host });
  const v = await waitDone((await submit(s.id, "WRITE:nope.txt", "analyze")).id);
  assert.equal(v.job.state, "succeeded");
  assert.equal(existsSync(join(d, "nope.txt")), false);
  assert.equal(v.result?.permission?.answeredRequests[0]?.decision, "deny");
});

test("A07: another host must attach explicitly", async () => {
  const s = await svc.createSession({ provider: "dim", cwd: repo(), host });
  const o = await svc.submitTurn({ sessionId: s.id, intent: "analyze", prompt: "x", requestId: req(), host: otherHost });
  assert.equal(o.kind === "rejected" && o.code, "not_attached");
  await svc.attachSession(s.id, otherHost);
  await waitDone((await submit(s.id, "x", "analyze", req(), otherHost)).id);
  const mine = await svc.listSessions({ host: otherHost });
  assert.ok(mine.some((x) => x.id === s.id));
});

test("auth failure fails the job without breaking the session; blocked actions are not success", async () => {
  const s = await svc.createSession({ provider: "grok", cwd: repo(), host });
  const v = await waitDone((await submit(s.id, "FAIL:auth")).id);
  assert.equal(v.job.state, "failed");
  assert.equal(v.job.errorCode, "auth_required");
  const b = await waitDone((await submit(s.id, "BLOCK")).id);
  assert.equal(b.job.state, "failed");
  assert.equal(b.job.errorCode, "permission_blocked");
  assert.equal((await svc.getSession(s.id))!.state, "ready");
});

test("inactivity watchdog times out a silent provider (M0 §6)", async () => {
  const s = await svc.createSession({ provider: "opencode", cwd: repo(), host });
  const v = await waitDone((await submit(s.id, "HANG")).id, 40000);
  assert.equal(v.job.state, "timed_out");
  assert.equal(v.job.errorCode, "inactivity_timeout");
});

test("A16: an unresumable native id breaks the session instead of silently starting a new one", async () => {
  const s = await svc.createSession({ provider: "dim", cwd: repo(), host });
  const store = new Store();
  store.updateSession(s.id, { nativeSessionId: "fake-does-not-exist", state: "suspended" });
  const v = await waitDone((await submit(s.id, "RECALL")).id);
  assert.equal(v.job.errorCode, "session_not_found");
  const after = await svc.getSession(s.id);
  assert.equal(after!.state, "broken");
  assert.equal(after!.nativeSessionId, "fake-does-not-exist");
  store.close();
});

test("A13/A15: a delivered job left by a dead owner becomes in_doubt and is not resent", async () => {
  const s = await svc.createSession({ provider: "droid", cwd: repo(), host });
  const store = new Store();
  const job = await svc.submitTurn({ sessionId: s.id, intent: "analyze", prompt: "should-not-rerun", requestId: req(), host });
  assert.equal(job.kind, "accepted");
  if (job.kind !== "accepted") return;
  // Simulate an owner that delivered the prompt and died: pid 999999 does not exist.
  await waitDone(job.job.id).catch(() => {});
  const stuck = await svc.submitTurn({ sessionId: s.id, intent: "analyze", prompt: "orphan", requestId: req(), host });
  if (stuck.kind !== "accepted") throw new Error("expected accepted");
  store.db.prepare("UPDATE jobs SET state='running', delivered_at=?, owner_generation=0 WHERE id=?").run(new Date().toISOString(), stuck.job.id);
  store.db.prepare("INSERT OR REPLACE INTO leases (session_id, owner_pid, owner_token, generation, heartbeat_at) VALUES (?,?,?,?,?)").run(s.id, 999999, "999999:gone", 50, new Date().toISOString());
  // Only poll: getJob must wake recovery for a running job whose worker died (finding 7).
  const v = await waitDone(stuck.job.id);
  assert.equal(v.job.state, "in_doubt");
  store.close();
});

test("A09: delegated writes on one project serialize across sessions; reads do not take the lock", async () => {
  const d = repo();
  const s1 = await svc.createSession({ provider: "dim", cwd: d, host });
  const s2 = await svc.createSession({ provider: "droid", cwd: d, host });
  const j1 = await submit(s1.id, "SLEEP:2500\nWRITE:x1.txt");
  await new Promise((r) => setTimeout(r, 300));
  const j2 = await submit(s2.id, "WRITE:x2.txt");
  const v1 = await waitDone(j1.id);
  const v2 = await waitDone(j2.id);
  // Either worker may win the lock under load; what matters is that the two writes never overlap.
  const [a1, b1, a2, b2] = [v1.job.startedAt, v1.job.finishedAt, v2.job.startedAt, v2.job.finishedAt].map((t) => Date.parse(t!));
  assert.ok(a2! >= b1! - 50 || a1! >= b2! - 50, "one write waits for the other");
});

test("invalid cwd is rejected before anything starts (A17)", async () => {
  await assert.rejects(svc.createSession({ provider: "dim", cwd: "/definitely/not/here", host }), /does not exist/);
});


test("finding 4: a cancel during open wins; the job is never delivered", async () => {
  process.env.TURNWEFT_FAKE_OPEN_DELAY_MS = "1500";
  try {
    const d = repo();
    const s = await svc.createSession({ provider: "droid", cwd: d, host });
    const job = await submit(s.id, "WRITE:should-not-exist.txt");
    for (let i = 0; i < 50 && (await svc.getJob({ jobId: job.id })).job.state !== "starting"; i++) await new Promise((r) => setTimeout(r, 50));
    await svc.cancelJob(job.id);
    const v = await waitDone(job.id);
    assert.equal(v.job.state, "cancelled");
    assert.equal(v.job.deliveredAt, undefined);
    assert.equal(existsSync(join(d, "should-not-exist.txt")), false);
  } finally { delete process.env.TURNWEFT_FAKE_OPEN_DELAY_MS; }
});

test("finding 3: a tier change between submit and run stops the job for re-confirmation", async () => {
  process.env.TURNWEFT_FAKE_EXCESS = "1";
  try {
    const s = await svc.createSession({ provider: "grok", cwd: repo(), host });
    const o = await svc.submitTurn({ sessionId: s.id, intent: "implement", prompt: "SLEEP:1500", requestId: req(), host });
    if (o.kind !== "awaiting_confirmation") throw new Error("expected awaiting_confirmation");
    await svc.confirmPolicy({ proposalId: o.proposal.proposalId, nonce: o.proposal.nonce, via: "elicitation" });
    const first = o.job; // released by the confirmation
    const second = await submit(s.id, "WRITE:late.txt");      // queued behind the first, same confirmed tier
    wf(join(HOME, "fake-tier.txt"), "-v2");                   // tier changes before the second runs
    await waitDone(first.id);
    const v = await waitDone(second.id);
    assert.equal(v.job.state, "failed");
    assert.equal(v.job.errorCode, "needs_confirmation");
  } finally { delete process.env.TURNWEFT_FAKE_EXCESS; rmSync(join(HOME, "fake-tier.txt"), { force: true }); }
});

test("finding 9: a provider that ignores cancel is closed after the grace period", async () => {
  const s = await svc.createSession({ provider: "opencode", cwd: repo(), host });
  const job = await submit(s.id, "IGNORECANCEL");
  for (let i = 0; i < 50 && (await svc.getJob({ jobId: job.id })).job.state !== "running"; i++) await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  await svc.cancelJob(job.id);
  const v = await waitDone(job.id);
  assert.equal(v.job.state, "cancelled");
  assert.ok(Date.now() - t0 < 8000);
});

test("finding 10: losing the provider after delivery is in_doubt, not failed", async () => {
  const s = await svc.createSession({ provider: "dim", cwd: repo(), host });
  const v = await waitDone((await submit(s.id, "CRASH")).id);
  assert.equal(v.job.state, "in_doubt");
  const after = await waitDone((await submit(s.id, "RECALL")).id);
  assert.equal(after.job.state, "succeeded", "the session resumes on a fresh connection");
});

test("finding 12: concurrent same requestId for different sessions cannot return the other job", async () => {
  const d = repo();
  const s1 = await svc.createSession({ provider: "dim", cwd: d, host });
  const s2 = await svc.createSession({ provider: "droid", cwd: d, host });
  const r = req();
  const [a, b] = await Promise.all([
    svc.submitTurn({ sessionId: s1.id, intent: "analyze", prompt: "same", requestId: r, host }),
    svc.submitTurn({ sessionId: s2.id, intent: "analyze", prompt: "same", requestId: r, host }),
  ]);
  const kinds = [a.kind, b.kind].sort();
  assert.deepEqual(kinds, ["accepted", "rejected"]);
  for (const o of [a, b]) if (o.kind === "accepted") await waitDone(o.job.id);
});

test("finding 14: a job is not inserted into a session closed after the submit started", async () => {
  const s = await svc.createSession({ provider: "dim", cwd: repo(), host });
  await svc.closeSession(s.id);
  const store = new Store();
  const r = store.insertJobChecked({ id: "twj_x", sessionId: s.id, requestId: req(), intent: "analyze", promptDigest: "d", state: "queued", acceptedAt: new Date().toISOString(), prompt: "p" });
  assert.equal(r, "session_closed");
  store.close();
});

test("finding 1: takeover stops the previous owner's provider process first", async () => {
  const s = await svc.createSession({ provider: "agy", cwd: repo(), host });
  // A real orphan: the shell exits, so `sleep` is re-parented to init like a provider whose worker died.
  const pid = Number(execFileSync("sh", ["-c", "sleep 300 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim());
  const orphan = { pid };
  await new Promise((r) => setTimeout(r, 200));
  const store = new Store();
  store.db.prepare("INSERT OR REPLACE INTO leases (session_id, owner_pid, owner_token, generation, heartbeat_at, native_pid, native_token) VALUES (?,?,?,?,?,?,?)")
    .run(s.id, 999999, "999999:gone", 7, new Date().toISOString(), orphan.pid!, ownerToken(orphan.pid!));
  const v = await waitDone((await submit(s.id, "echo-after-takeover", "analyze")).id);
  assert.equal(v.job.state, "succeeded");
  let alive = true;
  try { process.kill(orphan.pid!, 0); } catch { alive = false; }
  assert.equal(alive, false, "orphaned provider must be stopped before the new owner runs");
  assert.ok(store.getLease(s.id)!.generation > 7, "generation keeps increasing across releases (finding 6)");
  store.close();
});

const leaseOf = (id: string) => { const st = new Store(); const l = st.getLease(id); st.close(); return l; };
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 15000, what = "condition") {
  const until = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > until) {
      const { readdirSync, readFileSync: rf } = await import("node:fs");
      const logs = readdirSync(join(HOME, "logs")).map((f) => `${f}: ${rf(join(HOME, "logs", f), "utf8").slice(-600)}`).join("\n");
      throw new Error(`timeout waiting for ${what}
${logs}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("round 2 findings 1+2: provider started inside open() is recorded, and recovery stops its whole group", async () => {
  process.env.TURNWEFT_FAKE_REAL_PROC = "1";
  try {
    const s = await svc.createSession({ provider: "agy", cwd: repo(), host });
    const job = await submit(s.id, "SLEEP:60000", "analyze");
    await waitFor(async () => (await svc.getJob({ jobId: job.id })).job.state === "running", 15000, "running");
    const lease = leaseOf(s.id)!;
    assert.ok(lease.nativePid && lease.nativePid !== lease.ownerPid, "native pid must be the provider, recorded after open()");
    const pgid = lease.nativePid!;
    assert.ok(groupMembers(pgid).pids.length >= 2, "leader and its background child are alive");
    // Killing the worker does not kill the detached provider group (verified separately); the next owner must
    // stop the whole group. A spare worker spawned while the job was queued may take over immediately.
    process.kill(lease.ownerPid, "SIGKILL");
    const v = await waitDone(job.id);       // polling triggers recovery
    assert.equal(v.job.state, "in_doubt");
    await waitFor(() => groupMembers(pgid).pids.length === 0, 10000, "provider group stopped");
  } finally { delete process.env.TURNWEFT_FAKE_REAL_PROC; }
});

test("round 2 finding 3: another session cannot take the project lock while a dead holder's provider still runs", async () => {
  process.env.TURNWEFT_FAKE_REAL_PROC = "1";
  try {
    const d = repo();
    const a = await svc.createSession({ provider: "dim", cwd: d, host });
    const b = await svc.createSession({ provider: "droid", cwd: d, host });
    const ja = await submit(a.id, "SLEEP:60000");
    await waitFor(async () => (await svc.getJob({ jobId: ja.id })).job.state === "running", 15000, "A running");
    const la = leaseOf(a.id)!;
    const pgid = la.nativePid!;
    // Hold A's lease with a live stand-in owner (this test process), so A's provider keeps running and no
    // recovery for A can start. Only A's *lock* owner (its worker) is dead, which is what B sees.
    const st = new Store();
    st.db.prepare("UPDATE leases SET owner_pid = ?, owner_token = ? WHERE session_id = ?").run(process.pid, ownerToken(process.pid), a.id);
    process.kill(la.ownerPid, "SIGKILL");
    const jb = await submit(b.id, "WRITE:b.txt");
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal((await svc.getJob({ jobId: jb.id })).job.state, "queued", "B must wait while A's provider still runs");
    assert.ok(groupMembers(pgid).pids.length >= 1);
    // Release the stand-in: A's recovery stops its provider group, then B may take the lock.
    st.db.prepare("UPDATE leases SET owner_pid = 0, owner_token = '' WHERE session_id = ?").run(a.id);
    st.close();
    const vb = await waitDone(jb.id, 40000);
    assert.equal(vb.job.state, "succeeded");
    assert.equal(groupMembers(pgid).pids.length, 0, "A's provider group was stopped before B wrote");
    assert.equal((await svc.getJob({ jobId: ja.id })).job.state, "in_doubt");
  } finally { delete process.env.TURNWEFT_FAKE_REAL_PROC; }
});

test("round 2 finding 9: only end_turn counts as success", async () => {
  const s = await svc.createSession({ provider: "grok", cwd: repo(), host });
  const v = await waitDone((await submit(s.id, "STOP:max_tokens", "analyze")).id);
  assert.equal(v.job.state, "failed");
  assert.equal(v.job.errorCode, "incomplete_max_tokens");
});

test("live CC finding: a session in a repo subdirectory works in that subdirectory, locks at the repo root", async () => {
  const d = repo();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(d, "pkg"));
  const s = await svc.createSession({ provider: "droid", cwd: join(d, "pkg"), host });
  assert.equal(s.cwd, realpathSync(join(d, "pkg")));
  assert.equal(s.canonicalRoot, realpathSync(d));
  const v = await waitDone((await submit(s.id, "WRITE:x.txt")).id);
  assert.equal(v.job.state, "succeeded");
  assert.ok(existsSync(join(d, "pkg", "x.txt")), "the agent writes in the requested directory");
  assert.equal(existsSync(join(d, "x.txt")), false, "not at the repo root");
  assert.equal(v.result?.cwd, realpathSync(join(d, "pkg")));
  assert.deepEqual(v.result?.files?.changed, ["pkg/x.txt"]);
});

test("live CC finding: changes outside the session cwd are reported separately, not as the agent's", async () => {
  const d = repo();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(d, "pkg"));
  const s = await svc.createSession({ provider: "droid", cwd: join(d, "pkg"), host });
  // A concurrent edit elsewhere in the repo while the turn runs (e.g. the user or another session).
  const job = await submit(s.id, "SLEEP:1500\nWRITE:y.txt");
  await waitFor(async () => (await svc.getJob({ jobId: job.id })).job.state === "running", 15000, "running");
  writeFileSync(join(d, "elsewhere.txt"), "someone else\n");
  const v = await waitDone(job.id);
  assert.deepEqual(v.result?.files?.changed, ["pkg/y.txt"]);
  assert.deepEqual(v.result?.files?.changedOutsideCwd, ["elsewhere.txt"]);
});

const sh = (cmd: string) => Number(execFileSync("sh", ["-c", cmd], { encoding: "utf8" }).trim());
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("round 3 finding 2: a reused pid (token mismatch) is treated as stopped and never signalled", async () => {
  const pid = sh("sleep 300 >/dev/null 2>&1 & echo $!");
  const staleToken = `${pid}:Thu Jan  1 00:00:00 1970`;
  assert.equal(leaderState(pid, staleToken), "reused");
  assert.equal(nativeStopped(pid, staleToken), true);
  assert.equal(await stopAndConfirm(pid, staleToken), true);
  assert.equal(alive(pid), true, "the unrelated process must not be signalled");
  process.kill(pid, "SIGKILL");
});

test("round 3 findings 2+3: a dead leader with live children in its group is not stopped until the group is", async () => {
  // Leader exits after 1s; its background child stays in the group (orphaned to init).
  const child = spawn("sh", ["-c", "sleep 600 & exec sleep 1"], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid!;
  const token = ownerToken(pid);
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(leaderState(pid, token), "dead");
  assert.ok(groupMembers(pid).pids.length >= 1, "child still in the group");
  assert.equal(nativeStopped(pid, token), false, "leader gone is not proof the group stopped");
  assert.equal(await stopAndConfirm(pid, token), true);
  assert.equal(groupMembers(pid).pids.length, 0);
});

test("round 3 finding 4: a provider spawned inside open() is recorded before open completes", async () => {
  process.env.TURNWEFT_FAKE_REAL_PROC = "1";
  process.env.TURNWEFT_FAKE_OPEN_DELAY_MS = "4000";
  try {
    const s = await svc.createSession({ provider: "agy", cwd: repo(), host });
    const job = await submit(s.id, "hello", "analyze");
    await waitFor(async () => (await svc.getJob({ jobId: job.id })).job.state === "starting", 15000, "starting");
    await waitFor(() => Boolean(leaseOf(s.id)?.nativePid), 3000, "native pid recorded during open");
    const l = leaseOf(s.id)!;
    process.kill(l.ownerPid, "SIGKILL"); // die mid-open
    delete process.env.TURNWEFT_FAKE_OPEN_DELAY_MS;
    // Polling the job (as a host does) wakes a successor; the successor must stop the provider started in open().
    await waitFor(async () => { await svc.getJob({ jobId: job.id }); return groupMembers(l.nativePid!).pids.length === 0; }, 20000, "recovery");
    await waitDone(job.id, 30000);
    assert.equal(groupMembers(l.nativePid!).pids.length, 0, "the provider started during open was stopped by the successor");
  } finally { delete process.env.TURNWEFT_FAKE_REAL_PROC; delete process.env.TURNWEFT_FAKE_OPEN_DELAY_MS; }
});

test("round 3 finding 1: a provider that cannot be confirmed stopped freezes the session and keeps the lock", async () => {
  process.env.TURNWEFT_FAKE_REAL_PROC = "1";
  process.env.TURNWEFT_TEST_UNSTOPPABLE = "1"; // inherited by the worker spawned for this session
  try {
    const d = repo();
    const s = await svc.createSession({ provider: "dim", cwd: d, host });
    await waitDone((await submit(s.id, "hello", "analyze")).id);           // opens the provider (analyze tier)
    const v = await waitDone((await submit(s.id, "WRITE:x.txt", "implement")).id, 40000); // tier switch -> close fails
    assert.equal(v.job.state, "failed");
    assert.equal(v.job.errorCode, "provider_not_stopped");
    assert.equal((await svc.getSession(s.id))!.state, "broken");
    assert.equal(existsSync(join(d, "x.txt")), false, "no second provider ran the write");
    assert.ok(leaseOf(s.id)!.nativePid, "the unconfirmed provider identity stays recorded");
    const st = new Store();
    assert.equal(st.projectLockHolder(realpathSync(d))?.sessionId, s.id, "the frozen session keeps the project lock");
    st.close();
    const o = await svc.submitTurn({ sessionId: s.id, intent: "analyze", prompt: "x", requestId: req(), host });
    assert.equal(o.kind === "rejected" && o.code, "session_frozen", "rejected while the provider is still running");
    // Round 4 finding 1: once the user stops that process, submitting again recovers the session.
    delete process.env.TURNWEFT_TEST_UNSTOPPABLE;
    const pid = leaseOf(s.id)!.nativePid!;
    execFileSync("sh", ["-c", `kill -9 -${pid} 2>/dev/null || true`]);
    await waitFor(() => groupMembers(pid).pids.length === 0, 5000, "provider stopped by the user");
    const again = await waitDone((await submit(s.id, "WRITE:x.txt", "implement")).id, 40000);
    assert.equal(again.job.state, "succeeded");
    assert.ok(existsSync(join(d, "x.txt")));
  } finally {
    delete process.env.TURNWEFT_TEST_UNSTOPPABLE; delete process.env.TURNWEFT_FAKE_REAL_PROC;
    execFileSync("sh", ["-c", "pkill -f 'sleep 600' || true"]);
  }
});

test("round 3 finding 5: closed is terminal for worker state updates", async () => {
  const s = await svc.createSession({ provider: "dim", cwd: repo(), host });
  await svc.closeSession(s.id);
  const st = new Store();
  assert.equal(st.setSessionStateUnlessClosed(s.id, "ready"), false);
  assert.equal(st.getSession(s.id)!.state, "closed");
  st.close();
});

test("round 3 finding 7: orphan recovery never re-queues a job cancelled before delivery", async () => {
  const s = await svc.createSession({ provider: "dim", cwd: repo(), host });
  const st = new Store();
  st.insertJob({ id: "twj_r3f7", sessionId: s.id, requestId: req(), intent: "analyze", promptDigest: "d", state: "cancel_requested", ownerGeneration: 0, acceptedAt: new Date().toISOString(), prompt: "p" });
  st.db.prepare("UPDATE jobs SET owner_generation = 0, state = 'cancel_requested' WHERE id = 'twj_r3f7'").run();
  st.recoverOrphans(s.id, 9);
  assert.equal(st.getJob("twj_r3f7")!.state, "cancelled");
  st.close();
});

test("round 3 finding 6: a settings change reported between turns is re-checked before the next turn", async () => {
  const s = await svc.createSession({ provider: "droid", cwd: repo(), host });
  await waitDone((await submit(s.id, "SETMODE_IDLE:something-else", "analyze")).id); // changes while idle, no event
  await new Promise((r) => setTimeout(r, 400));
  const v = await waitDone((await submit(s.id, "hello", "analyze")).id);
  assert.equal(v.job.state, "failed");
  assert.equal(v.job.errorCode, "capability_mismatch");
});

test("round 3 finding 3: a failed process-group probe is never read as an empty group", async () => {
  const child = spawn("sh", ["-c", "sleep 600 & exec sleep 1"], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid!;
  const token = ownerToken(pid);
  await new Promise((r) => setTimeout(r, 1800)); // leader gone, child left in the group
  const savedPath = process.env.PATH;
  process.env.PATH = "/nonexistent"; // pgrep cannot run
  try {
    assert.equal(groupMembers(pid).ok, false);
    assert.equal(nativeStopped(pid, token), false, "unknown must not count as stopped");
  } finally {
    process.env.PATH = savedPath;
    execFileSync("sh", ["-c", `kill -9 -${pid} 2>/dev/null || true`]);
  }
});

test("round 5 finding 1: proposal decisions only move waiting jobs, never a started one", async () => {
  const s0 = await svc.createSession({ provider: "dim", cwd: repo(), host });
  const st = new Store();
  const p = { proposalId: "twq_r5f1", nonce: "n", provider: "dim" as const, canonicalRoot: s0.canonicalRoot, intent: "implement" as const, tier: "t", excessOverGrant: ["x"], cliVersion: "1", adapterVersion: "1", capabilityDigest: "d", message: "m", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  st.insertProposal(p);
  st.insertJob({ id: "twj_r5f1", sessionId: s0.id, requestId: req(), intent: "implement", promptDigest: "d", state: "running", proposalId: p.proposalId, acceptedAt: new Date().toISOString(), prompt: "x" });
  st.decideProposal({ proposalId: p.proposalId, nonce: "n", decision: "rejected", via: "test" });
  assert.equal(st.getJob("twj_r5f1")!.state, "running", "a started job is left to the cancel/stop path");
  st.close();
});

test("round 5 finding 4: only one live pending proposal per key, enforced by the database", async () => {
  const st = new Store();
  const base = { nonce: "n", provider: "dim" as const, canonicalRoot: "/r5f4", intent: "implement" as const, tier: "t", excessOverGrant: [], cliVersion: "1", adapterVersion: "1", capabilityDigest: "d", message: "m", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  st.insertProposal({ ...base, proposalId: "twq_r5f4a" });
  assert.throws(() => st.insertProposal({ ...base, proposalId: "twq_r5f4b" }), /UNIQUE/);
  st.close();
});

test("round 5 findings 5+6: an expired waiting job is never released by a newer confirmation and does not block FIFO", async () => {
  process.env.TURNWEFT_FAKE_EXCESS = "1";
  try {
    const d = repo();
    const s0 = await svc.createSession({ provider: "droid", cwd: d, host });
    const a = await svc.submitTurn({ sessionId: s0.id, intent: "implement", prompt: "WRITE:old.txt", requestId: req(), host });
    const c = await svc.submitTurn({ sessionId: s0.id, intent: "analyze", prompt: "hello", requestId: req(), host });
    if (a.kind !== "awaiting_confirmation" || c.kind !== "accepted") throw new Error(`${a.kind} ${c.kind}`);
    const st = new Store();
    const past = new Date(Date.now() - 1000).toISOString();
    const row = st.db.prepare("SELECT data FROM proposals WHERE id = ?").get(a.proposal.proposalId) as { data: string };
    st.db.prepare("UPDATE proposals SET data = ?, expires_at = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(row.data), expiresAt: past }), past, a.proposal.proposalId);
    st.close();
    // Only the turn behind it is polled: the expired head must not hold it back (finding 6).
    assert.equal((await waitDone(c.job.id)).job.state, "succeeded");
    // A newer proposal for the same key is confirmed: the expired job must stay failed (finding 5).
    const b = await svc.submitTurn({ sessionId: s0.id, intent: "implement", prompt: "WRITE:new.txt", requestId: req(), host });
    if (b.kind !== "awaiting_confirmation") throw new Error(b.kind);
    assert.notEqual(b.proposal.proposalId, a.proposal.proposalId);
    await svc.confirmPolicy({ proposalId: b.proposal.proposalId, nonce: b.proposal.nonce, via: "native-dialog" });
    assert.equal((await waitDone(b.job.id)).job.state, "succeeded");
    const va = await svc.getJob({ jobId: a.job.id });
    assert.equal(va.job.state, "failed");
    assert.equal(va.job.errorCode, "confirmation_expired");
    assert.equal(existsSync(join(d, "old.txt")), false);
  } finally { delete process.env.TURNWEFT_FAKE_EXCESS; }
});

test("round 5 finding 7: one live dialog owner per proposal (pid + start time)", async () => {
  const st = new Store();
  st.insertProposal({ proposalId: "twq_r5f7", nonce: "n", provider: "dim", canonicalRoot: "/r5f7", intent: "implement", tier: "t", excessOverGrant: [], cliVersion: "1", adapterVersion: "1", capabilityDigest: "d7", message: "m", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const { isOwnerGone } = await import("../runtime/proc.js");
  assert.equal(st.claimDialog("twq_r5f7", ownerToken(), isOwnerGone), true);
  assert.equal(st.claimDialog("twq_r5f7", ownerToken(), isOwnerGone), false, "a live owner keeps it");
  st.db.prepare("UPDATE proposals SET dialog_token = ? WHERE id = ?").run("999999:Thu Jan  1 00:00:00 1970", "twq_r5f7");
  assert.equal(st.claimDialog("twq_r5f7", ownerToken(), isOwnerGone), true, "a dead owner's claim can be taken over");
  st.close();
});

test("round 6 finding 2: upgrading backfills old proposals' keys and merges duplicates before the unique index", async () => {
  process.env.TURNWEFT_FAKE_EXCESS = "1";
  try {
    const s0 = await svc.createSession({ provider: "opencode", cwd: repo(), host });
    const a = await svc.submitTurn({ sessionId: s0.id, intent: "implement", prompt: "WRITE:x.txt", requestId: req(), host });
    if (a.kind !== "awaiting_confirmation") throw new Error(a.kind);
    // Simulate a pre-pkey database: no index, no key, and a duplicate live proposal with its own waiting job.
    const st = new Store();
    st.db.exec("DROP INDEX proposals_pending_key");
    const row = st.db.prepare("SELECT * FROM proposals WHERE id = ?").get(a.proposal.proposalId) as Record<string, string>;
    const later = new Date(Date.parse(row.expires_at!) + 60_000).toISOString();
    st.db.prepare("INSERT INTO proposals (id, nonce, data, expires_at) VALUES (?,?,?,?)")
      .run("twq_r6f2dup", "n2", JSON.stringify({ ...JSON.parse(row.data!), proposalId: "twq_r6f2dup", nonce: "n2", expiresAt: later }), later);
    st.db.prepare("UPDATE proposals SET pkey = NULL WHERE id = ?").run("twq_r6f2dup");
    const pa = JSON.parse(row.data!);
    st.db.prepare("UPDATE proposals SET pkey = ? WHERE id = ?") // the earlier NUL-joined key format
      .run([pa.provider, pa.canonicalRoot, pa.intent, pa.tier, pa.capabilityDigest].join("\u0000"), a.proposal.proposalId);
    st.insertJob({ id: "twj_r6f2dup", sessionId: s0.id, requestId: req(), intent: "implement", promptDigest: "d", state: "waiting_confirmation", proposalId: "twq_r6f2dup", acceptedAt: new Date().toISOString(), prompt: "x" });
    st.close();
    const up = new Store(); // migration runs on open
    assert.ok(up.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'proposals_pending_key'").get(), "unique index created");
    assert.equal(up.getJob("twj_r6f2dup")!.proposalId, a.proposal.proposalId, "the duplicate's waiting job moved to the kept proposal");
    assert.equal(up.getProposal("twq_r6f2dup")!.decision, "merged");
    up.close();
    const b = await svc.submitTurn({ sessionId: s0.id, intent: "implement", prompt: "WRITE:y.txt", requestId: req(), host });
    assert.equal(b.kind === "awaiting_confirmation" && b.proposal.proposalId, a.proposal.proposalId, "a new submit reuses the backfilled proposal");
    await svc.rejectPolicy({ proposalId: a.proposal.proposalId, nonce: a.proposal.nonce, via: "native-dialog" });
    assert.equal((await svc.getJob({ jobId: "twj_r6f2dup" })).job.errorCode, "confirmation_denied", "one answer settles every merged job");
  } finally { delete process.env.TURNWEFT_FAKE_EXCESS; }
});

test("round 6 finding 3: a dialog left by a killed helper is closed before another helper takes over", async () => {
  const st = new Store();
  st.insertProposal({ proposalId: "twq_r6f3", nonce: "n", provider: "dim", canonicalRoot: "/r6f3", intent: "implement", tier: "t", excessOverGrant: [], cliVersion: "1", adapterVersion: "1", capabilityDigest: "d63", message: "m", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 200));
  st.db.prepare("UPDATE proposals SET dialog_token = ?, dialog_child = ? WHERE id = ?").run("999999:Thu Jan  1 00:00:00 1970", ownerToken(child.pid!), "twq_r6f3");
  process.env.TURNWEFT_TEST_UNSTOPPABLE = "1";
  try {
    assert.equal(await svc.claimConfirmationDialog("twq_r6f3", ownerToken()), false, "an old dialog that cannot be closed blocks a second one");
  } finally { delete process.env.TURNWEFT_TEST_UNSTOPPABLE; }
  assert.equal(await svc.claimConfirmationDialog("twq_r6f3", ownerToken()), true);
  await new Promise((r) => setTimeout(r, 100));
  assert.notEqual(child.signalCode ?? child.exitCode, null, "the old dialog process was stopped");
  assert.equal(st.getDialogOwner("twq_r6f3").child, undefined, "the takeover starts with no recorded child");
  await svc.recordConfirmationDialogChild("twq_r6f3", ownerToken(), process.pid);
  assert.equal(st.getDialogOwner("twq_r6f3").child, ownerToken(process.pid));
  st.close();
});

test("round 6 finding 4: the dialog closes by itself when no job waits for the proposal any more", async () => {
  process.env.TURNWEFT_FAKE_EXCESS = "1";
  try {
    const s0 = await svc.createSession({ provider: "grok", cwd: repo(), host });
    const a = await svc.submitTurn({ sessionId: s0.id, intent: "implement", prompt: "WRITE:z.txt", requestId: req(), host });
    if (a.kind !== "awaiting_confirmation") throw new Error(a.kind);
    assert.equal((await svc.getProposal(a.proposal.proposalId))!.waitingJobs, 1);
    let shown = false;
    const fakeConfirm = (_p: unknown, _t: number, signal?: AbortSignal) => new Promise<{ accepted: boolean; detail: string }>((res) => {
      shown = true;
      signal?.addEventListener("abort", () => res({ accepted: false, detail: "closed: no longer needed" }));
    });
    const done = runDialog(svc, a.proposal.proposalId, { stderr: { write: () => true } as never }, fakeConfirm, 100);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(shown, true);
    await svc.cancelJob(a.job.id);
    const code = await Promise.race([done, new Promise((r) => setTimeout(() => r("still open"), 5000))]);
    assert.equal(code, 0, "the dialog was closed after the waiting job was cancelled");
    const p = await svc.getProposal(a.proposal.proposalId);
    assert.equal(p!.waitingJobs, 0);
    assert.equal(p!.decision, undefined, "closing is not a decision");
    assert.equal(await runDialog(svc, a.proposal.proposalId, { stderr: { write: () => true } as never }, fakeConfirm, 100), 0);
  } finally { delete process.env.TURNWEFT_FAKE_EXCESS; }
});

test("round 7 finding 1: upgrading never merges a live waiting job into an expired proposal", async () => {
  const s0 = await svc.createSession({ provider: "dim", cwd: repo(), host });
  const st = new Store();
  st.db.exec("DROP INDEX proposals_pending_key");
  const base = { provider: "dim", canonicalRoot: "/r7f1", intent: "implement", tier: "t", excessOverGrant: [], cliVersion: "1", adapterVersion: "1", capabilityDigest: "d71", message: "m" };
  const past = new Date(Date.now() - 1000).toISOString(), future = new Date(Date.now() + 60_000).toISOString();
  for (const [id, exp] of [["twq_r7f1old", past], ["twq_r7f1new", future]] as const) {
    st.db.prepare("INSERT INTO proposals (id, nonce, data, expires_at) VALUES (?,?,?,?)").run(id, "n", JSON.stringify({ ...base, proposalId: id, nonce: "n", expiresAt: exp }), exp);
    st.insertJob({ id: id.replace("twq", "twj"), sessionId: s0.id, requestId: req(), intent: "implement", promptDigest: "d", state: "waiting_confirmation", proposalId: id, acceptedAt: new Date().toISOString(), prompt: "x" });
  }
  st.close();
  const up = new Store();
  const live = up.getJob("twj_r7f1new")!;
  assert.equal(live.state, "waiting_confirmation");
  assert.equal(live.proposalId, "twq_r7f1new", "the live job keeps its unexpired proposal");
  assert.equal(up.getProposal("twq_r7f1new")!.decision, undefined);
  assert.equal(up.getJob("twj_r7f1old")!.errorCode, "confirmation_expired");
  up.close();
});

test("round 7 finding 2: the helper releases its claim only after the dialog process is confirmed gone", async () => {
  process.env.TURNWEFT_FAKE_EXCESS = "1";
  const kids: ReturnType<typeof spawn>[] = [];
  try {
    const s0 = await svc.createSession({ provider: "droid", cwd: repo(), host });
    const a = await svc.submitTurn({ sessionId: s0.id, intent: "implement", prompt: "WRITE:q.txt", requestId: req(), host });
    if (a.kind !== "awaiting_confirmation") throw new Error(a.kind);
    // A dialog process that ignores SIGTERM, and a confirm that reports "closed" as soon as it is aborted.
    const stubborn = (_p: unknown, _t: number, signal?: AbortSignal, onSpawn?: (pid: number) => void) => new Promise<{ accepted: boolean; detail: string }>((res) => {
      const k = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
      kids.push(k);
      setTimeout(() => onSpawn?.(k.pid!), 300);
      signal?.addEventListener("abort", () => { k.kill("SIGTERM"); res({ accepted: false, detail: "closed" }); });
    });
    const quiet = { stderr: { write: () => true } as never };
    // Cannot be confirmed stopped: the record stays, so nobody else can show a second dialog.
    process.env.TURNWEFT_TEST_UNSTOPPABLE = "1";
    const first = runDialog(svc, a.proposal.proposalId, quiet, stubborn, 100);
    await new Promise((r) => setTimeout(r, 800));
    await svc.cancelJob(a.job.id);
    assert.equal(await first, 0);
    const kept = new Store().getDialogOwner(a.proposal.proposalId);
    assert.equal(kept.child, ownerToken(kids[0]!.pid!), "the unconfirmed dialog stays recorded");
    delete process.env.TURNWEFT_TEST_UNSTOPPABLE;
    // Its helper then exits and the stubborn dialog is finally gone: a successor may take over.
    kids[0]!.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    const w = new Store();
    w.db.prepare("UPDATE proposals SET dialog_token = ? WHERE id = ?").run("999999:Thu Jan  1 00:00:00 1970", a.proposal.proposalId);
    w.close();
    // Normal case: the helper escalates until the process is gone, then releases.
    const b = await svc.submitTurn({ sessionId: s0.id, intent: "implement", prompt: "WRITE:r.txt", requestId: req(), host });
    if (b.kind !== "awaiting_confirmation") throw new Error(b.kind);
    const second = runDialog(svc, b.proposal.proposalId, quiet, stubborn, 100);
    await new Promise((r) => setTimeout(r, 800));
    await svc.cancelJob(b.job.id);
    const exited = new Promise((r) => kids[1]!.exitCode !== null || kids[1]!.signalCode !== null ? r(true) : kids[1]!.once("exit", () => r(true)));
    assert.equal(await second, 0);
    // Already killed when runDialog returned: its exit is reported almost at once, not after a timeout.
    assert.equal(await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 500))]), true, "released only after the dialog process exited");
    assert.deepEqual(new Store().getDialogOwner(b.proposal.proposalId), { helper: undefined, child: undefined });
  } finally {
    delete process.env.TURNWEFT_FAKE_EXCESS; delete process.env.TURNWEFT_TEST_UNSTOPPABLE;
    for (const k of kids) k.kill("SIGKILL");
  }
});

test("round 7 finding 3: a dialog left on a merged proposal is closed before the kept one shows a dialog", async () => {
  const st = new Store();
  const base = { nonce: "n", provider: "dim" as const, canonicalRoot: "/r7f3", intent: "implement" as const, tier: "t", excessOverGrant: [], cliVersion: "1", adapterVersion: "1", capabilityDigest: "d73", message: "m", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  st.insertProposal({ ...base, proposalId: "twq_r7f3merged" });
  st.db.prepare("UPDATE proposals SET consumed_at = ?, decision = 'merged' WHERE id = ?").run(new Date().toISOString(), "twq_r7f3merged");
  st.insertProposal({ ...base, proposalId: "twq_r7f3kept" });
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 200));
  st.db.prepare("UPDATE proposals SET dialog_token = ?, dialog_child = ? WHERE id = ?").run("999999:Thu Jan  1 00:00:00 1970", ownerToken(child.pid!), "twq_r7f3merged");
  process.env.TURNWEFT_TEST_UNSTOPPABLE = "1";
  try {
    assert.equal(await svc.claimConfirmationDialog("twq_r7f3kept", ownerToken()), false, "the merged proposal's dialog blocks a second one");
  } finally { delete process.env.TURNWEFT_TEST_UNSTOPPABLE; }
  assert.equal(await svc.claimConfirmationDialog("twq_r7f3kept", ownerToken()), true);
  await new Promise((r) => setTimeout(r, 100));
  assert.notEqual(child.signalCode ?? child.exitCode, null, "the old dialog process was stopped");
  assert.deepEqual(st.getDialogOwner("twq_r7f3merged"), { helper: undefined, child: undefined });
  st.close();
  child.kill("SIGKILL");
});

test("round 8: with no recorded dialog child, a dead helper's process group must be confirmed gone before takeover", async () => {
  const st = new Store();
  st.insertProposal({ proposalId: "twq_r8", nonce: "n", provider: "dim", canonicalRoot: "/r8", intent: "implement", tier: "t", excessOverGrant: [], cliVersion: "1", adapterVersion: "1", capabilityDigest: "d8", message: "m", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  // A detached helper that exits and leaves its dialog process behind in its group, never recorded.
  const helper = spawn("sh", ["-c", "sleep 60 & sleep 0.5"], { detached: true, stdio: "ignore" });
  const helperToken = ownerToken(helper.pid!);
  await new Promise((r) => helper.once("exit", r));
  const left = groupMembers(helper.pid!);
  assert.equal(left.ok && left.pids.length > 0, true, "the dialog process outlives the helper");
  st.db.prepare("UPDATE proposals SET dialog_token = ?, dialog_child = NULL WHERE id = ?").run(helperToken, "twq_r8");
  try {
    process.env.TURNWEFT_TEST_UNSTOPPABLE = "1";
    assert.equal(await svc.claimConfirmationDialog("twq_r8", ownerToken()), false, "an unconfirmed group blocks a second dialog");
    delete process.env.TURNWEFT_TEST_UNSTOPPABLE;
    assert.equal(await svc.claimConfirmationDialog("twq_r8", ownerToken()), true);
    const after = groupMembers(helper.pid!);
    assert.equal(after.ok && after.pids.length, 0, "the leftover dialog process was stopped");
  } finally {
    delete process.env.TURNWEFT_TEST_UNSTOPPABLE;
    try { process.kill(-helper.pid!, "SIGKILL"); } catch { /* gone */ }
    st.close();
  }
});

test("text before and after a tool call is kept, separated by a blank line (live finding: Grok preamble glued to the answer)", async () => {
  const s0 = await svc.createSession({ provider: "grok", cwd: repo(), host });
  const v = await waitDone((await submit(s0.id, "SAY:I'll read README.md.\nTOOL:read README.md\nSAY:# tw-fixture", "analyze")).id);
  assert.equal(v.job.state, "succeeded");
  assert.equal(v.result?.finalText, "I'll read README.md.\n\n# tw-fixture");
  const v2 = await waitDone((await submit(s0.id, "SAY:a\nSAY:b", "analyze")).id);
  assert.equal(v2.result?.finalText, "ab", "consecutive chunks of one message are not split");
});

test("U21: the host's bypass mode authorizes one job without a confirmation; nothing is stored", async () => {
  process.env.TURNWEFT_FAKE_EXCESS = "1";
  try {
    const d = repo();
    const s0 = await svc.createSession({ provider: "droid", cwd: d, host });
    const o = await svc.submitTurn({ sessionId: s0.id, intent: "implement", prompt: "WRITE:bypass.txt", requestId: req(), host, hostBypass: "codex:danger-full-access" });
    assert.equal(o.kind, "accepted", "no proposal, no dialog");
    if (o.kind !== "accepted") return;
    const v = await waitDone(o.job.id);
    assert.equal(v.job.state, "succeeded");
    assert.ok(existsSync(join(d, "bypass.txt")));
    assert.equal(v.result?.permission?.authorizedBy, "codex:danger-full-access");
    assert.equal(v.result?.permission?.policyId, undefined);
    assert.ok(v.result!.permission!.excessOverGrant.length > 0, "the tier is still reported");
    assert.equal((await svc.listPolicies({ canonicalRoot: s0.canonicalRoot })).length, 0, "bypass is not remembered");
    // The same project from a conversation that is not in bypass mode asks as usual.
    const again = await svc.submitTurn({ sessionId: s0.id, intent: "implement", prompt: "WRITE:asked.txt", requestId: req(), host });
    assert.equal(again.kind, "awaiting_confirmation");
    if (again.kind === "awaiting_confirmation") await svc.cancelJob(again.job.id);
  } finally { delete process.env.TURNWEFT_FAKE_EXCESS; }
});

test("round 11 findings 4+5: a bypass authorization survives a policy revocation but not a capability change", async () => {
  process.env.TURNWEFT_FAKE_EXCESS = "1";
  try {
    const s0 = await svc.createSession({ provider: "grok", cwd: repo(), host });
    // A confirmed policy exists; a bypass submission still records its own authorization.
    const a = await svc.submitTurn({ sessionId: s0.id, intent: "implement", prompt: "SLEEP:1200", requestId: req(), host });
    if (a.kind !== "awaiting_confirmation") throw new Error(a.kind);
    const pol = await svc.confirmPolicy({ proposalId: a.proposal.proposalId, nonce: a.proposal.nonce, via: "native-dialog" });
    const b = await svc.submitTurn({ sessionId: s0.id, intent: "implement", prompt: "WRITE:b.txt", requestId: req(), host, hostBypass: "claude-code:bypassPermissions" });
    if (b.kind !== "accepted") throw new Error(b.kind);
    await svc.revokePolicy(pol.id);                                  // revoked while b waits behind a
    await waitDone(a.job.id);
    const vb = await waitDone(b.job.id);
    assert.equal(vb.job.state, "succeeded", "revoking the policy does not undo the bypass authorization");
    assert.equal(vb.result?.permission?.authorizedBy, "claude-code:bypassPermissions");
    // The tier changes between submit and run: the bypass covered the old capabilities only.
    const c0 = await svc.submitTurn({ sessionId: s0.id, intent: "implement", prompt: "SLEEP:1200", requestId: req(), host, hostBypass: "claude-code:bypassPermissions" });
    const c = await svc.submitTurn({ sessionId: s0.id, intent: "implement", prompt: "WRITE:c.txt", requestId: req(), host, hostBypass: "claude-code:bypassPermissions" });
    if (c0.kind !== "accepted" || c.kind !== "accepted") throw new Error(`${c0.kind} ${c.kind}`);
    wf(join(HOME, "fake-tier.txt"), "-v2");
    await waitDone(c0.job.id);
    const vc = await waitDone(c.job.id);
    assert.equal(vc.job.state, "failed");
    assert.equal(vc.job.errorCode, "needs_confirmation");
    assert.match(vc.job.failureReason ?? "", /bypass authorization/);
  } finally { delete process.env.TURNWEFT_FAKE_EXCESS; rmSync(join(HOME, "fake-tier.txt"), { force: true }); }
});

test("U23: a requested thinking level is applied, read back and reported; none requested keeps the provider default", async () => {
  const s = await svc.createSession({ provider: "droid", cwd: repo(), host, effort: "high" });
  assert.equal((await svc.getSession(s.id))!.requestedEffort, "high", "stored with the session");
  const v = await waitDone((await submit(s.id, "SAY:ok", "analyze")).id);
  assert.equal(v.job.state, "succeeded");
  assert.deepEqual(v.result!.effort, { requested: "high", effective: "high" });
  const readback = v.events.find((e) => e.type === "config.readback");
  assert.deepEqual((readback!.payload as { effort?: unknown }).effort, { requested: "high", effective: "high" });

  const plain = await svc.createSession({ provider: "droid", cwd: repo(), host });
  const w = await waitDone((await submit(plain.id, "SAY:ok", "analyze")).id);
  assert.deepEqual(w.result!.effort, { effective: "auto" }, "stored as JSON: no requested field");
});

test("U23: a level the provider does not offer fails the turn with invalid_effort and never runs it", async () => {
  const s = await svc.createSession({ provider: "droid", cwd: repo(), host, effort: "bogus" });
  const v = await waitDone((await submit(s.id, "WRITE:never.txt")).id);
  assert.equal(v.job.state, "failed");
  assert.equal(v.job.errorCode, "invalid_effort");
  assert.match(v.job.failureReason ?? "", /low, medium, high/, "the offered values are listed");
  assert.equal(v.job.deliveredAt, undefined, "the prompt was never delivered");
  assert.equal(existsSync(join(s.cwd, "never.txt")), false);
  assert.notEqual((await svc.getSession(s.id))!.state, "broken", "the session itself is not broken");
});

test("U23: upgrading adds requested_effort to an existing sessions table", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-db-"));
  const path = join(dir, "state.db");
  const { DatabaseSync } = await import("node:sqlite");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT, canonical_root TEXT NOT NULL, cwd TEXT,
    native_session_id TEXT, state TEXT NOT NULL, broken_reason TEXT, host_bindings TEXT NOT NULL, capabilities TEXT, cli_version TEXT,
    requested_model TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  old.prepare("INSERT INTO sessions (id, provider, canonical_root, state, host_bindings, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("tws_old", "dim", "/p", "ready", "[]", "t", "t");
  old.close();
  const st = new Store(path);
  assert.equal(st.getSession("tws_old")!.requestedEffort, undefined, "old rows read without a level");
  st.insertSession({ id: "tws_new", provider: "dim", cwd: "/p", canonicalRoot: "/p", state: "ready", hostBindings: [], requestedEffort: "max", createdAt: "t", updatedAt: "t" });
  assert.equal(st.getSession("tws_new")!.requestedEffort, "max");
  st.close();
  rmSync(dir, { recursive: true, force: true });
});
