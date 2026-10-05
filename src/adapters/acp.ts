// Shared ACP connection over the official SDK (§6.2). Provider differences live in AcpProfile.
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, type Agent, type Client } from "@agentclientprotocol/sdk";
import { AdapterError, type AdapterEvent, type ConnectHooks, type Connection, type OpenInput, type OpenResult, type PermissionKind, type PromptOutcome, type TierSpec } from "./types.js";
import { providerEnv } from "./env.js";

export interface AcpProfile {
  command: string;
  args: string[];
  /** Config options to set for a tier, in order, e.g. [["permission", "workspace-write"]]. */
  settingsFor(tier: TierSpec): Array<[configId: string, value: string]>;
  /** Classify a load/resume error as "session not found" (adapter-specific error shapes, M0 §2). */
  isSessionNotFound(err: unknown): boolean;
  /** Extra effective-mode facts not exposed as config options (e.g. Grok user config). */
  staticEffective?(): Record<string, string>;
}

type Json = Record<string, any>;

function configMap(options: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(options)) for (const o of options as Json[]) if (o?.id != null) out[String(o.id)] = String(o.currentValue);
  return out;
}

/** Category and offered values of each select option; values depend on the current model (live probe, U23). */
type OptionMeta = { category?: string; values: string[] };
function optionMeta(options: unknown): Record<string, OptionMeta> {
  const out: Record<string, OptionMeta> = {};
  const values = (xs: unknown): string[] => Array.isArray(xs)
    ? (xs as Json[]).flatMap((x) => (Array.isArray(x?.options) ? values(x.options) : x?.value != null ? [String(x.value)] : []))
    : [];
  if (Array.isArray(options)) for (const o of options as Json[]) {
    if (o?.id != null) out[String(o.id)] = { category: o.category == null ? undefined : String(o.category), values: values(o.options) };
  }
  return out;
}

/** Ids used for the thinking level before ACP had a category for it (Dim, Droid/Grok, OpenCode; M0 §2). */
const THOUGHT_LEVEL_IDS = ["thought_level", "reasoning_effort", "effort"];

export const errText = (e: unknown) => {
  const x = e as Json;
  return [x?.message, x?.data?.detail, x?.data && JSON.stringify(x.data)].filter(Boolean).join(" | ") || String(e);
};

export class AcpConnection implements Connection {
  private proc: ChildProcess;
  private conn: ClientSideConnection;
  private sessionId?: string;
  private tier?: TierSpec;
  private effective: Record<string, string> = {};
  private meta: Record<string, OptionMeta> = {};
  private onEvent: ((e: AdapterEvent) => void) | undefined;
  private initialized?: Promise<unknown>;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  stderrTail = "";
  hasExited = false;

  constructor(private profile: AcpProfile, cwd: string, hooks: ConnectHooks = {}) {
    this.proc = spawn(profile.command, profile.args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true, env: providerEnv(profile.command) });
    if (this.proc.pid) hooks.onSpawn?.(this.proc.pid);
    this.exited = new Promise((r) => this.proc.on("exit", (code, signal) => { this.hasExited = true; r({ code, signal }); }));
    this.proc.on("error", () => { /* surfaced through exited / request failures */ });
    this.proc.stderr!.on("data", (d) => { this.stderrTail = (this.stderrTail + d).slice(-4000); });
    const stream = ndJsonStream(
      Writable.toWeb(this.proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(this.proc.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    this.conn = new ClientSideConnection((_agent: Agent): Client => ({
      requestPermission: async (params: Json) => {
        const kind = params.toolCall?.kind as PermissionKind | undefined;
        const title = String(params.toolCall?.title ?? params.toolCall?.toolCallId ?? "");
        const decision = this.tier ? this.tier.decide(kind, title) : "deny";
        this.onEvent?.({ type: "permission", kind, title, decision });
        const options = (params.options ?? []) as Json[];
        const wanted = decision === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
        const pick = wanted.map((k) => options.find((o) => o.kind === k)).find(Boolean);
        return (pick ? { outcome: { outcome: "selected", optionId: pick.optionId } } : { outcome: { outcome: "cancelled" } }) as any;
      },
      sessionUpdate: async (params: Json) => this.handleUpdate(params.update ?? {}),
    }), stream);
  }

  get pid() { return this.proc.pid; }

  currentEffective() { return { ...this.effective, ...(this.profile.staticEffective?.() ?? {}) }; }

  private handleUpdate(u: Json) {
    this.lastUpdateAt = Date.now();
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") this.onEvent?.({ type: "text", text: String(u.content.text) });
        break;
      case "agent_thought_chunk":
        this.onEvent?.({ type: "thought" });
        break;
      case "tool_call":
      case "tool_call_update":
        this.onEvent?.({ type: "tool", id: u.toolCallId, kind: u.kind, title: u.title, status: u.status });
        break;
      case "config_option_update":
        this.absorb(u.configOptions);
        this.onEvent?.({ type: "config", effective: { ...this.effective } });
        break;
      case "current_mode_update":
        this.effective["mode"] = String(u.currentModeId);
        this.onEvent?.({ type: "config", effective: { ...this.effective } });
        break;
      default:
        this.onEvent?.({ type: "diagnostic", message: `update:${u.sessionUpdate}` });
    }
  }

  private init() {
    this.initialized ??= this.conn.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "turnweft", version: "0.1.0" },
    } as any);
    return this.initialized;
  }

  async open(input: OpenInput): Promise<OpenResult> {
    await this.init();
    this.tier = input.tier;
    let loaded = false;
    let res: Json;
    if (input.nativeSessionId) {
      try {
        res = await this.conn.loadSession({ sessionId: input.nativeSessionId, cwd: input.cwd, mcpServers: [] } as any) as Json;
      } catch (e) {
        if (this.profile.isSessionNotFound(e)) throw new AdapterError("session_not_found", errText(e));
        throw new AdapterError("provider_error", errText(e));
      }
      this.sessionId = input.nativeSessionId;
      loaded = true;
      // load replays history as session/update notifications, some after the response (live run: Dim).
      // Drain until quiet so replayed text is never attributed to the next turn.
      await this.drainReplay(500, 8000);
    } else {
      res = await this.conn.newSession({ cwd: input.cwd, mcpServers: [] } as any) as Json;
      this.sessionId = String(res.sessionId);
    }
    this.absorb(res?.configOptions);
    if (res?.modes?.currentModeId) this.effective["mode"] = String(res.modes.currentModeId);

    // §7.4: re-apply on every open/load; a new process never inherits permission state.
    const sets = this.profile.settingsFor(input.tier);
    if (input.model) sets.push(["model", input.model]);
    for (const [configId, value] of sets) await this.apply(configId, value);
    // U23: the thinking level goes last. Its values depend on the model, and a model switch can reset it
    // (live: OpenCode falls back to low), so it is checked against what the current model offers.
    const effortId = this.thoughtLevelId();
    if (input.effort) await this.applyEffort(effortId, input.effort);
    const effective = { ...this.effective, ...(this.profile.staticEffective?.() ?? {}) };
    return {
      nativeSessionId: this.sessionId,
      loaded,
      effective,
      model: { requested: input.model, effective: effective["model"] },
      effort: { requested: input.effort, effective: effortId ? effective[effortId] : undefined },
    };
  }

  private absorb(options: unknown) {
    Object.assign(this.effective, configMap(options));
    Object.assign(this.meta, optionMeta(options));
  }

  private async apply(configId: string, value: string) {
    if (this.effective[configId] === value) return;
    const r = await this.conn.setSessionConfigOption({ sessionId: this.sessionId, configId, value } as any) as Json;
    this.absorb(r?.configOptions);
    if (this.effective[configId] !== value) await this.waitForConfig(configId, value, 3000);
  }

  private thoughtLevelId(): string | undefined {
    return Object.keys(this.meta).find((id) => this.meta[id]?.category === "thought_level")
      ?? THOUGHT_LEVEL_IDS.find((id) => id in this.meta);
  }

  /** Never run at a level other than the one requested: reject before setting, and verify the read-back. */
  private async applyEffort(id: string | undefined, value: string) {
    if (!id) throw new AdapterError("invalid_effort", "this agent exposes no thinking-level option");
    const model = this.effective["model"] ? ` with model ${this.effective["model"]}` : "";
    const offered = this.meta[id]?.values ?? [];
    const reject = (why: string) => new AdapterError("invalid_effort",
      `${why}; ${id} offers ${offered.length ? offered.join(", ") : "no listed values"}${model}. Create a new session with one of these values, or without effort.`);
    if (offered.length && !offered.includes(value)) throw reject(`effort "${value}" is not offered`);
    try { await this.apply(id, value); } catch (e) { throw reject(`setting ${id} to "${value}" failed: ${errText(e)}`); }
    // Droid answers an unknown value with {} and keeps another level (live run), so only the read-back counts.
    if (this.effective[id] !== value) throw reject(`requested effort "${value}" but the agent reports "${this.effective[id] ?? "nothing"}"`);
  }

  private lastUpdateAt = 0;

  private async drainReplay(quietMs: number, maxMs: number) {
    const until = Date.now() + maxMs;
    this.lastUpdateAt = Date.now();
    while (Date.now() < until && Date.now() - this.lastUpdateAt < quietMs) await new Promise((r) => setTimeout(r, 50));
  }

  /** Droid answers set_config_option with {} and reports via config_option_update (M0 §3). */
  private async waitForConfig(id: string, value: string, ms: number) {
    const until = Date.now() + ms;
    while (Date.now() < until && this.effective[id] !== value) await new Promise((r) => setTimeout(r, 100));
  }

  async prompt(text: string, onEvent: (e: AdapterEvent) => void): Promise<PromptOutcome> {
    if (!this.sessionId) throw new Error("session not open");
    this.onEvent = onEvent;
    try {
      const r = await this.conn.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text }] } as any) as Json;
      return { stopReason: String(r?.stopReason ?? "unknown"), usage: r?._meta ?? r?.usage };
    } catch (e) {
      const msg = errText(e);
      // Transport closed while the request was in flight: the outcome is unknown (round 2, finding 6).
      if (this.conn.signal.aborted || this.hasExited) throw new AdapterError("connection_lost", msg);
      if (/auth|login|unauthori[sz]ed|credential/i.test(msg)) throw new AdapterError("auth_required", msg);
      throw new AdapterError("provider_error", msg);
    } finally {
      this.onEvent = undefined;
    }
  }

  async cancel() {
    if (this.sessionId) await this.conn.cancel({ sessionId: this.sessionId } as any).catch(() => {});
  }

  async close() {
    try { this.proc.stdin?.end(); } catch { /* ignore */ }
    const t = setTimeout(() => { try { process.kill(-this.proc.pid!, "SIGTERM"); } catch { /* gone */ } }, 3000);
    const t2 = setTimeout(() => { try { process.kill(-this.proc.pid!, "SIGKILL"); } catch { /* gone */ } }, 8000);
    await this.exited;
    clearTimeout(t); clearTimeout(t2);
  }
}
