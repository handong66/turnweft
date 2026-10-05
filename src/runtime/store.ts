// Shared state (§9.1): one SQLite file per user, opened by every MCP front end, CLI and worker.
// Atomic claims use BEGIN IMMEDIATE; WAL lets readers proceed while a worker writes.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type {
  HostBinding, Intent, Job, JobResult, JobState, PolicyProposal, ProviderId, Session,
  SessionState, TurnEvent, UserPolicy, EventType, AgentCapabilities,
} from "../core/types.js";
import { dbPath } from "./paths.js";
import { now } from "./ids.js";

const SCHEMA_VERSION = 1;
const TERMINAL = new Set<JobState>(["succeeded", "failed", "cancelled", "timed_out", "in_doubt"]);

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT, canonical_root TEXT NOT NULL, cwd TEXT,
  native_session_id TEXT, state TEXT NOT NULL, broken_reason TEXT, host_bindings TEXT NOT NULL,
  capabilities TEXT, cli_version TEXT, requested_model TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, intent TEXT NOT NULL,
  prompt TEXT NOT NULL, prompt_digest TEXT NOT NULL, state TEXT NOT NULL, failure_reason TEXT, error_code TEXT,
  grant_revision INTEGER, policy_id TEXT, proposal_id TEXT, owner_generation INTEGER, accepted_at TEXT NOT NULL,
  delivered_at TEXT, started_at TEXT, finished_at TEXT, result TEXT, next_seq INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS jobs_session ON jobs(session_id, accepted_at);
CREATE TABLE IF NOT EXISTS events (
  job_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, source TEXT NOT NULL,
  payload TEXT NOT NULL, truncated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (job_id, seq));
CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, canonical_root TEXT NOT NULL, intent TEXT NOT NULL, tier TEXT NOT NULL,
  excess TEXT NOT NULL, cli_version TEXT NOT NULL, adapter_version TEXT NOT NULL, capability_digest TEXT NOT NULL,
  confirmed_via TEXT NOT NULL, confirmed_at TEXT NOT NULL, revision INTEGER NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY, nonce TEXT NOT NULL, data TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT,
  request_id TEXT, session_id TEXT);
CREATE TABLE IF NOT EXISTS leases (
  session_id TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, owner_token TEXT NOT NULL,
  generation INTEGER NOT NULL, heartbeat_at TEXT NOT NULL, native_pid INTEGER, native_token TEXT);
CREATE TABLE IF NOT EXISTS project_locks (
  canonical_root TEXT PRIMARY KEY, job_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_token TEXT NOT NULL,
  acquired_at TEXT NOT NULL);
`;

type Row = Record<string, unknown>;
export interface Lease { ownerPid: number; ownerToken: string; generation: number; heartbeatAt: string; nativePid?: number; nativeToken?: string }
const j = <T>(v: unknown): T => (v == null ? undefined : JSON.parse(String(v))) as T;
const s = (v: unknown): string | undefined => (v == null ? undefined : String(v));
const n = (v: unknown): number | undefined => (v == null ? undefined : Number(v));

function rowToSession(r: Row): Session {
  return {
    id: String(r.id), provider: r.provider as ProviderId, name: s(r.name), canonicalRoot: String(r.canonical_root),
    cwd: String(r.cwd ?? r.canonical_root),
    nativeSessionId: s(r.native_session_id), state: r.state as SessionState, brokenReason: s(r.broken_reason),
    hostBindings: j<HostBinding[]>(r.host_bindings) ?? [], capabilities: j<AgentCapabilities>(r.capabilities),
    cliVersion: s(r.cli_version), requestedModel: s(r.requested_model),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

function rowToJob(r: Row): Job {
  return {
    id: String(r.id), sessionId: String(r.session_id), requestId: String(r.request_id), intent: r.intent as Intent,
    promptDigest: String(r.prompt_digest), state: r.state as JobState, failureReason: s(r.failure_reason),
    errorCode: s(r.error_code), grantRevision: n(r.grant_revision), policyId: s(r.policy_id), proposalId: s(r.proposal_id), hostBypass: s(r.host_bypass), hostBypassDigest: s(r.host_bypass_digest),
    ownerGeneration: n(r.owner_generation), acceptedAt: String(r.accepted_at), deliveredAt: s(r.delivered_at),
    startedAt: s(r.started_at), finishedAt: s(r.finished_at),
  };
}

function rowToPolicy(r: Row): UserPolicy {
  return {
    id: String(r.id), provider: r.provider as ProviderId, canonicalRoot: String(r.canonical_root),
    intent: r.intent as Intent, tier: String(r.tier), excessOverGrant: j<string[]>(r.excess) ?? [],
    cliVersion: String(r.cli_version), adapterVersion: String(r.adapter_version),
    capabilityDigest: String(r.capability_digest), confirmedVia: r.confirmed_via as UserPolicy["confirmedVia"],
    confirmedAt: String(r.confirmed_at), revision: Number(r.revision), revokedAt: s(r.revoked_at),
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path = dbPath()) {
    const fresh = !existsSync(path);
    this.db = new DatabaseSync(path);
    if (fresh) { try { chmodSync(path, 0o600); } catch { /* best effort */ } }
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;");
    // Schema creation, migration and version check run under one write lock, so CC and Codex front ends
    // opening an old file at the same time cannot both ALTER (review round 2, finding 10).
    this.tx(() => {
      this.db.exec(DDL);
      this.migrate();
      const v = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined;
      if (!v) this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
      else if (Number(v.value) > SCHEMA_VERSION) throw new Error(`state schema ${v.value} is newer than this Turnweft (${SCHEMA_VERSION})`);
    });
  }

  close() { this.db.close(); }

  /**
   * Rows created before the pkey column have none (round 6, 2). Fill it from the stored proposal, then merge
   * duplicate live proposals for one key into the one that expires first (never extending an old job's
   * deadline), re-pointing waiting jobs to it. Runs inside the constructor's write lock, before the index.
   */
  private backfillProposalKeys() {
    // Rows from before the key column, or with the earlier NUL-joined key format.
    const missing = this.db.prepare("SELECT id, data FROM proposals WHERE pkey IS NULL OR instr(pkey, char(0)) > 0").all() as Row[];
    if (missing.length) this.db.exec("DROP INDEX IF EXISTS proposals_pending_key"); // recreated by migrate()
    for (const r of missing) {
      const p = j<PolicyProposal>(r.data);
      this.db.prepare("UPDATE proposals SET pkey = ? WHERE id = ?").run(Store.proposalKey(p), String(r.id));
    }
    // Settle overdue proposals first: a live job must never be merged into an expired proposal (round 7, 1).
    this.expireStaleTx();
    const dupKeys = this.db.prepare("SELECT pkey FROM proposals WHERE consumed_at IS NULL AND pkey IS NOT NULL GROUP BY pkey HAVING COUNT(*) > 1").all() as Row[];
    for (const k of dupKeys) {
      const live = this.db.prepare("SELECT id FROM proposals WHERE consumed_at IS NULL AND pkey = ? ORDER BY expires_at ASC").all(String(k.pkey)) as Row[];
      const keep = String(live[0]!.id);
      for (const other of live.slice(1)) {
        const id = String(other.id);
        this.db.prepare("UPDATE jobs SET proposal_id = ? WHERE proposal_id = ? AND state = 'waiting_confirmation'").run(keep, id);
        this.db.prepare("UPDATE proposals SET consumed_at = ?, decision = 'merged', decided_at = ? WHERE id = ?").run(now(), now(), id);
      }
    }
  }

  /** Additive column migrations for state files created by earlier alpha builds. */
  private migrate() {
    const cols = (t: string) => new Set((this.db.prepare(`PRAGMA table_info(${t})`).all() as Row[]).map((r) => String(r.name)));
    const lease = cols("leases");
    if (!lease.has("native_pid")) this.db.exec("ALTER TABLE leases ADD COLUMN native_pid INTEGER");
    if (!lease.has("native_token")) this.db.exec("ALTER TABLE leases ADD COLUMN native_token TEXT");
    if (!cols("sessions").has("cwd")) this.db.exec("ALTER TABLE sessions ADD COLUMN cwd TEXT");
    if (!cols("jobs").has("proposal_id")) this.db.exec("ALTER TABLE jobs ADD COLUMN proposal_id TEXT");
    for (const c of ["host_bypass", "host_bypass_digest"]) if (!cols("jobs").has(c)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${c} TEXT`);
    const pc = cols("proposals");
    for (const c of ["pkey", "decision", "decided_at", "dialog_token", "dialog_child"]) if (!pc.has(c)) this.db.exec(`ALTER TABLE proposals ADD COLUMN ${c} TEXT`);
    this.backfillProposalKeys();
    // At most one live pending proposal per key (round 5, 4).
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS proposals_pending_key ON proposals(pkey) WHERE consumed_at IS NULL AND pkey IS NOT NULL");
    const prop = cols("proposals");
    if (!prop.has("request_id")) this.db.exec("ALTER TABLE proposals ADD COLUMN request_id TEXT");
    if (!prop.has("session_id")) this.db.exec("ALTER TABLE proposals ADD COLUMN session_id TEXT");
  }

  /** Run fn inside BEGIN IMMEDIATE so concurrent processes serialize on the write lock. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); this.db.exec("COMMIT"); return r; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  // ------------------------------------------------------------ sessions
  insertSession(x: Session) {
    this.db.prepare(`INSERT INTO sessions (id, provider, name, canonical_root, cwd, native_session_id, state, broken_reason,
      host_bindings, capabilities, cli_version, requested_model, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(x.id, x.provider, x.name ?? null, x.canonicalRoot, x.cwd, x.nativeSessionId ?? null, x.state, x.brokenReason ?? null,
        JSON.stringify(x.hostBindings), x.capabilities ? JSON.stringify(x.capabilities) : null, x.cliVersion ?? null,
        x.requestedModel ?? null, x.createdAt, x.updatedAt);
  }

  getSession(id: string): Session | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToSession(r) : undefined;
  }

  listSessions(f: { canonicalRoot?: string; provider?: ProviderId; includeClosed?: boolean }): Session[] {
    const where: string[] = []; const args: string[] = [];
    if (f.canonicalRoot) { where.push("canonical_root = ?"); args.push(f.canonicalRoot); }
    if (f.provider) { where.push("provider = ?"); args.push(f.provider); }
    if (!f.includeClosed) where.push("state != 'closed'");
    const sql = `SELECT * FROM sessions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC`;
    return (this.db.prepare(sql).all(...args) as Row[]).map(rowToSession);
  }

  updateSession(id: string, patch: Partial<Pick<Session, "nativeSessionId" | "state" | "brokenReason" | "hostBindings" | "capabilities" | "cliVersion">>) {
    const cols: string[] = []; const args: (string | null)[] = [];
    const set = (c: string, v: string | null) => { cols.push(`${c} = ?`); args.push(v); };
    if ("nativeSessionId" in patch) set("native_session_id", patch.nativeSessionId ?? null);
    if ("state" in patch) set("state", patch.state ?? null);
    if ("brokenReason" in patch) set("broken_reason", patch.brokenReason ?? null);
    if ("hostBindings" in patch) set("host_bindings", JSON.stringify(patch.hostBindings ?? []));
    if ("capabilities" in patch) set("capabilities", patch.capabilities ? JSON.stringify(patch.capabilities) : null);
    if ("cliVersion" in patch) set("cli_version", patch.cliVersion ?? null);
    set("updated_at", now());
    this.db.prepare(`UPDATE sessions SET ${cols.join(", ")} WHERE id = ?`).run(...args, id);
  }

  /** Worker-side session state change; "closed" is terminal and never overwritten (round 3, finding 5). */
  setSessionStateUnlessClosed(id: string, state: SessionState, brokenReason?: string): boolean {
    const res = this.db.prepare("UPDATE sessions SET state = ?, broken_reason = COALESCE(?, broken_reason), updated_at = ? WHERE id = ? AND state != 'closed'")
      .run(state, brokenReason ?? null, now(), id);
    return Number(res.changes) === 1;
  }

  /**
   * Recover jobs left by earlier generations, deciding from the current row inside the write lock so a
   * concurrent cancel is never overwritten (round 3, finding 7).
   */
  recoverOrphans(sessionId: string, generation: number): void {
    const ids = (this.db.prepare(`SELECT id FROM jobs WHERE session_id = ? AND state IN ('starting','running','waiting_permission','cancel_requested')`)
      .all(sessionId) as Row[]).map((r) => String(r.id));
    for (const id of ids) {
      this.tx(() => {
        const cur = this.getJob(id);
        if (!cur || TERMINAL.has(cur.state) || cur.state === "queued" || cur.ownerGeneration === generation) return;
        const event = (state: JobState, payload: Record<string, unknown>) => {
          const r = this.db.prepare("SELECT next_seq FROM jobs WHERE id = ?").get(id) as Row;
          const seq = Number(r.next_seq);
          this.db.prepare("INSERT INTO events (job_id, seq, type, at, source, payload, truncated) VALUES (?,?,?,?,?,?,0)")
            .run(id, seq, "turn.failed", now(), "turnweft", JSON.stringify({ state, ...payload }));
          this.db.prepare("UPDATE jobs SET next_seq = ? WHERE id = ?").run(seq + 1, id);
        };
        if (cur.deliveredAt) {
          this.updateJob(id, { state: "in_doubt", errorCode: "in_doubt", failureReason: "previous owner stopped mid-turn; the prompt may have run. Not resent.", finishedAt: now() });
          event("in_doubt", { reason: "owner lost after delivery" });
        } else if (cur.state === "cancel_requested") {
          this.updateJob(id, { state: "cancelled", failureReason: "cancelled before delivery", finishedAt: now() });
          event("cancelled", { before: "delivery" });
        } else {
          this.updateJob(id, { state: "queued" });
        }
      });
    }
  }

  // ------------------------------------------------------------ jobs
  insertJob(x: Job & { prompt: string }) {
    this.db.prepare(`INSERT INTO jobs (id, session_id, request_id, intent, prompt, prompt_digest, state, grant_revision,
      policy_id, proposal_id, host_bypass, host_bypass_digest, accepted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(x.id, x.sessionId, x.requestId, x.intent, x.prompt, x.promptDigest, x.state, x.grantRevision ?? null,
        x.policyId ?? null, x.proposalId ?? null, x.hostBypass ?? null, x.hostBypassDigest ?? null, x.acceptedAt);
  }

  /** Insert only if the session is still open, inside the write lock (submit vs close race). */
  insertJobChecked(x: Job & { prompt: string }): "ok" | "session_closed" | "session_broken" | "duplicate" {
    return this.tx(() => this.insertJobCheckedTx(x));
  }

  /** Same check without opening a transaction (caller holds the write lock). */
  insertJobCheckedTx(x: Job & { prompt: string }): "ok" | "session_closed" | "session_broken" | "duplicate" {
    const sess = this.getSession(x.sessionId);
    if (!sess || sess.state === "closed") return "session_closed";
    if (sess.state === "broken") return "session_broken";
    if (this.getJobByRequest(x.requestId)) return "duplicate";
    this.insertJob(x);
    return "ok";
  }

  getJob(id: string): Job | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToJob(r) : undefined;
  }

  getJobByRequest(requestId: string): Job | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE request_id = ?").get(requestId) as Row | undefined;
    return r ? rowToJob(r) : undefined;
  }

  getJobPrompt(id: string): string {
    return String((this.db.prepare("SELECT prompt FROM jobs WHERE id = ?").get(id) as Row).prompt);
  }

  jobsForSession(sessionId: string, states?: JobState[]): Job[] {
    const rows = this.db.prepare("SELECT * FROM jobs WHERE session_id = ? ORDER BY accepted_at, rowid").all(sessionId) as Row[];
    const jobs = rows.map(rowToJob);
    return states ? jobs.filter((x) => states.includes(x.state)) : jobs;
  }

  updateJob(id: string, patch: Partial<Omit<Job, "id" | "sessionId" | "requestId" | "intent" | "promptDigest" | "acceptedAt">>) {
    const map: Record<string, string> = {
      state: "state", failureReason: "failure_reason", errorCode: "error_code", grantRevision: "grant_revision",
      policyId: "policy_id", proposalId: "proposal_id", ownerGeneration: "owner_generation", deliveredAt: "delivered_at",
      startedAt: "started_at", finishedAt: "finished_at",
    };
    const cols: string[] = []; const args: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const c = map[k]; if (!c) continue;
      cols.push(`${c} = ?`); args.push((v as string | number | undefined) ?? null);
    }
    if (cols.length) this.db.prepare(`UPDATE jobs SET ${cols.join(", ")} WHERE id = ?`).run(...args, id);
  }

  /** Compare-and-set on job state; returns false if the job was not in one of `from`. */
  casJobState(id: string, from: JobState[], to: JobState, extra: Partial<Job> = {}): boolean {
    return this.tx(() => {
      const cur = this.getJob(id);
      if (!cur || !from.includes(cur.state)) return false;
      this.updateJob(id, { ...extra, state: to });
      return true;
    });
  }

  /** Worker-side transition guarded by owner generation, so a fenced-out owner cannot write. */
  fencedTransition(id: string, generation: number, from: JobState[], to: JobState, extra: Partial<Job> = {}): boolean {
    return this.tx(() => {
      const cur = this.getJob(id);
      if (!cur || cur.ownerGeneration !== generation || !from.includes(cur.state)) return false;
      if (!this.leaseIs(cur.sessionId, generation)) return false;
      this.updateJob(id, { ...extra, state: to });
      return true;
    });
  }

  /** Atomically write result, terminal state and terminal event (no "result but still running" window). */
  completeJob(id: string, generation: number, state: JobState, extra: Partial<Job>, result: JobResult | undefined,
    event: { type: EventType; payload: Record<string, unknown> }): boolean {
    return this.tx(() => {
      const cur = this.getJob(id);
      if (!cur || cur.ownerGeneration !== generation || TERMINAL.has(cur.state)) return false;
      if (!this.leaseIs(cur.sessionId, generation)) return false;
      if (result) this.db.prepare("UPDATE jobs SET result = ? WHERE id = ?").run(JSON.stringify(result), id);
      this.updateJob(id, { ...extra, state, finishedAt: now() });
      const r = this.db.prepare("SELECT next_seq FROM jobs WHERE id = ?").get(id) as Row;
      const seq = Number(r.next_seq);
      this.db.prepare("INSERT INTO events (job_id, seq, type, at, source, payload, truncated) VALUES (?,?,?,?,?,?,0)")
        .run(id, seq, event.type, now(), "turnweft", JSON.stringify(event.payload));
      this.db.prepare("UPDATE jobs SET next_seq = ? WHERE id = ?").run(seq + 1, id);
      return true;
    });
  }

  /** The session's current lease belongs to this generation (finding 11: stale owners cannot write). */
  private leaseIs(sessionId: string, generation: number): boolean {
    const r = this.db.prepare("SELECT generation, owner_token FROM leases WHERE session_id = ?").get(sessionId) as Row | undefined;
    return Boolean(r && Number(r.generation) === generation && String(r.owner_token) !== "");
  }

  /** Worker event append fenced like job transitions. Returns false (and writes nothing) for a stale owner. */
  appendEventFenced(jobId: string, generation: number, type: EventType, source: TurnEvent["source"], payload: Record<string, unknown>): boolean {
    return this.tx(() => {
      const cur = this.getJob(jobId);
      if (!cur || cur.ownerGeneration !== generation || !this.leaseIs(cur.sessionId, generation)) return false;
      const r = this.db.prepare("SELECT next_seq FROM jobs WHERE id = ?").get(jobId) as Row;
      const seq = Number(r.next_seq);
      this.db.prepare("INSERT INTO events (job_id, seq, type, at, source, payload, truncated) VALUES (?,?,?,?,?,?,0)")
        .run(jobId, seq, type, now(), source, JSON.stringify(payload));
      this.db.prepare("UPDATE jobs SET next_seq = ? WHERE id = ?").run(seq + 1, jobId);
      return true;
    });
  }

  /** Recovery: terminal state, finish time and terminal event in one transaction (finding 8). */
  recoverJob(id: string, state: JobState, extra: Partial<Job>, event?: { type: EventType; payload: Record<string, unknown> }): boolean {
    return this.tx(() => {
      const cur = this.getJob(id);
      if (!cur || TERMINAL.has(cur.state)) return false;
      this.updateJob(id, { ...extra, state, ...(TERMINAL.has(state) ? { finishedAt: now() } : {}) });
      if (event) {
        const r = this.db.prepare("SELECT next_seq FROM jobs WHERE id = ?").get(id) as Row;
        const seq = Number(r.next_seq);
        this.db.prepare("INSERT INTO events (job_id, seq, type, at, source, payload, truncated) VALUES (?,?,?,?,?,?,0)")
          .run(id, seq, event.type, now(), "turnweft", JSON.stringify(event.payload));
        this.db.prepare("UPDATE jobs SET next_seq = ? WHERE id = ?").run(seq + 1, id);
      }
      return true;
    });
  }

  setJobResult(id: string, result: JobResult) {
    this.db.prepare("UPDATE jobs SET result = ? WHERE id = ?").run(JSON.stringify(result), id);
  }

  getJobResult(id: string): JobResult | undefined {
    const r = this.db.prepare("SELECT result FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return r?.result ? j<JobResult>(r.result) : undefined;
  }

  // ------------------------------------------------------------ events
  appendEvent(jobId: string, type: EventType, source: TurnEvent["source"], payload: Record<string, unknown>, truncated = false): number {
    return this.tx(() => {
      const r = this.db.prepare("SELECT next_seq FROM jobs WHERE id = ?").get(jobId) as Row;
      const seq = Number(r.next_seq);
      this.db.prepare("INSERT INTO events (job_id, seq, type, at, source, payload, truncated) VALUES (?,?,?,?,?,?,?)")
        .run(jobId, seq, type, now(), source, JSON.stringify(payload), truncated ? 1 : 0);
      this.db.prepare("UPDATE jobs SET next_seq = ? WHERE id = ?").run(seq + 1, jobId);
      return seq;
    });
  }

  events(jobId: string, afterSeq = 0, limit = 200): TurnEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(jobId, afterSeq, limit) as Row[])
      .map((r) => ({ jobId, seq: Number(r.seq), type: r.type as EventType, at: String(r.at),
        source: r.source as TurnEvent["source"], payload: j<Record<string, unknown>>(r.payload) ?? {}, truncated: Boolean(r.truncated) }));
  }

  // ------------------------------------------------------------ policies & proposals
  insertPolicy(p: UserPolicy) {
    this.db.prepare(`INSERT INTO policies (id, provider, canonical_root, intent, tier, excess, cli_version, adapter_version,
      capability_digest, confirmed_via, confirmed_at, revision, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, p.provider, p.canonicalRoot, p.intent, p.tier, JSON.stringify(p.excessOverGrant), p.cliVersion,
        p.adapterVersion, p.capabilityDigest, p.confirmedVia, p.confirmedAt, p.revision, p.revokedAt ?? null);
  }

  findActivePolicy(k: { provider: ProviderId; canonicalRoot: string; intent: Intent; tier: string; capabilityDigest: string }): UserPolicy | undefined {
    const r = this.db.prepare(`SELECT * FROM policies WHERE provider = ? AND canonical_root = ? AND intent = ? AND tier = ?
      AND capability_digest = ? AND revoked_at IS NULL ORDER BY revision DESC LIMIT 1`)
      .get(k.provider, k.canonicalRoot, k.intent, k.tier, k.capabilityDigest) as Row | undefined;
    return r ? rowToPolicy(r) : undefined;
  }

  getPolicy(id: string): UserPolicy | undefined {
    const r = this.db.prepare("SELECT * FROM policies WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToPolicy(r) : undefined;
  }

  listPolicies(f: { canonicalRoot?: string; provider?: ProviderId } = {}): UserPolicy[] {
    const where: string[] = []; const args: string[] = [];
    if (f.canonicalRoot) { where.push("canonical_root = ?"); args.push(f.canonicalRoot); }
    if (f.provider) { where.push("provider = ?"); args.push(f.provider); }
    return (this.db.prepare(`SELECT * FROM policies ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY confirmed_at DESC`)
      .all(...args) as Row[]).map(rowToPolicy);
  }

  revokePolicy(id: string) {
    this.db.prepare("UPDATE policies SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), id);
  }

  // ---- proposals (U11/U19). Every decision and every waiting-job transition happens inside one write lock.

  static proposalKey(p: { provider: string; canonicalRoot: string; intent: string; tier: string; capabilityDigest: string }): string {
    // Hashed: node:sqlite reads TEXT back only up to the first NUL, so a raw NUL-joined key cannot round-trip.
    return createHash("sha256").update(JSON.stringify([p.provider, p.canonicalRoot, p.intent, p.tier, p.capabilityDigest])).digest("hex");
  }

  insertProposal(p: PolicyProposal, binding: { requestId?: string; sessionId?: string } = {}) {
    this.db.prepare("INSERT INTO proposals (id, nonce, data, expires_at, request_id, session_id, pkey) VALUES (?,?,?,?,?,?,?)")
      .run(p.proposalId, p.nonce, JSON.stringify(p), p.expiresAt, binding.requestId ?? null, binding.sessionId ?? null, Store.proposalKey(p));
  }

  getProposal(id: string): (PolicyProposal & { consumedAt?: string }) | undefined {
    const r = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Row | undefined;
    if (!r) return undefined;
    const decision = s(r.decision) as PolicyProposal["decision"];
    return { ...(j<PolicyProposal>(r.data)), consumedAt: s(r.consumed_at), ...(decision ? { decision } : {}) };
  }

  /** Call inside a transaction: the single live pending proposal for this key, or a new one from `make` (round 5, 4). */
  pendingProposalTx(key: { provider: string; canonicalRoot: string; intent: string; tier: string; capabilityDigest: string },
    make: () => PolicyProposal, binding: { requestId?: string; sessionId?: string }): PolicyProposal {
    const r = this.db.prepare("SELECT data FROM proposals WHERE pkey = ? AND consumed_at IS NULL").get(Store.proposalKey(key)) as Row | undefined;
    if (r) return j<PolicyProposal>(r.data); // expireStaleTx ran first, so this one is unexpired
    const p = make();
    this.insertProposal(p, binding);
    return p;
  }

  /** Append a turnweft event inside the caller's transaction. */
  appendEventTx(jobId: string, type: EventType, payload: Record<string, unknown>) { this.jobEventTx(jobId, type, payload); }

  private jobEventTx(jobId: string, type: EventType, payload: Record<string, unknown>) {
    const r = this.db.prepare("SELECT next_seq FROM jobs WHERE id = ?").get(jobId) as Row;
    const seq = Number(r.next_seq);
    this.db.prepare("INSERT INTO events (job_id, seq, type, at, source, payload, truncated) VALUES (?,?,?,?,?,?,0)")
      .run(jobId, seq, type, now(), "turnweft", JSON.stringify(payload));
    this.db.prepare("UPDATE jobs SET next_seq = ? WHERE id = ?").run(seq + 1, jobId);
  }

  /** Call inside a transaction: expire overdue proposals and fail only their still-waiting jobs (round 5, 1/5/6). */
  expireStaleTx(): string[] {
    const overdue = this.db.prepare("SELECT id FROM proposals WHERE consumed_at IS NULL AND expires_at <= ?").all(now()) as Row[];
    const sessions = new Set<string>();
    for (const row of overdue) {
      const id = String(row.id);
      this.db.prepare("UPDATE proposals SET consumed_at = ?, decision = 'expired', decided_at = ? WHERE id = ? AND consumed_at IS NULL").run(now(), now(), id);
      const jobs = this.db.prepare("SELECT id, session_id FROM jobs WHERE proposal_id = ? AND state = 'waiting_confirmation'").all(id) as Row[];
      for (const jr of jobs) {
        this.db.prepare("UPDATE jobs SET state = 'failed', error_code = 'confirmation_expired', failure_reason = ?, finished_at = ? WHERE id = ? AND state = 'waiting_confirmation'")
          .run("nobody confirmed within the proposal lifetime", now(), String(jr.id));
        this.jobEventTx(String(jr.id), "turn.failed", { state: "failed", errorCode: "confirmation_expired" });
        sessions.add(String(jr.session_id));
      }
    }
    return [...sessions];
  }

  /** Expire overdue proposals (cheap read first; writes only when something is overdue). Returns affected sessions. */
  expireStale(): string[] {
    const any = this.db.prepare("SELECT 1 FROM proposals WHERE consumed_at IS NULL AND expires_at <= ? LIMIT 1").get(now());
    return any ? this.tx(() => this.expireStaleTx()) : [];
  }

  /**
   * Confirm or reject a proposal and apply it to every job still waiting on the same key, atomically
   * (round 5, 1/2/5). Only waiting_confirmation jobs move: queued on confirm, cancelled on reject. A job
   * that already started is never touched here (it must go through cancel_requested and the stop path).
   */
  decideProposal(a: { proposalId: string; nonce: string; decision: "confirmed" | "rejected"; via: string; makePolicy?: (p: PolicyProposal) => UserPolicy }):
    { proposal: PolicyProposal; policy?: UserPolicy; released: Job[]; cancelled: Job[] } {
    return this.tx(() => {
      this.expireStaleTx();
      const p = this.getProposal(a.proposalId);
      const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
      if (!p) throw fail("proposal_not_found", `no proposal ${a.proposalId}`);
      if (p.consumedAt) throw fail(p.decision === "expired" ? "proposal_expired" : "proposal_consumed",
        p.decision === "expired" ? "proposal expired; submit the turn again to get a new one" : "proposal already used");
      if (p.nonce !== a.nonce) throw fail("nonce_mismatch", "nonce does not match this proposal");
      this.db.prepare("UPDATE proposals SET consumed_at = ?, decision = ?, decided_at = ? WHERE id = ? AND consumed_at IS NULL").run(now(), a.decision, now(), a.proposalId);
      const policy = a.decision === "confirmed" && a.makePolicy ? a.makePolicy(p) : undefined;
      if (policy) this.insertPolicy(policy);
      const key = Store.proposalKey(p);
      const rows = this.db.prepare(`SELECT j.* FROM jobs j JOIN proposals q ON q.id = j.proposal_id
        WHERE j.state = 'waiting_confirmation' AND (q.pkey = ? OR q.id = ?) ORDER BY j.accepted_at`).all(key, a.proposalId) as Row[];
      const released: Job[] = []; const cancelled: Job[] = [];
      for (const r of rows) {
        const job = rowToJob(r);
        if (a.decision === "confirmed") {
          this.db.prepare("UPDATE jobs SET state = 'queued', policy_id = ? WHERE id = ? AND state = 'waiting_confirmation'").run(policy?.id ?? null, job.id);
          this.jobEventTx(job.id, "permission.resolved", { confirmedVia: a.via, policyId: policy?.id ?? null });
          released.push(job);
        } else {
          this.db.prepare("UPDATE jobs SET state = 'cancelled', error_code = 'confirmation_denied', failure_reason = ?, finished_at = ? WHERE id = ? AND state = 'waiting_confirmation'")
            .run(`the user denied the confirmation (${a.via})`, now(), job.id);
          this.jobEventTx(job.id, "turn.failed", { state: "cancelled", errorCode: "confirmation_denied" });
          cancelled.push(job);
        }
      }
      return { proposal: p, policy, released, cancelled };
    });
  }

  /** Dialog helper ownership, recorded on the proposal with a pid+start-time token (round 5, 7). */
  claimDialog(proposalId: string, token: string, isOwnerGone: (pid: number, token: string) => boolean): boolean {
    return this.tx(() => {
      const r = this.db.prepare("SELECT dialog_token, consumed_at FROM proposals WHERE id = ?").get(proposalId) as Row | undefined;
      if (!r || r.consumed_at) return false;
      const cur = s(r.dialog_token);
      if (cur) { const pid = Number(cur.split(":")[0]); if (!isOwnerGone(pid, cur)) return false; }
      this.db.prepare("UPDATE proposals SET dialog_token = ?, dialog_child = NULL WHERE id = ?").run(token, proposalId);
      return true;
    });
  }

  releaseDialog(proposalId: string, token: string) {
    this.db.prepare("UPDATE proposals SET dialog_token = NULL, dialog_child = NULL WHERE id = ? AND dialog_token = ?").run(proposalId, token);
  }

  setDialogChild(proposalId: string, helperToken: string, childToken: string) {
    this.db.prepare("UPDATE proposals SET dialog_child = ? WHERE id = ? AND dialog_token = ?").run(childToken, proposalId, helperToken);
  }

  /** Dialog owners recorded on this proposal or any other with its key (merged / expired ones included). */
  dialogOwnersForKey(proposalId: string): { id: string; helper?: string; child?: string }[] {
    const rows = this.db.prepare(`SELECT id, dialog_token, dialog_child FROM proposals
      WHERE (id = ? OR pkey = (SELECT pkey FROM proposals WHERE id = ?)) AND (dialog_token IS NOT NULL OR dialog_child IS NOT NULL)`)
      .all(proposalId, proposalId) as Row[];
    return rows.map((r) => ({ id: String(r.id), helper: s(r.dialog_token), child: s(r.dialog_child) }));
  }

  /** Forget a dead owner's dialog once its child is confirmed stopped, unless someone else recorded one since. */
  clearDialogIf(proposalId: string, helper: string | undefined, child: string | undefined) {
    this.db.prepare("UPDATE proposals SET dialog_token = NULL, dialog_child = NULL WHERE id = ? AND dialog_token IS ? AND dialog_child IS ?")
      .run(proposalId, helper ?? null, child ?? null);
  }

  getDialogOwner(proposalId: string): { helper?: string; child?: string } {
    const r = this.db.prepare("SELECT dialog_token, dialog_child FROM proposals WHERE id = ?").get(proposalId) as Row | undefined;
    return { helper: s(r?.dialog_token), child: s(r?.dialog_child) };
  }

  /** Jobs still waiting on any proposal with this proposal's key. */
  waitingJobCount(proposalId: string): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS c FROM jobs j JOIN proposals q ON q.id = j.proposal_id
      WHERE j.state = 'waiting_confirmation' AND q.pkey = (SELECT pkey FROM proposals WHERE id = ?)`).get(proposalId) as Row;
    return Number(r.c);
  }

  // ------------------------------------------------------------ leases & locks
  getLease(sessionId: string): Lease | undefined {
    const r = this.db.prepare("SELECT * FROM leases WHERE session_id = ?").get(sessionId) as Row | undefined;
    return r ? {
      ownerPid: Number(r.owner_pid), ownerToken: String(r.owner_token), generation: Number(r.generation),
      heartbeatAt: String(r.heartbeat_at), nativePid: n(r.native_pid), nativeToken: s(r.native_token),
    } : undefined;
  }

  /**
   * Claim the session lease. `isOwnerGone` must prove the previous owner process has stopped;
   * a stale heartbeat alone is not enough (§9.2).
   */
  claimLease(sessionId: string, pid: number, token: string, isOwnerGone: (pid: number, token: string) => boolean,
    expectGeneration?: number, nativeStopped: (pid: number, token: string) => boolean = isOwnerGone): number | undefined {
    return this.tx(() => {
      const cur = this.getLease(sessionId);
      if (cur && cur.ownerToken !== "" && !isOwnerGone(cur.ownerPid, cur.ownerToken)) return undefined;
      // The caller verified the previous native executor stopped for this generation; refuse if it moved.
      if (expectGeneration !== undefined && (cur?.generation ?? 0) !== expectGeneration) return undefined;
      if (cur?.nativePid && cur.nativeToken && !nativeStopped(cur.nativePid, cur.nativeToken)) return undefined;
      const generation = (cur?.generation ?? 0) + 1;
      this.db.prepare(`INSERT INTO leases (session_id, owner_pid, owner_token, generation, heartbeat_at, native_pid, native_token)
        VALUES (?,?,?,?,?,NULL,NULL)
        ON CONFLICT(session_id) DO UPDATE SET owner_pid = excluded.owner_pid, owner_token = excluded.owner_token,
        generation = excluded.generation, heartbeat_at = excluded.heartbeat_at, native_pid = NULL, native_token = NULL`)
        .run(sessionId, pid, token, generation, now());
      return generation;
    });
  }

  /** Record the provider process the owner spawned, so a successor can prove it stopped (§9.2). */
  setLeaseNative(sessionId: string, token: string, nativePid: number | undefined, nativeToken: string | undefined) {
    this.db.prepare("UPDATE leases SET native_pid = ?, native_token = ? WHERE session_id = ? AND owner_token = ?")
      .run(nativePid ?? null, nativeToken ?? null, sessionId, token);
  }

  /** Release only if no queued job exists; keeps the generation history (never delete the row). */
  releaseLeaseIfIdle(sessionId: string, token: string, opts: { keepNative?: boolean } = {}): boolean {
    return this.tx(() => {
      const q = this.db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE session_id = ? AND state = 'queued'").get(sessionId) as Row;
      if (Number(q.c) > 0) return false;
      this.releaseLease(sessionId, token, opts);
      return true;
    });
  }

  heartbeat(sessionId: string, token: string): boolean {
    const res = this.db.prepare("UPDATE leases SET heartbeat_at = ? WHERE session_id = ? AND owner_token = ?").run(now(), sessionId, token);
    return Number(res.changes) === 1;
  }

  /** keepNative: the provider could not be proven stopped, so a successor must stop it first (round 2, finding 1). */
  releaseLease(sessionId: string, token: string, opts: { keepNative?: boolean } = {}) {
    const sql = opts.keepNative
      ? "UPDATE leases SET owner_pid = 0, owner_token = '' WHERE session_id = ? AND owner_token = ?"
      : "UPDATE leases SET owner_pid = 0, owner_token = '', native_pid = NULL, native_token = NULL WHERE session_id = ? AND owner_token = ?";
    this.db.prepare(sql).run(sessionId, token);
  }

  /** Holder of a project's write lock, for recovery of a session whose worker died while holding it. */
  projectLockHolder(root: string): { jobId: string; sessionId?: string; ownerPid: number; ownerToken: string } | undefined {
    const r = this.db.prepare("SELECT l.job_id, l.owner_pid, l.owner_token, j.session_id FROM project_locks l LEFT JOIN jobs j ON j.id = l.job_id WHERE l.canonical_root = ?").get(root) as Row | undefined;
    return r ? { jobId: String(r.job_id), sessionId: s(r.session_id), ownerPid: Number(r.owner_pid), ownerToken: String(r.owner_token) } : undefined;
  }

  /**
   * Take a project's write lock. A dead holder worker is not enough: the holder session's provider
   * must also be proven stopped (round 2, finding 3). `nativeStopped` checks the process group.
   */
  acquireProjectLock(root: string, jobId: string, pid: number, token: string, isOwnerGone: (pid: number, token: string) => boolean,
    nativeStopped: (pid: number, token: string) => boolean = isOwnerGone): boolean {
    return this.tx(() => {
      const r = this.db.prepare("SELECT * FROM project_locks WHERE canonical_root = ?").get(root) as Row | undefined;
      if (r && String(r.job_id) !== jobId) {
        if (!isOwnerGone(Number(r.owner_pid), String(r.owner_token))) return false;
        const holder = this.getJob(String(r.job_id));
        const lease = holder ? this.getLease(holder.sessionId) : undefined;
        if (lease?.nativePid && lease.nativeToken && !nativeStopped(lease.nativePid, lease.nativeToken)) return false;
      }
      this.db.prepare(`INSERT INTO project_locks (canonical_root, job_id, owner_pid, owner_token, acquired_at) VALUES (?,?,?,?,?)
        ON CONFLICT(canonical_root) DO UPDATE SET job_id = excluded.job_id, owner_pid = excluded.owner_pid,
        owner_token = excluded.owner_token, acquired_at = excluded.acquired_at`).run(root, jobId, pid, token, now());
      return true;
    });
  }

  releaseProjectLock(root: string, jobId: string) {
    this.db.prepare("DELETE FROM project_locks WHERE canonical_root = ? AND job_id = ?").run(root, jobId);
  }
}
