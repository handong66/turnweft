// agy 1.2.x native long-lived stream-json (M0 §4). One process per active session; each input line runs a turn.
// Input: {"event":"user","message":{"content":[{"type":"text","text":"..."}]}}
import { spawn, type ChildProcess } from "node:child_process";
import { AdapterError, type AdapterEvent, type ConnectHooks, type Connection, type OpenInput, type OpenResult, type PromptOutcome } from "./types.js";
import { providerEnv } from "./env.js";

type Json = Record<string, any>;

export class AgyConnection implements Connection {
  private proc?: ChildProcess;
  private buf = "";
  private conversationId?: string;
  private onEvent: ((e: AdapterEvent) => void) | undefined;
  private waiter?: (r: Json) => void;
  private initWaiter?: () => void;
  private exitResolve!: (v: { code: number | null; signal: string | null }) => void;
  readonly exited = new Promise<{ code: number | null; signal: string | null }>((r) => { this.exitResolve = r; });
  stderrTail = "";
  hasExited = false;

  private effectiveSnapshot: Record<string, string> = {};

  constructor(private exe: string, private cwd: string, private hooks: ConnectHooks = {}) {}

  currentEffective() { return { ...this.effectiveSnapshot }; }

  private launchEffort?: string;
  currentEffort() { return this.launchEffort; }

  get pid() { return this.proc?.pid; }

  async open(input: OpenInput): Promise<OpenResult> {
    const skip = input.tier.tier === "skip-permissions+accept-edits";
    const mode = skip ? "skip-permissions+accept-edits" : undefined;
    const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--add-dir", input.cwd];
    if (skip) args.push("--dangerously-skip-permissions", "--mode", "accept-edits");
    if (input.model) args.push("--model", input.model);
    // U23: launch flag; agy rejects unknown values at startup.
    if (input.effort !== undefined) { args.push("--effort", input.effort); this.launchEffort = input.effort; }
    if (input.nativeSessionId) args.push("--conversation", input.nativeSessionId);
    args.push("-p=");
    this.proc = spawn(this.exe, args, { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"], detached: true, env: providerEnv(this.exe) });
    if (this.proc.pid) this.hooks.onSpawn?.(this.proc.pid); // record before waiting for init (round 3, finding 4)
    this.proc.on("exit", (code, signal) => { this.hasExited = true; this.exitResolve({ code, signal }); this.waiter?.({ exited: { code, signal } }); });
    this.proc.on("error", () => { /* surfaced via exited */ });
    this.proc.stderr!.on("data", (d) => { this.stderrTail = (this.stderrTail + d).slice(-4000); });
    this.proc.stdout!.on("data", (d) => this.onData(String(d)));

    let permissionMode = "unknown";
    // init is emitted at startup; if a version delays it until the first input, fall back to the requested id.
    await Promise.race([
      new Promise<void>((r) => { this.initWaiter = r; }),
      new Promise<void>((r) => setTimeout(r, 20000)),
      this.exited.then(() => {
        // Classify on the whole captured output: a long rejected value can push the marker out of the shown tail.
        const code = /invalid --effort/i.test(this.stderrTail) ? "invalid_effort" : "provider_error";
        throw new AdapterError(code, `agy exited during startup: ${this.stderrTail.slice(-300)}`);
      }),
    ]);
    permissionMode = this.initPermissionMode ?? permissionMode;
    if (input.nativeSessionId && this.conversationId && this.conversationId !== input.nativeSessionId) {
      await this.close();
      throw new AdapterError("session_not_found", `agy resumed ${this.conversationId}, not the requested ${input.nativeSessionId}`);
    }
    // The id must come from agy's own init event; a requested id is never reported as resumed (review finding 5).
    const id = this.conversationId;
    if (!id) { await this.close(); throw new AdapterError("provider_error", "agy did not report a conversation id; resume cannot be verified"); }
    return {
      nativeSessionId: id,
      loaded: Boolean(input.nativeSessionId),
      // permission_mode is agy's own read-back (init event): "always-proceed" when prompts are skipped,
      // "request-review" otherwise. --mode is not echoed, so it is recorded only as a launch flag.
      effective: (this.effectiveSnapshot = { permission_mode: permissionMode, launch_flags: mode ?? "none" }),
      model: { requested: input.model, effective: input.model },
      // agy's init event does not echo the level: effective is the launch flag, not a read-back.
      effort: { requested: input.effort, effective: input.effort },
    };
  }

  private initPermissionMode?: string;

  private onData(chunk: string) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let ev: Json;
      try { ev = JSON.parse(line); } catch { this.onEvent?.({ type: "diagnostic", message: line.slice(0, 300) }); continue; }
      if (ev.event === "init") {
        this.conversationId = ev.conversation_id;
        this.initPermissionMode = ev.init?.permission_mode;
        this.initWaiter?.();
      } else if (ev.event === "step_update") {
        const s = ev.step_update ?? {};
        if (s.step_type === "tool") this.onEvent?.({ type: "tool", kind: s.tool_name, title: JSON.stringify(s.tool_info?.parameters ?? {}).slice(0, 200), status: s.state });
      } else if (ev.event === "result") {
        const w = this.waiter; this.waiter = undefined; w?.(ev.result ?? {});
      }
    }
  }

  async prompt(text: string, onEvent: (e: AdapterEvent) => void): Promise<PromptOutcome> {
    if (!this.proc) throw new Error("agy not open");
    this.onEvent = onEvent;
    this.cancelRequested = false;
    const r = await new Promise<Json>((resolve) => {
      this.waiter = resolve;
      this.proc!.stdin!.write(JSON.stringify({ event: "user", message: { content: [{ type: "text", text }] } }) + "\n");
    });
    this.onEvent = undefined;
    if (r.exited) throw new AdapterError("provider_error", `agy exited: ${this.stderrTail.slice(-300)}`);
    if (r.response) onEvent({ type: "text", text: String(r.response) });
    const blocked = Array.isArray(r.denied_actions) ? r.denied_actions.map((d: Json) => `${d.action}:${d.display_name}`) : [];
    if (r.status === "ERROR") {
      const msg = String(r.error ?? "agy reported ERROR");
      // SIGINT from cancel() ends the turn with status ERROR / "interrupted" (live run).
      if (this.cancelRequested && /interrupt|cancel/i.test(msg)) return { stopReason: "cancelled", blocked, usage: r.usage };
      if (/auth|login|sign in/i.test(msg)) throw new AdapterError("auth_required", msg);
      throw new AdapterError("provider_error", msg);
    }
    // status SUCCESS with denied_actions means the turn stopped at a permission denial (M0 §4).
    return { stopReason: blocked.length ? "permission_blocked" : (r.status === "CANCELLED" ? "cancelled" : "end_turn"), blocked, usage: r.usage };
  }

  private cancelRequested = false;

  async cancel() {
    this.cancelRequested = true;
    if (this.proc?.pid) try { process.kill(this.proc.pid, "SIGINT"); } catch { /* gone */ }
  }

  async close() {
    if (!this.proc) return;
    try { this.proc.stdin?.end(); } catch { /* ignore */ }
    const t = setTimeout(() => { try { process.kill(-this.proc!.pid!, "SIGTERM"); } catch { /* gone */ } }, 10000);
    const t2 = setTimeout(() => { try { process.kill(-this.proc!.pid!, "SIGKILL"); } catch { /* gone */ } }, 15000);
    await this.exited;
    clearTimeout(t); clearTimeout(t2);
  }
}
