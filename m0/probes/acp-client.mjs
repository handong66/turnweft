// Minimal ACP (Agent Client Protocol) client for Turnweft M0 probes.
// Raw JSON-RPC 2.0 over NDJSON stdio; no SDK dependency. Logs every frame.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

export class AcpClient {
  constructor({ command, args = [], cwd, env, logFile, permissionPolicy = () => ({ outcome: "cancelled" }) }) {
    this.logFile = logFile;
    this.permissionPolicy = permissionPolicy;
    this.nextId = 1;
    this.pending = new Map();
    this.updates = [];
    this.permissionRequests = [];
    this.listeners = [];
    this.stderr = "";
    this.proc = spawn(command, args, { cwd, env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise((resolve) => this.proc.on("exit", (code, signal) => resolve({ code, signal })));
    let buf = "";
    this.proc.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.#onLine(line);
      }
    });
    this.proc.stderr.on("data", (d) => { this.stderr += d; });
  }

  #log(dir, obj) {
    if (this.logFile) appendFileSync(this.logFile, JSON.stringify({ t: new Date().toISOString(), dir, msg: obj }) + "\n");
  }

  #send(obj) {
    this.#log("out", obj);
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  #onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { this.#log("in-raw", line); return; }
    this.#log("in", msg);
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); msg.error ? p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error })) : p.resolve(msg.result); }
      return;
    }
    if (msg.method === "session/update") {
      this.updates.push(msg.params);
      for (const l of this.listeners) l(msg.params);
      return;
    }
    if (msg.method === "session/request_permission" && msg.id !== undefined) {
      this.permissionRequests.push(msg.params);
      Promise.resolve(this.permissionPolicy(msg.params)).then((outcome) =>
        this.#send({ jsonrpc: "2.0", id: msg.id, result: { outcome } }));
      return;
    }
    if (msg.id !== undefined && msg.method) {
      // Client capabilities advertise no fs/terminal, so reject anything else.
      this.#send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `client does not implement ${msg.method}` } });
    }
  }

  request(method, params, timeoutMs = 600000) {
    const id = this.nextId++;
    this.#send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  notify(method, params) { this.#send({ jsonrpc: "2.0", method, params }); }

  onUpdate(fn) { this.listeners.push(fn); }

  async initialize() {
    return this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "turnweft-m0-probe", version: "0.0.0" },
    }, 60000);
  }

  async close() {
    try { this.proc.stdin.end(); } catch {}
    const t = setTimeout(() => { try { this.proc.kill("SIGTERM"); } catch {} }, 3000);
    const r = await this.exited;
    clearTimeout(t);
    return r;
  }
}

// Collect assistant text emitted for one prompt.
export function textOf(updates) {
  return updates
    .filter((u) => u.update?.sessionUpdate === "agent_message_chunk" && u.update.content?.type === "text")
    .map((u) => u.update.content.text).join("");
}
