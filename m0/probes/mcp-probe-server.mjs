#!/usr/bin/env node
// Turnweft M0 host probe: a model-free stdio MCP server (raw JSON-RPC, no SDK).
// Records what the host sends and how it treats elicitation, long calls and lifecycle.
// Log: $TW_PROBE_LOG (default m0/results/mcp-probe-<pid>.jsonl)
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LOG = process.env.TW_PROBE_LOG ?? join(dirname(fileURLToPath(import.meta.url)), "..", "results", `mcp-probe-${process.pid}.jsonl`);
const log = (kind, data) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ppid: process.ppid, kind, data }) + "\n");
log("start", { argv: process.argv.slice(2), cwd: process.cwd(), envKeys: Object.keys(process.env).filter((k) => /^(CLAUDE|CODEX|MCP|TERM_PROGRAM)/.test(k)) });
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { log("signal", sig); process.exit(0); });
process.on("exit", (code) => log("exit", { code }));
process.stdin.on("end", () => log("stdin-end", {}));

let clientCaps = {};
let nextId = 1000;
const pendingOut = new Map();
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pendingOut.set(id, resolve);
  send({ jsonrpc: "2.0", id, method, params });
});

const tools = [
  { name: "tw_probe_echo", description: "Turnweft probe (read-only): echoes the arguments and request metadata the host sent. Safe to call.",
    inputSchema: { type: "object", properties: { note: { type: "string" } } } },
  { name: "tw_probe_delegate", description: "Turnweft probe for an implement-intent tool. Does nothing except record the call. Safe to call.",
    inputSchema: { type: "object", properties: { project: { type: "string" }, provider: { type: "string" } } } },
  { name: "tw_probe_elicit", description: "Turnweft probe: asks the human (via MCP elicitation) to confirm a sample permission tier, and returns their answer. Safe to call.",
    inputSchema: { type: "object", properties: {} } },
  { name: "tw_probe_sleep", description: "Turnweft probe: waits the given number of seconds, then returns. Used to measure host tool-call timeouts. Safe to call.",
    inputSchema: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] } },
];

async function callTool(name, args, meta) {
  if (name === "tw_probe_echo" || name === "tw_probe_delegate") {
    return { content: [{ type: "text", text: JSON.stringify({ tool: name, args, meta, clientCaps }) }] };
  }
  if (name === "tw_probe_elicit") {
    if (!clientCaps.elicitation) return { content: [{ type: "text", text: "client did not declare elicitation capability: " + JSON.stringify(clientCaps) }] };
    const t0 = Date.now();
    const res = await Promise.race([
      request("elicitation/create", {
        mode: "form",
        message: "Turnweft probe: allow provider 'droid' to use tier 'auto-medium' in project '/tmp/tw-probe'? (extra over grant: local git commit, trusted network). This is only a test; nothing will run.",
        requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Allow this tier" } }, required: ["confirm"] },
      }),
      new Promise((r) => setTimeout(() => r({ timeoutAfterMs: 240000 }), 240000)),
    ]);
    log("elicit-result", { ms: Date.now() - t0, res });
    return { content: [{ type: "text", text: JSON.stringify({ elicitation: res, ms: Date.now() - t0 }) }] };
  }
  if (name === "tw_probe_sleep") {
    const s = Math.min(Number(args?.seconds ?? 1), 1800);
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, s * 1000));
    log("sleep-done", { requested: s, ms: Date.now() - t0 });
    return { content: [{ type: "text", text: `slept ${s}s` }] };
  }
  return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
}

let buf = "";
process.stdin.on("data", async (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { log("bad-line", line); continue; }
    log("in", msg);
    if (msg.id !== undefined && !msg.method) { const r = pendingOut.get(msg.id); if (r) { pendingOut.delete(msg.id); r(msg.result ?? { error: msg.error }); } continue; }
    if (msg.method === "initialize") {
      clientCaps = msg.params?.capabilities ?? {};
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tw-probe", version: "0.0.0" } } });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    } else if (msg.method === "tools/call") {
      const t0 = Date.now();
      const result = await callTool(msg.params?.name, msg.params?.arguments, msg.params?._meta);
      log("call-done", { name: msg.params?.name, ms: Date.now() - t0 });
      send({ jsonrpc: "2.0", id: msg.id, result });
    } else if (msg.method === "notifications/cancelled") {
      log("cancelled", msg.params);
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});
