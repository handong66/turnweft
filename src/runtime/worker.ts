// Active-session executor (§6.2): the single owner of one session's native connection.
// Spawned detached by the service; exits when idle (U13) or when the session closes.
// Every job write is fenced by owner generation; takeover requires proof the previous native executor stopped.
import { renderMessage, text as messageText } from "../core/i18n.js";
import type { Job, JobResult, JobState, PermissionMapping, Session } from "../core/types.js";
import { getAdapter } from "../adapters/registry.js";
import { AdapterError, type Adapter, type AdapterEvent, type Connection, type TierSpec } from "../adapters/types.js";
import { loadConfig } from "./config.js";
import { now } from "./ids.js";
import { providerError } from "./secrets.js";
import { capabilityDigest, matchPolicy } from "./policy.js";
import { isOwnerGone, nativeStopped, ownerToken, stopAndConfirm } from "./proc.js";
import { ensureWorkerFor } from "./spawn.js";
import { diffSnapshots, snapshot } from "./project.js";
import { Store } from "./store.js";
import { relative } from "node:path";

const MAX_TEXT = 1_000_000;
/** Marks a session broken only because its provider could not be confirmed stopped (recoverable). */
export const FROZEN_PREFIX = "frozen: ";
const TEXT_EVENT_CHUNK = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Cfg = ReturnType<typeof loadConfig>;

/** The live connection, so a signal handler can stop the provider before the worker exits. */
let liveConn: Connection | undefined;
export async function shutdownWorker() {
  const c = liveConn;
  liveConn = undefined;
  if (c) await Promise.race([c.close().catch(() => {}), sleep(5000)]);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new AdapterError("provider_error", `${what} timed out after ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(t));
}

/** Prove the previous owner's provider process is gone (stopping it if needed) before claiming (finding 1). */
async function claim(store: Store, sessionId: string, token: string): Promise<number | undefined> {
  const prev = store.getLease(sessionId);
  if (prev && prev.ownerToken !== "" && !isOwnerGone(prev.ownerPid, prev.ownerToken)) return undefined;
  if (prev?.nativePid && prev.nativeToken && !(await stopAndConfirm(prev.nativePid, prev.nativeToken))) {
    console.error(`[turnweft-worker ${sessionId}] previous provider process ${prev.nativePid} could not be stopped; not taking over`);
    return undefined;
  }
  return store.claimLease(sessionId, process.pid, token, isOwnerGone, prev?.generation ?? 0, nativeStopped);
}

export async function runWorker(sessionId: string, store = new Store()): Promise<string> {
  const cfg = loadConfig();
  const token = ownerToken();
  const generation = await claim(store, sessionId, token);
  if (generation === undefined) return "lease_held";

  let session = store.getSession(sessionId);
  if (!session) { store.releaseLease(sessionId, token); return "no_session"; }
  const adapter = getAdapter(session.provider);

  // §9.2 recovery, decided per job inside the write lock (round 3, finding 7).
  store.recoverOrphans(sessionId, generation);

  const hb = setInterval(() => { if (!store.heartbeat(sessionId, token)) { void shutdownWorker().then(() => process.exit(3)); } }, 5000);
  let conn: Connection | undefined;
  let connTier: string | undefined;
  let connVersion: string | undefined;
  let lastOpen: { effective: Record<string, string>; model: JobResult["model"] } = { effective: {}, model: undefined };
  let idleSince = Date.now();
  let nativeUnconfirmed = false;
  let frozen: string | undefined;
  const lockNoted = new Set<string>();
  /** Provider identity captured the moment it was spawned; never re-derived later (round 3, finding 2). */
  let native: { pid: number; token: string } | undefined;

  const onSpawn = (pid: number) => {
    if (pid === process.pid) return;
    native = { pid, token: ownerToken(pid) };
    store.setLeaseNative(sessionId, token, native.pid, native.token);
  };
  const setConn = (c: Connection | undefined, tier?: string, version?: string) => {
    conn = c; connTier = tier; connVersion = version; liveConn = c;
  };
  /**
   * Close the connection and prove its provider group stopped, using the spawn-time identity.
   * On failure the identity stays recorded and the worker freezes: no new connection, no further jobs,
   * project lock kept, session marked broken (round 3, finding 1).
   */
  const closeConn = async (): Promise<boolean> => {
    const c = conn;
    setConn(undefined);
    if (!c && !native) return true;
    if (c) await Promise.race([c.close().catch(() => {}), sleep(cfg.cancelGraceMs)]);
    const stopped = native ? await stopAndConfirm(native.pid, native.token) : (c?.hasExited ?? true) || c?.pid === process.pid;
    if (stopped) {
      native = undefined;
      nativeUnconfirmed = false;
      store.setLeaseNative(sessionId, token, undefined, undefined);
    } else {
      nativeUnconfirmed = true;
      frozen = `provider process ${native?.pid ?? "?"} could not be confirmed stopped`;
      store.setSessionStateUnlessClosed(sessionId, "broken", `${FROZEN_PREFIX}${frozen}; stop that process, then submit again to recover`);
      console.error(`[turnweft-worker ${sessionId}] ${frozen}; identity kept, session frozen`);
    }
    return stopped;
  };
  const heldLocks = new Set<string>();

  try {
    for (;;) {
      session = store.getSession(sessionId)!;
      if (session.state === "closed") return "closed";
      if (frozen) return "frozen";
      store.expireStale(); // an expired waiting head must not block the turns behind it (round 5, 6)
      // FIFO: a turn waiting for confirmation holds back the turns behind it (U19).
      const head = store.jobsForSession(sessionId, ["queued", "waiting_confirmation"])[0];
      const next = head?.state === "queued" ? head : undefined;
      if (!next) {
        const l2 = adapter.capabilities.resumeAfterRestart === "supported";
        // U13: release only when restart+resume is verified; otherwise keep the live process.
        if (Date.now() - idleSince > cfg.idleReleaseMs && (l2 || !conn)) {
          if (!(await closeConn())) return "frozen";
          // Release and re-check the queue atomically, so a job submitted meanwhile is not stranded (finding 15).
          if (store.releaseLeaseIfIdle(sessionId, token, { keepNative: nativeUnconfirmed })) {
            const s = store.getSession(sessionId)!;
            if (s.nativeSessionId && s.state !== "broken") store.setSessionStateUnlessClosed(sessionId, "suspended");
            return "idle";
          }
          idleSince = Date.now();
          continue;
        }
        await sleep(300);
        continue;
      }

      // Re-read the user config for every attempt; a held lock keeps its original mode until release.
      const lockMode = next.intent === "implement" && loadConfig().parallelWrites?.includes(session.canonicalRoot) ? "shared" : "exclusive";
      if (next.intent === "implement" && !store.acquireProjectLock(session.canonicalRoot, next.id, process.pid, token, isOwnerGone, nativeStopped, lockMode)) {
        if (!lockNoted.has(next.id)) {
          store.appendEvent(next.id, "diagnostic", "turnweft", { message: "queued: another delegated write task holds this project's write lock" });
          lockNoted.add(next.id);
        }
        // The holder's worker may have died with its provider still running: wake that session's recovery.
        for (const holder of store.projectLockHolders(session.canonicalRoot)) {
          if (holder.sessionId && holder.sessionId !== sessionId && isOwnerGone(holder.ownerPid, holder.ownerToken)) ensureWorkerFor(store, holder.sessionId);
        }
        await sleep(500);
        continue;
      }

      if (next.intent === "implement") heldLocks.add(next.id);
      try {
        const ctx: JobCtx = {
          store, adapter, session, job: next, generation, cfg,
          getConn: () => conn, getTier: () => connTier, getVersion: () => connVersion, setConn, closeConn, onSpawn,
          getLastOpen: () => lastOpen, setLastOpen: (v) => { lastOpen = v; },
        };
        const r = await runJob(ctx);
        if (r === "connection_lost") await closeConn();
      } finally {
        // A frozen worker keeps the project lock: its provider may still be writing (round 3, finding 1).
        if (next.intent === "implement" && !frozen) { store.releaseProjectLock(session.canonicalRoot, next.id); heldLocks.delete(next.id); }
      }
      if (frozen) return "frozen";
      idleSince = Date.now();
    }
  } finally {
    clearInterval(hb);
    await closeConn();
    store.releaseLease(sessionId, token, { keepNative: nativeUnconfirmed });
  }
}

interface JobCtx {
  store: Store; adapter: Adapter; session: Session; job: Job; generation: number; cfg: Cfg;
  getConn(): Connection | undefined; getTier(): string | undefined; getVersion(): string | undefined;
  setConn(c: Connection | undefined, tier?: string, version?: string): void; closeConn(): Promise<boolean>;
  onSpawn(pid: number): void;
  getLastOpen(): { effective: Record<string, string>; model: JobResult["model"] };
  setLastOpen(v: { effective: Record<string, string>; model: JobResult["model"] }): void;
}

async function runJob(x: JobCtx): Promise<"done" | "connection_lost" | "frozen"> {
  const { store, adapter, job, generation, cfg } = x;
  // U23: the session's settings are read in the same transaction that claims the turn: an update that committed
  // before the claim applies to this turn, one committed after it only to later turns.
  const session = store.claimJob(job.id, x.session.id, { ownerGeneration: generation, startedAt: now() });
  if (!session) return "done";
  const finish = (state: JobState, extra: Partial<Job>, result?: JobResult, payload: Record<string, unknown> = {}) =>
    store.completeJob(job.id, generation, state, extra, result, { type: state === "succeeded" ? "turn.completed" : "turn.failed", payload: { state, errorCode: extra.errorCode, ...payload } });
  const cancelledBeforeDelivery = () => store.getJob(job.id)?.state === "cancel_requested";
  const ev = (type: Parameters<Store["appendEventFenced"]>[2], source: Parameters<Store["appendEventFenced"]>[3], payload: Record<string, unknown>) =>
    store.appendEventFenced(job.id, generation, type, source, payload);

  // A24 and finding 3: re-check the U11 policy against the tier and versions that will actually run. A U21 bypass
  // authorization stands on its own, but only for the exact capabilities it authorized (round 11, 4/5).
  const probe = await adapter.probe();
  const tier: TierSpec = adapter.tierFor(job.intent, probe);
  const bypassValid = Boolean(job.hostBypass) && job.hostBypassDigest === capabilityDigest(session.provider, probe, tier);
  if (job.policyId && store.getPolicy(job.policyId)?.revokedAt && !bypassValid) {
    finish("failed", { errorCode: "policy_revoked", failureReason: job.hostBypass
      ? "the U11 policy for this turn was revoked, and the bypass authorization no longer matches the permission tier or provider version"
      : "the U11 policy for this turn was revoked" });
    return "done";
  }
  const submittedPolicy = job.policyId ? store.getPolicy(job.policyId) : undefined;
  if (submittedPolicy?.expiresAt && Date.parse(submittedPolicy.expiresAt) <= Date.now() && !bypassValid) {
    finish("failed", { errorCode: "policy_expired", failureReason: "the U11 policy expired before this queued job started; obtain a new terminal grant and submit a new request" });
    return "done";
  }
  const m = matchPolicy(store, { provider: session.provider, canonicalRoot: session.canonicalRoot, intent: job.intent, probe, tier });
  const matchedPolicyId = m.ok ? m.policy?.id : undefined;
  if (!m.ok && !bypassValid) {
    finish("failed", { errorCode: "needs_confirmation", failureReason: job.hostBypass
      ? `permission tier or provider version changed since the bypass authorization (now ${tier.tier}, ${probe.cliVersion}); resubmit`
      : `tier or provider version changed since submission (now ${tier.tier}, ${probe.cliVersion}); resubmit to confirm again` });
    return "done";
  }
  const authorizedBy = !matchedPolicyId && tier.excess.length && bypassValid ? job.hostBypass : undefined;

  // Open or re-open: the tier is re-applied on every open/load (§7.4); a tier change means reopen.
  let effective: Record<string, string>;
  let model: JobResult["model"];
  let effort: JobResult["effort"];
  try {
    // Reopen when the tier changed or the installed CLI no longer matches the running process (round 2, 7).
    // U23: a launch-flag provider (agy) whose level differs from the request resumes the same conversation with
    // the new flag. ACP providers change it in the running session below, without a restart.
    const relaunchForEffort = !x.getConn()?.setEffort && session.requestedEffort !== undefined && x.getConn()?.currentEffort() !== session.requestedEffort;
    if (x.getConn() && (x.getTier() !== tier.tier || x.getVersion() !== probe.cliVersion || relaunchForEffort)) {
      // A connection that cannot be proven stopped must never be replaced by a second one (round 3, finding 1).
      if (!(await x.closeConn())) {
        finish("failed", { errorCode: "provider_not_stopped", failureReason: "the previous provider process could not be confirmed stopped; session frozen" });
        return "frozen";
      }
    }
    if (!x.getConn()) {
      const c = adapter.connect(session.cwd, { onSpawn: x.onSpawn }); // identity recorded at spawn (round 3, finding 4)
      x.setConn(c, tier.tier, probe.cliVersion); // own it immediately so a failed open still gets closed (finding 11)
      const opened = await withTimeout(c.open({ cwd: session.cwd, nativeSessionId: session.nativeSessionId, tier, model: session.requestedModel, effort: session.requestedEffort }), cfg.openTimeoutMs, "provider open");
      if (session.nativeSessionId && opened.nativeSessionId !== session.nativeSessionId) {
        throw new AdapterError("session_not_found", `provider returned ${opened.nativeSessionId} instead of ${session.nativeSessionId}`);
      }
      store.updateSession(session.id, { nativeSessionId: opened.nativeSessionId, cliVersion: probe.cliVersion, capabilities: adapter.capabilities });
      x.setLastOpen({ effective: opened.effective, model: opened.model });
    }
    // U23: the level was changed with session update, or drifted, since this connection was opened.
    const live = x.getConn()!;
    if (session.requestedEffort !== undefined && live.currentEffort() !== session.requestedEffort && live.setEffort) {
      try { await withTimeout(live.setEffort(session.requestedEffort), cfg.openTimeoutMs, "provider effort change"); } catch (e) {
        // Only a definite rejection keeps the connection: the level is known and nothing was sent. A timeout, a lost
        // transport or a missing read-back leaves the level unknown, so the generic path below closes the connection
        // and the next turn reopens and sets it again.
        if (e instanceof AdapterError && e.code === "invalid_effort" && !e.stateUnknown) {
          if (cancelledBeforeDelivery()) finish("cancelled", { failureReason: "cancelled before delivery" });
          else finish("failed", { errorCode: e.code, failureReason: e.message });
          return "done";
        }
        throw e;
      }
    }
    // Read the connection's live snapshot, not a cached one: config can change between turns (round 3, finding 6).
    model = x.getLastOpen().model;
    effort = { requested: session.requestedEffort, effective: x.getConn()!.currentEffort() };
    effective = { ...x.getLastOpen().effective, ...x.getConn()!.currentEffective() };
  } catch (e) {
    if (!(await x.closeConn())) {
      finish("failed", { errorCode: "provider_not_stopped", failureReason: `${(e as Error).message}; the provider could not be confirmed stopped; session frozen` });
      return "frozen";
    }
    const code = e instanceof AdapterError ? e.code : "provider_error";
    if (code === "session_not_found") {
      store.setSessionStateUnlessClosed(session.id, "broken", `native session cannot be resumed: ${(e as Error).message}`);
      finish("failed", { errorCode: "session_not_found", failureReason: "native session could not be resumed; Turnweft will not start a new one in its place" });
    } else if (cancelledBeforeDelivery()) {
      finish("cancelled", { failureReason: "cancelled before delivery" });
    } else {
      finish("failed", { errorCode: code, failureReason: providerError((e as Error).message, session.provider) });
    }
    return "done";
  }

  ev("config.readback", session.provider, { tier: tier.tier, effective, model, effort });
  if (!tier.satisfiedBy(effective)) {
    finish("failed", { errorCode: "capability_mismatch", failureReason: `read-back ${JSON.stringify(effective)} does not satisfy tier ${tier.tier}; not running in a different mode` });
    return "done";
  }

  // Take the "before" snapshot ahead of delivery, so nothing changed after delivery is counted as pre-existing.
  const before = snapshot(session.canonicalRoot);
  // Opening a provider may take time: a grant that expires during open must not deliver a prompt either.
  const deliveryPolicy = matchedPolicyId ? store.getPolicy(matchedPolicyId) : undefined;
  if (!bypassValid && deliveryPolicy?.expiresAt && Date.parse(deliveryPolicy.expiresAt) <= Date.now()) {
    finish("failed", { errorCode: "policy_expired", failureReason: "the U11 policy expired before prompt delivery" });
    return "done";
  }
  // Finding 4: a cancel that arrived during open must win; never deliver a cancelled job.
  if (!store.fencedTransition(job.id, generation, ["starting"], "running", { deliveredAt: now() })) {
    if (cancelledBeforeDelivery()) finish("cancelled", { failureReason: "cancelled before delivery" });
    return "done";
  }

  const conn = x.getConn()!;
  store.setSessionStateUnlessClosed(session.id, "busy");
  let text = "";
  let pending = "";
  let truncated = false;
  const toolCalls: JobResult["toolCalls"] = [];
  const answered: PermissionMapping["answeredRequests"] = [];
  let lastActivity = Date.now();
  let cancelSent = false;
  let timedOut = false;
  let graceTimer: NodeJS.Timeout | undefined;
  let closeStarted = false;

  const flushText = () => { if (pending) { ev("text.delta", session.provider, { text: pending }); pending = ""; } };
  // Text the agent writes before and after a tool call or permission request is separate prose: keep both,
  // with a blank line between them instead of gluing "I'll read the file." to the answer.
  let breakBeforeText = false;
  const onEvent = (e: AdapterEvent) => {
    lastActivity = Date.now();
    if (e.type === "text") {
      const sep = breakBeforeText && text ? (text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n") : "";
      breakBeforeText = false;
      const chunk = sep + e.text;
      if (text.length < MAX_TEXT) text += chunk; else truncated = true;
      pending += chunk;
      if (pending.length >= TEXT_EVENT_CHUNK) flushText();
    } else if (e.type === "tool") {
      breakBeforeText = true;
      flushText();
      if (e.status === undefined || e.status === "pending" || e.status === "ACTIVE") ev("tool.started", session.provider, { kind: e.kind, title: e.title });
      else ev("tool.completed", session.provider, { kind: e.kind, title: e.title, status: e.status });
      if (e.title || e.kind) toolCalls.push({ kind: e.kind, title: e.title, status: e.status });
    } else if (e.type === "permission") {
      breakBeforeText = true;
      flushText();
      answered.push({ kind: e.kind ?? "unknown", title: e.title, decision: e.decision });
      ev("permission.resolved", "turnweft", { kind: e.kind, title: e.title, decision: e.decision, by: "grant+policy" });
    } else if (e.type === "config") {
      // Live config changes are re-checked against the tier before the next turn (round 2, finding 7).
      x.setLastOpen({ ...x.getLastOpen(), effective: { ...x.getLastOpen().effective, ...e.effective } });
      ev("config.readback", session.provider, { effective: e.effective });
    }
  };

  ev("turn.started", "turnweft", { nativeSessionId: store.getSession(session.id)?.nativeSessionId });

  // Findings 8 and 9: one bounded escalation per turn, owned and cleared by this turn.
  const sendCancel = (why: string) => {
    if (cancelSent) return;
    cancelSent = true;
    ev("diagnostic", "turnweft", { message: `${why}; cancelling (closing the provider after ${cfg.cancelGraceMs} ms if it does not stop)` });
    void conn.cancel();
    graceTimer = setTimeout(() => { closeStarted = true; void conn.close(); }, cfg.cancelGraceMs);
  };
  const watchdog = setInterval(() => {
    if (store.getJob(job.id)?.state === "cancel_requested") sendCancel("cancel requested");
    else if (!cancelSent && Date.now() - lastActivity > cfg.inactivityTimeoutMs) { timedOut = true; sendCancel(`no provider activity for ${cfg.inactivityTimeoutMs} ms`); }
  }, 500);

  let outcome: Awaited<ReturnType<Connection["prompt"]>> | undefined;
  let error: unknown;
  try {
    outcome = await Promise.race([
      conn.prompt(store.getJobPrompt(job.id), onEvent),
      conn.exited.then((ex) => { throw new AdapterError("connection_lost", `provider exited during turn (code ${ex.code}, signal ${ex.signal})`); }),
    ]);
  } catch (e) {
    error = e;
  } finally {
    clearInterval(watchdog);
    if (graceTimer) clearTimeout(graceTimer);
    flushText();
  }

  // Finding 10: classify from structured facts, not message text.
  if (error && !(error instanceof AdapterError && error.code === "connection_lost")) {
    await sleep(300); // a dying provider often rejects the request just before its exit event
    if (conn.hasExited) error = new AdapterError("connection_lost", (error as Error).message);
  }
  const lost = error instanceof AdapterError && error.code === "connection_lost";
  const cancelRequested = store.getJob(job.id)?.state === "cancel_requested";
  const deniedActions = [
    ...answered.filter(r => r.decision === "deny").map(({ kind, title }) => ({ kind, title })),
    ...(outcome?.deniedActions ?? []),
  ];
  const actions = deniedActions.map(d => `${d.kind}:${d.title}`).join(", ");
  const warningCodes: NonNullable<JobResult["warningCodes"]> = [];
  let state: JobState;
  let errorCode: string | undefined;
  let failureReason: string | undefined;
  if (error) {
    if (timedOut) { state = "timed_out"; errorCode = "inactivity_timeout"; failureReason = "provider produced no activity within the inactivity timeout"; }
    else if (cancelRequested && lost) { state = "cancelled"; failureReason = "provider closed after cancel"; }
    else if (lost) { state = "in_doubt"; errorCode = "in_doubt"; failureReason = `${(error as Error).message}; the turn may have run. Not resent.`; }
    else { state = "failed"; errorCode = (error as AdapterError).code ?? "provider_error"; failureReason = providerError((error as Error).message, session.provider); }
  } else if (outcome!.stopReason === "cancelled") {
    state = timedOut ? "timed_out" : "cancelled";
    if (timedOut) errorCode = "inactivity_timeout";
  } else if (job.intent === "analyze" && (outcome!.stopReason === "end_turn" || outcome!.stopReason === "permission_blocked") && deniedActions.length) {
    // U26: callback and native denials describe limitations, not the value of the returned report.
    if (text.trim()) { state = "succeeded"; warningCodes.push("denied_actions"); }
    else {
      state = "failed"; errorCode = "permission_blocked";
      failureReason = messageText("analyzePermissionBlocked", { actions });
    }
  } else if (outcome!.stopReason === "permission_blocked") {
    state = "failed"; errorCode = "permission_blocked"; failureReason = `provider stopped at denied actions: ${actions}`;
  } else if (outcome!.stopReason === "end_turn") {
    // A turn that reached end_turn completed, even if a cancel or timeout was sent meanwhile.
    state = "succeeded";
    if (job.intent === "analyze" && !text.trim()) warningCodes.push("empty_output");
  } else {
    // max_tokens, max_turn_requests, refusal or an unknown reason: not a completed turn (round 2, finding 9).
    state = "failed";
    errorCode = outcome!.stopReason === "refusal" ? "refusal" : `incomplete_${outcome!.stopReason}`;
    failureReason = `provider stopped with ${outcome!.stopReason}`;
  }

  const files = diffSnapshots(before, snapshot(session.canonicalRoot), relative(session.canonicalRoot, session.cwd));
  const sessionNow = store.getSession(session.id)!;
  const result: JobResult = {
    sessionId: session.id, jobId: job.id, provider: session.provider, cliVersion: probe.cliVersion,
    adapterVersion: adapter.adapterVersion, cwd: session.cwd, nativeSessionId: sessionNow.nativeSessionId,
    state, stopReason: outcome?.stopReason, finalText: text, resultComplete: !error || state === "cancelled", truncated,
    ...(deniedActions.length ? { deniedActions } : {}),
    ...(warningCodes.length ? { warningCodes } : {}),
    permission: { effectiveMode: JSON.stringify(effective), policyId: matchedPolicyId ?? (authorizedBy ? undefined : job.policyId), ...(authorizedBy ? { authorizedBy } : {}), excessOverGrant: tier.excess.map(message => renderMessage(message)), answeredRequests: answered },
    model, effort, files, toolCalls: toolCalls.slice(-200),
  };
  finish(state, { errorCode, failureReason, policyId: matchedPolicyId ?? (authorizedBy ? undefined : job.policyId) }, result, { stopReason: outcome?.stopReason });
  store.setSessionStateUnlessClosed(session.id, lost && !sessionNow.nativeSessionId ? "broken" : "ready");
  // A connection whose close already started is never reused (round 2, finding 4).
  return lost || conn.hasExited || closeStarted ? "connection_lost" : "done";
}
