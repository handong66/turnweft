// TurnweftService implementation over the shared store. Front ends (MCP, CLI) are thin: they record
// requests here and wake a session worker; they never own provider processes (§6.2).
import { renderMessage } from "../core/i18n.js";
import type { ConfirmPolicyInput, CreateSessionInput, GetJobInput, JobView, SubmitTurnInput, SubmitTurnOutcome, TurnweftService } from "../core/service.js";
import { PROVIDERS, TERMINAL_JOB_STATES, type HostBinding, type Job, type PolicyProposal, type ProbeResult, type ProviderId, type Session, type UserPolicy } from "../core/types.js";
import { getAdapter } from "../adapters/registry.js";
import { loadConfig } from "./config.js";
import { newJobId, newSessionId, now, sha256 } from "./ids.js";
import { buildProposal, capabilityDigest, confirm, matchPolicy, reject } from "./policy.js";
import { ensureWorkerFor } from "./spawn.js";
import { isOwnerGone, nativeStopped, ownerToken as procOwnerToken, stopAndConfirm } from "./proc.js";
import { FROZEN_PREFIX } from "./worker.js";
import { canonicalRoot, PathError, workingDir } from "./project.js";
import { Store } from "./store.js";

export class ServiceError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const sameHost = (a: HostBinding, b: HostBinding) =>
  a.hostKind === b.hostKind && ((a.conversationId && a.conversationId === b.conversationId) || (a.connectionId && a.connectionId === b.connectionId));

const PROBE_TTL_MS = 60_000;

export class LocalService implements TurnweftService {
  private probeCache = new Map<ProviderId, { at: number; probe: ProbeResult }>();

  constructor(readonly store = new Store(), private opts: { spawnWorker?: (sessionId: string) => void } = {}) {}

  private async probe(provider: ProviderId, refresh = false): Promise<ProbeResult> {
    const c = this.probeCache.get(provider);
    if (!refresh && c && Date.now() - c.at < PROBE_TTL_MS) return c.probe;
    const probe = await getAdapter(provider).probe();
    this.probeCache.set(provider, { at: Date.now(), probe });
    return probe;
  }

  async listAgents(opts?: { refresh?: boolean }): Promise<ProbeResult[]> {
    return Promise.all(PROVIDERS.map((p) => this.probe(p, opts?.refresh)));
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    if (!PROVIDERS.includes(input.provider)) throw new ServiceError("unknown_provider", `unknown provider ${input.provider}`);
    let root: string;
    let cwd: string;
    try { cwd = workingDir(input.cwd); root = canonicalRoot(cwd); } catch (e) {
      throw new ServiceError(e instanceof PathError ? e.code : "invalid_cwd", (e as Error).message);
    }
    const probe = await this.probe(input.provider);
    if (!probe.available) throw new ServiceError("provider_unavailable", probe.problems.join("; ") || `${input.provider} unavailable`);
    const t = now();
    const s: Session = {
      id: newSessionId(), provider: input.provider, name: input.name, cwd, canonicalRoot: root, state: "ready",
      hostBindings: [input.host], capabilities: probe.capabilities, cliVersion: probe.cliVersion,
      requestedModel: input.model, createdAt: t, updatedAt: t,
    };
    this.store.insertSession(s);
    return s;
  }

  async listSessions(f: { canonicalRoot?: string; provider?: ProviderId; host?: HostBinding; includeClosed?: boolean }): Promise<Session[]> {
    let root = f.canonicalRoot;
    if (root) { try { root = canonicalRoot(root); } catch { /* keep as given */ } }
    const all = this.store.listSessions({ canonicalRoot: root, provider: f.provider, includeClosed: f.includeClosed });
    return f.host ? all.filter((s) => s.hostBindings.some((b) => sameHost(b, f.host!))) : all;
  }

  async getSession(id: string) { return this.store.getSession(id); }

  async attachSession(id: string, host: HostBinding): Promise<Session> {
    const s = this.mustSession(id);
    if (s.state === "closed") throw new ServiceError("session_closed", "session is closed");
    if (!s.hostBindings.some((b) => sameHost(b, host))) this.store.updateSession(id, { hostBindings: [...s.hostBindings, host] });
    return this.store.getSession(id)!;
  }

  async closeSession(id: string, policy: "reject_if_busy" | "cancel_running" = "reject_if_busy"): Promise<Session> {
    const s = this.mustSession(id);
    // Close the submit path first (inside the write lock), then cancel whatever is unfinished, so a submit
    // racing with close cannot leave a queued job behind (round 2, finding 5). insertJobChecked rejects closed.
    const active = this.store.tx(() => {
      const unfinished = this.store.jobsForSession(id).filter((j) => !TERMINAL_JOB_STATES.includes(j.state));
      if (unfinished.length && policy === "reject_if_busy") return undefined;
      this.store.updateSession(id, { state: "closed" });
      return unfinished;
    });
    if (!active) throw new ServiceError("session_busy", "session has unfinished job(s); pass cancel_running to cancel them");
    for (const j of this.store.jobsForSession(id).filter((x) => !TERMINAL_JOB_STATES.includes(x.state))) await this.cancelJob(j.id);
    // "closed" means no new turns; a running turn is confirmed stopped only when its job reaches a terminal state.
    return this.store.getSession(id)!;
  }

  async submitTurn(input: SubmitTurnInput): Promise<SubmitTurnOutcome> {
    const digest = sha256(input.prompt);
    const existing = this.store.getJobByRequest(input.requestId);
    if (existing) {
      if (existing.sessionId === input.sessionId && existing.intent === input.intent && existing.promptDigest === digest) return this.outcomeFor(existing);
      return { kind: "rejected", code: "request_conflict", message: "requestId was already used with different content" };
    }
    const s = this.store.getSession(input.sessionId);
    if (!s) return { kind: "rejected", code: "session_not_found", message: `no session ${input.sessionId}` };
    if (s.state === "closed") return { kind: "rejected", code: "session_closed", message: "session is closed" };
    if (s.state === "broken") {
      // Round 4 finding 1: a session frozen only because its provider could not be confirmed stopped recovers
      // once that process is proven gone. Other broken reasons (e.g. session_not_found) never auto-recover.
      if (!s.brokenReason?.startsWith(FROZEN_PREFIX)) return { kind: "rejected", code: "session_broken", message: s.brokenReason ?? "session is broken" };
      const lease = this.store.getLease(s.id);
      const ownerAlive = Boolean(lease?.ownerToken) && !isOwnerGone(lease!.ownerPid, lease!.ownerToken);
      const nativeGone = !lease?.nativePid || !lease.nativeToken || nativeStopped(lease.nativePid, lease.nativeToken);
      if (ownerAlive || !nativeGone) {
        return { kind: "rejected", code: "session_frozen", message: `${s.brokenReason.slice(FROZEN_PREFIX.length)} (pid ${lease?.nativePid ?? "?"} still running)` };
      }
      this.store.setSessionStateUnlessClosed(s.id, s.nativeSessionId ? "suspended" : "ready", "recovered: previous provider confirmed stopped");
    }
    if (!input.prompt.trim()) return { kind: "rejected", code: "empty_prompt", message: "prompt is empty" };
    // Submitting through a different host requires an explicit attach first (§8.2).
    if (!s.hostBindings.some((b) => sameHost(b, input.host))) return { kind: "rejected", code: "not_attached", message: "this host is not bound to the session; call attach first" };

    const adapter = getAdapter(s.provider);
    const probe = await this.probe(s.provider);
    if (!probe.available) return { kind: "rejected", code: "provider_unavailable", message: probe.problems.join("; ") };
    const tier = adapter.tierFor(input.intent, probe);
    const key = { provider: s.provider, canonicalRoot: s.canonicalRoot, intent: input.intent, probe, tier };

    // One write lock for: expiry, session re-check, policy re-check, pending-proposal lookup/creation and the
    // insert, so a confirmation or rejection can never slip between them (round 5, 3/4/5).
    type Done = SubmitTurnOutcome | { kind: "dup" };
    const done: Done = this.store.tx((): Done => {
      this.store.expireStaleTx();
      const m = matchPolicy(this.store, key);
      // U21: the host's bypass mode authorizes this one job; nothing is stored, so non-bypass conversations still ask.
      // It is kept even when a policy matches, so revoking that policy later does not undo it (round 11, 4), and it is
      // bound to the capability digest it authorized (round 11, 5).
      const bypass = tier.excess.length && input.hostBypass ? input.hostBypass : undefined;
      const proposal = m.ok || bypass ? undefined : this.store.pendingProposalTx(
        { provider: s.provider, canonicalRoot: s.canonicalRoot, intent: input.intent, tier: tier.tier, capabilityDigest: capabilityDigest(s.provider, probe, tier) },
        () => buildProposal(key), { requestId: input.requestId, sessionId: s.id });
      const job: Job = {
        id: newJobId(), sessionId: s.id, requestId: input.requestId, intent: input.intent, promptDigest: digest,
        state: proposal ? "waiting_confirmation" : "queued", policyId: m.ok ? m.policy?.id : undefined,
        proposalId: proposal?.proposalId, ...(bypass ? { hostBypass: bypass, hostBypassDigest: capabilityDigest(s.provider, probe, tier) } : {}), acceptedAt: now(),
      };
      const inserted = this.store.insertJobCheckedTx({ ...job, prompt: input.prompt });
      if (inserted === "session_closed") return { kind: "rejected", code: "session_closed", message: "session was closed" };
      if (inserted === "session_broken") return { kind: "rejected", code: "session_broken", message: "session is broken" };
      if (inserted === "duplicate") return { kind: "dup" };
      this.store.appendEventTx(job.id, "turn.accepted", { intent: input.intent, tier: tier.tier, policyId: job.policyId ?? null, waitingFor: proposal?.proposalId ?? null, ...(bypass ? { authorizedBy: bypass, excessOverGrant: tier.excess.map((x) => renderMessage(x)) } : {}) });
      return proposal ? { kind: "awaiting_confirmation", job, proposal } : { kind: "accepted", job };
    });
    if (done.kind === "dup") {
      // Concurrent submit with the same requestId: only an identical request gets the winner (finding 12).
      const dup = this.store.getJobByRequest(input.requestId);
      if (dup && dup.sessionId === input.sessionId && dup.intent === input.intent && dup.promptDigest === digest) return this.outcomeFor(dup);
      return { kind: "rejected", code: "request_conflict", message: "requestId was already used with different content" };
    }
    if (done.kind === "accepted") this.ensureWorker(s.id);
    return done;
  }

  /** Outcome for an already-recorded job (idempotent resubmit). */
  private outcomeFor(job: Job): SubmitTurnOutcome {
    this.store.expireStale();
    const cur = this.store.getJob(job.id) ?? job;
    if (cur.state === "waiting_confirmation" && cur.proposalId) {
      const p = this.store.getProposal(cur.proposalId);
      if (p) { const { consumedAt: _c, ...proposal } = p; return { kind: "awaiting_confirmation", job: cur, proposal }; }
    }
    return { kind: "accepted", job: cur };
  }

  async getJob(input: GetJobInput): Promise<JobView> {
    const max = loadConfig().maxWaitMs;
    const deadline = Date.now() + Math.min(Math.max(input.waitMs ?? 0, 0), max);
    const afterSeq = input.afterSeq ?? 0;
    for (const sid of this.store.expireStale()) this.ensureWorker(sid); // an expired head must not block FIFO (round 5, 6)
    let job = this.mustJob(input.jobId);
    for (;;) {
      const terminal = TERMINAL_JOB_STATES.includes(job.state);
      const events = this.store.events(job.id, afterSeq);
      if (terminal || events.length || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 250));
      job = this.mustJob(input.jobId);
    }
    // Any unfinished job whose worker died must be woken: a new owner recovers it or marks it in_doubt (finding 7).
    if (!TERMINAL_JOB_STATES.includes(job.state) && job.state !== "waiting_confirmation") this.ensureWorker(job.sessionId);
    const s = this.store.getSession(job.sessionId)!;
    const events = this.store.events(job.id, afterSeq);
    const terminal = TERMINAL_JOB_STATES.includes(job.state);
    const view: JobView = {
      job, session: { id: s.id, provider: s.provider, state: s.state, cwd: s.cwd, canonicalRoot: s.canonicalRoot },
      terminal, events, nextSeq: events.length ? events[events.length - 1]!.seq : afterSeq,
      nextAction: job.state === "in_doubt" ? "reconcile_in_doubt" : job.state === "waiting_confirmation" ? "confirm_policy" : terminal ? "read_result" : "wait",
    };
    if (terminal && input.includeResult) {
      const r = this.store.getJobResult(job.id);
      if (r) {
        const off = input.resultOffset ?? 0;
        const lim = input.resultLimit ?? 20_000;
        const slice = r.finalText.slice(off, off + lim);
        view.result = { ...r, finalText: slice };
        if (off + lim < r.finalText.length) view.resultNextOffset = off + lim;
      }
    }
    return view;
  }

  async cancelJob(jobId: string): Promise<Job> {
    const job = this.mustJob(jobId);
    if (TERMINAL_JOB_STATES.includes(job.state) || job.state === "cancel_requested") return job;
    if ((job.state === "queued" || job.state === "waiting_confirmation") && this.store.casJobState(jobId, ["queued", "waiting_confirmation"], "cancelled", { finishedAt: now(), failureReason: "cancelled before start" })) {
      this.store.appendEvent(jobId, "turn.failed", "turnweft", { state: "cancelled", before: "start" });
      return this.mustJob(jobId);
    }
    this.store.casJobState(jobId, ["starting", "running", "waiting_permission"], "cancel_requested");
    return this.mustJob(jobId);
  }

  async confirmPolicy(input: ConfirmPolicyInput): Promise<UserPolicy> {
    let r: ReturnType<typeof confirm>;
    try { r = confirm(this.store, input.proposalId, input.nonce, input.via); }
    catch (e) { throw new ServiceError((e as { code?: string }).code ?? "policy_error", (e as Error).message); }
    // Wake workers only after the decision and the releases are committed together.
    for (const sid of new Set(r.released.map((j) => j.sessionId))) this.ensureWorker(sid);
    return r.policy!;
  }

  async rejectPolicy(input: ConfirmPolicyInput): Promise<void> {
    let r: ReturnType<typeof reject>;
    try { r = reject(this.store, input.proposalId, input.nonce, input.via); }
    catch (e) { throw new ServiceError((e as { code?: string }).code ?? "policy_error", (e as Error).message); }
    // A session whose head was cancelled may have queued turns behind it.
    for (const sid of new Set(r.cancelled.map((j) => j.sessionId))) this.ensureWorker(sid);
  }

  async listPolicies(f?: { canonicalRoot?: string; provider?: ProviderId }) { return this.store.listPolicies(f); }

  async revokePolicy(id: string): Promise<UserPolicy> {
    if (!this.store.getPolicy(id)) throw new ServiceError("policy_not_found", `no policy ${id}`);
    this.store.revokePolicy(id);
    return this.store.getPolicy(id)!;
  }

  async claimConfirmationDialog(proposalId: string, ownerToken: string): Promise<boolean> {
    const pid = (t: string) => Number(t.split(":")[0]);
    // Any dialog for this key counts, including one recorded on a merged or expired proposal (round 7, 3).
    for (const o of this.store.dialogOwnersForKey(proposalId)) {
      if (o.helper && !isOwnerGone(pid(o.helper), o.helper)) return false; // it is showing, or closing by itself
      // The helper runs as its own process-group leader and its dialog is in that group: confirm the whole
      // group is gone even when no child was recorded (its registration can fail) (round 8).
      if (o.helper && !(await stopAndConfirm(pid(o.helper), o.helper))) return false;
      // A killed helper can leave its dialog on screen: close it first, or do not show a second one (round 6, 3).
      if (o.child && !(await stopAndConfirm(pid(o.child), o.child))) return false;
      if (o.id !== proposalId) this.store.clearDialogIf(o.id, o.helper, o.child);
    }
    return this.store.claimDialog(proposalId, ownerToken, isOwnerGone);
  }

  async recordConfirmationDialogChild(proposalId: string, ownerToken: string, childPid: number): Promise<void> {
    this.store.setDialogChild(proposalId, ownerToken, procOwnerToken(childPid));
  }

  async releaseConfirmationDialog(proposalId: string, ownerToken: string): Promise<void> {
    this.store.releaseDialog(proposalId, ownerToken);
  }

  async getProposal(id: string): Promise<PolicyProposal | undefined> {
    this.store.expireStale();
    const p = this.store.getProposal(id);
    if (!p) return undefined;
    const { consumedAt: _c, ...rest } = p;
    return { ...rest, waitingJobs: this.store.waitingJobCount(id) };
  }

  // ------------------------------------------------------------ internals
  private mustSession(id: string): Session {
    const s = this.store.getSession(id);
    if (!s) throw new ServiceError("session_not_found", `no session ${id}`);
    return s;
  }

  private mustJob(id: string): Job {
    const j = this.store.getJob(id);
    if (!j) throw new ServiceError("job_not_found", `no job ${id}`);
    return j;
  }

  ensureWorker(sessionId: string) {
    ensureWorkerFor(this.store, sessionId, this.opts.spawnWorker);
  }
}
