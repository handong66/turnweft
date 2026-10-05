// Scripted fake provider for core tests (TURNWEFT_FAKE_ADAPTERS=1). Runs in-process inside the worker,
// keeps "native history" in files so restart + resume (L2) can be tested. Prompt directives, one per line:
//   REMEMBER:<tok>  RECALL  WRITE:<path>  SLEEP:<ms>  HANG  IGNORECANCEL  CRASH  ASK:<kind>  FAIL:auth|provider  BLOCK
// Environment / files read at call time:
//   TURNWEFT_FAKE_EXCESS=1           implement tier needs a U11 confirmation
//   TURNWEFT_FAKE_OPEN_DELAY_MS      delay inside open() (cancel-during-starting tests)
//   $TURNWEFT_HOME/fake-tier.txt     suffix appended to the implement tier name (tier change between submit and run)
//   TURNWEFT_FAKE_REAL_PROC=1        spawn a real process group (sh leader + background child) as the "provider"
// Extra directive: STOP:<reason> returns that stopReason.
// Thinking level (U23): offers low / medium / high (default "auto"); any other requested value fails open() with invalid_effort.
// Directive EFFORT:<level> changes the live level after the turn, as if the agent had switched it.
// In-session changes (setEffort): "hang" never answers; "noreport" takes effect but gives no read-back (state unknown);
// TURNWEFT_FAKE_EFFORT_DELAY_MS delays the answer; TURNWEFT_FAKE_LAUNCH_EFFORT=1 removes setEffort, like agy.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Intent, ProbeResult, ProviderId } from "../core/types.js";
import { stateDir } from "../runtime/paths.js";
import { AdapterError, type Adapter, type AdapterEvent, type ConnectHooks, type Connection, type OpenInput, type OpenResult, type PromptOutcome, type TierSpec } from "./types.js";

const FAKE_EFFORTS = ["low", "medium", "high"];
const histDir = () => { const d = join(stateDir(), "fake-native"); mkdirSync(d, { recursive: true }); return d; };

class FakeConnection implements Connection {
  private child?: ChildProcess;
  get pid() { return this.child?.pid ?? process.pid; }
  hasExited = false;
  private id?: string;
  private tier?: TierSpec;
  private cancelled = false;
  private wake?: () => void;
  private exitResolve!: (v: { code: number | null; signal: string | null }) => void;
  readonly exited = new Promise<{ code: number | null; signal: string | null }>((r) => { this.exitResolve = r; });
  private snapshot: Record<string, string> = {};
  constructor(private cwd: string, private hooks: ConnectHooks = {}) {
    if (process.env.TURNWEFT_FAKE_LAUNCH_EFFORT === "1") (this as { setEffort?: unknown }).setEffort = undefined;
  }

  currentEffective() { return { ...this.snapshot }; }
  currentEffort() { return this.snapshot.effort; }
  async setEffort(value: string) {
    const delay = Number(process.env.TURNWEFT_FAKE_EFFORT_DELAY_MS ?? 0);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (value === "hang") await new Promise(() => {});
    if (value === "noreport") { this.snapshot.effort = value; throw new AdapterError("invalid_effort", "no read-back", true); }
    if (!FAKE_EFFORTS.includes(value)) throw new AdapterError("invalid_effort", `effort "${value}" is not offered; fake offers ${FAKE_EFFORTS.join(", ")}`);
    this.snapshot.effort = value;
  }

  private exit(signal: string | null) {
    if (this.hasExited) return;
    this.hasExited = true;
    this.exitResolve({ code: signal ? null : 0, signal });
  }

  async open(input: OpenInput): Promise<OpenResult> {
    if (process.env.TURNWEFT_FAKE_REAL_PROC === "1" && !this.child) {
      // Like agy: the provider process starts inside open(), before the protocol handshake completes.
      this.child = spawn("sh", ["-c", "sleep 600 & sleep 600"], { detached: true, stdio: "ignore" });
      if (this.child.pid) this.hooks.onSpawn?.(this.child.pid);
      this.child.on("exit", (code, signal) => this.exit(signal ?? (code === null ? "unknown" : null)));
    }
    const delay = Number(process.env.TURNWEFT_FAKE_OPEN_DELAY_MS ?? 0);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    this.tier = input.tier;
    if (input.effort !== undefined && !FAKE_EFFORTS.includes(input.effort)) throw new AdapterError("invalid_effort", `effort "${input.effort}" is not offered; fake offers ${FAKE_EFFORTS.join(", ")}`);
    if (input.nativeSessionId) {
      if (!existsSync(join(histDir(), `${input.nativeSessionId}.json`))) throw new AdapterError("session_not_found", `fake session ${input.nativeSessionId} not found`);
      this.id = input.nativeSessionId;
    } else {
      this.id = `fake-${randomUUID()}`;
      writeFileSync(join(histDir(), `${this.id}.json`), JSON.stringify({ memory: {} }));
    }
    this.snapshot = { mode: input.tier.tier, effort: input.effort ?? "auto", conn: randomUUID() };
    return {
      nativeSessionId: this.id, loaded: Boolean(input.nativeSessionId), effective: { ...this.snapshot },
      model: { requested: input.model, effective: input.model ?? "fake-default" },
      effort: { requested: input.effort, effective: this.snapshot.effort },
    };
  }

  async prompt(text: string, onEvent: (e: AdapterEvent) => void): Promise<PromptOutcome> {
    this.cancelled = false;
    const file = join(histDir(), `${this.id}.json`);
    const hist = JSON.parse(readFileSync(file, "utf8")) as { memory: Record<string, string> };
    let stop = "end_turn";
    for (const line of text.split("\n").map((l) => l.trim())) {
      const [cmd, arg = ""] = line.split(/:(.*)/s, 2) as [string, string?];
      if (cmd === "REMEMBER") { hist.memory.token = arg; onEvent({ type: "text", text: `remembered ${arg}\n` }); }
      else if (cmd === "RECALL") onEvent({ type: "text", text: hist.memory.token ?? "(nothing)" });
      else if (cmd === "EFFORT") this.snapshot.effort = arg;
      else if (cmd === "SAY") onEvent({ type: "text", text: arg }); // no trailing newline, like streamed agent text
      else if (cmd === "TOOL") onEvent({ type: "tool", kind: "read", title: arg, status: "completed" });
      else if (cmd === "WRITE") {
        const decision = this.tier!.decide("edit", `write ${arg}`);
        onEvent({ type: "permission", kind: "edit", title: `write ${arg}`, decision });
        if (decision === "allow") { writeFileSync(join(this.cwd, arg), `written by fake at ${Date.now()}\n`); onEvent({ type: "tool", kind: "edit", title: arg, status: "completed" }); }
      } else if (cmd === "ASK") {
        const decision = this.tier!.decide(arg as never, `ask ${arg}`);
        onEvent({ type: "permission", kind: arg, title: `ask ${arg}`, decision });
      } else if (cmd === "SLEEP" || cmd === "HANG") {
        const ms = cmd === "HANG" ? 3_600_000 : Number(arg);
        await new Promise<void>((r) => { const t = setTimeout(r, ms); this.wake = () => { clearTimeout(t); r(); }; });
        if (this.cancelled) { stop = "cancelled"; break; }
        if (cmd === "SLEEP") onEvent({ type: "text", text: `slept ${ms}\n` });
      } else if (cmd === "IGNORECANCEL") {
        await new Promise<never>(() => {}); // never resolves; only close() ends it
      } else if (cmd === "CRASH") {
        setTimeout(() => this.exit("SIGKILL"), 50);
        await new Promise<never>(() => {});
      } else if (cmd === "FAIL") throw new AdapterError(arg === "auth" ? "auth_required" : "provider_error", `fake failure: ${arg}`);
      else if (cmd === "SETMODE_IDLE") { setTimeout(() => { this.snapshot.mode = arg; }, 200); } // changes after the turn, no event
      else if (cmd === "SETMODE") { this.snapshot.mode = arg; onEvent({ type: "config", effective: { ...this.snapshot } }); }
      else if (cmd === "STOP") { writeFileSync(file, JSON.stringify(hist)); return { stopReason: arg }; }
      else if (cmd === "BLOCK") { writeFileSync(file, JSON.stringify(hist)); return { stopReason: "permission_blocked", blocked: ["command:RunCommand"] }; }
      else if (line) onEvent({ type: "text", text: `echo ${line}\n` });
    }
    writeFileSync(file, JSON.stringify(hist));
    return { stopReason: stop };
  }

  async cancel() { this.cancelled = true; this.wake?.(); }
  async close() {
    // Simulated unstoppable provider: the process really keeps running (test of the freeze path).
    if (process.env.TURNWEFT_TEST_UNSTOPPABLE === "1" && this.child?.pid) return;
    if (this.child?.pid) { try { process.kill(-this.child.pid, "SIGTERM"); } catch { /* gone */ } }
    else this.exit("SIGTERM");
  }
}

function tierSuffix(): string {
  try { return readFileSync(join(stateDir(), "fake-tier.txt"), "utf8").trim(); } catch { return ""; }
}

export function fakeAdapter(provider: ProviderId): Adapter {
  const tier = (intent: Intent): TierSpec => {
    const name = intent === "implement" ? `fake-write${tierSuffix()}` : "fake-read";
    return {
      tier: name,
      excess: intent === "implement" && process.env.TURNWEFT_FAKE_EXCESS === "1" ? [{ key: "fakeExcess" }] : [],
      decide: (kind) => (intent === "implement" || kind === "read" || kind === "search" ? "allow" : "deny"),
      satisfiedBy: (e) => e.mode === name,
    };
  };
  return {
    provider,
    adapterVersion: "fake-0",
    capabilities: { transport: "acp", multiTurn: true, resumeAfterRestart: "supported", cancelTurn: "protocol", permissions: "callback", structuredEvents: "exact", modelConfig: "session", effortConfig: "session" },
    async probe(): Promise<ProbeResult> {
      return { provider, available: true, executable: "fake", cliVersion: "0.0.0-fake", adapterVersion: "fake-0", capabilities: this.capabilities, problems: [], probedAt: new Date().toISOString() };
    },
    tierFor: tier,
    connect: (cwd, hooks) => new FakeConnection(cwd, hooks),
  };
}
