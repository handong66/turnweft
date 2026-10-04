// agy 1.2.x long-lived stream-json scenario (consumes model quota).
// Usage: node agy-scenario.mjs [extra agy flags...]   e.g. --mode accept-edits
// Input line format (found by probing the parser):
//   {"event":"user","message":{"content":[{"type":"text","text":"..."}]}}
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { M0, freshFixture, gitStatus, runTests } from "./agents.mjs";

const extra = process.argv.slice(2);
const tag = `agy${extra.length ? "-" + extra.join("_").replace(/[^\w.-]/g, "_") : ""}`;
const cwd = freshFixture(`scenario-${tag}`);
const logFile = join(M0, "results", `scenario-${tag}.jsonl`);
writeFileSync(logFile, "");
const token = "TW-" + randomBytes(3).toString("hex").toUpperCase();
const out = { agent: "agy", extra, cwd, token, steps: {} };
const save = () => writeFileSync(join(M0, "results", `scenario-${tag}.json`), JSON.stringify(out, null, 2));

class Agy {
  constructor(args) {
    this.events = [];
    this.waiters = [];
    this.stderr = "";
    this.proc = spawn("agy", ["--input-format", "stream-json", "--output-format", "stream-json", "--add-dir", cwd, ...args, "-p="],
      { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise((r) => this.proc.on("exit", (code, signal) => r({ code, signal })));
    let buf = "";
    this.proc.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        appendFileSync(logFile, line + "\n");
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        this.events.push(ev);
        if (ev.event === "result") { const w = this.waiters.shift(); if (w) w(ev); }
      }
    });
    this.proc.stderr.on("data", (d) => { this.stderr += d; appendFileSync(logFile, JSON.stringify({ stderr: String(d) }) + "\n"); });
  }
  turn(text, { interruptAfterMs } = {}) {
    const start = this.events.length;
    const t0 = Date.now();
    return new Promise((resolve) => {
      let timer;
      const done = (ev) => { clearTimeout(timer); clearTimeout(hard); resolve({ ms: Date.now() - t0, result: ev, events: this.events.slice(start) }); };
      this.waiters.push(done);
      const hard = setTimeout(() => done({ timeout: true }), 900000);
      if (interruptAfterMs) timer = setTimeout(() => this.proc.kill("SIGINT"), interruptAfterMs);
      this.exited.then((x) => done({ exited: x }));
      this.proc.stdin.write(JSON.stringify({ event: "user", message: { content: [{ type: "text", text }] } }) + "\n");
    });
  }
  async close() {
    this.proc.stdin.end();
    const t = setTimeout(() => this.proc.kill("SIGTERM"), 15000);
    const r = await this.exited; clearTimeout(t); return r;
  }
}

function summarize(label, r) {
  const evs = r.events ?? [];
  const kinds = {};
  for (const e of evs) kinds[e.event] = (kinds[e.event] ?? 0) + 1;
  out.steps[label] = {
    ms: r.ms,
    status: r.result?.result?.status ?? r.result,
    response: (r.result?.result?.response ?? "").slice(-1200),
    error: r.result?.result?.error,
    conversationId: r.result?.result?.conversation_id,
    eventKinds: kinds,
  };
  save();
}

let a = new Agy(extra);
summarize("turn1_implement", await a.turn(
  `Remember this token for later: ${token}. Now fix the bugs in src/math.js so that \`npm test\` passes, ` +
  `then run \`npm test\` to confirm. Keep the reply to two sentences.`));
out.init = a.events.find((e) => e.event === "init");
out.conversationId = out.init?.conversation_id;
out.afterTurn1 = { git: gitStatus(cwd), tests: runTests(cwd) };
save();
summarize("turn2_recall_L1", await a.turn("What token did I ask you to remember? Reply with the token only."));
out.closeExit = await a.close();

a = new Agy([...extra, "--conversation", out.conversationId]);
summarize("turn3_recall_L2", await a.turn("What token did I ask you to remember earlier in this conversation? Reply with the token only."));
out.resumedConversationId = a.events.find((e) => e.event === "init")?.conversation_id;
summarize("turn4_interrupt", await a.turn("Run the shell command `sleep 45 && echo slept` and then tell me what it printed.", { interruptAfterMs: 12000 }));
out.afterInterrupt = { git: gitStatus(cwd), exit: await Promise.race([a.exited, new Promise((r) => setTimeout(() => r("still-running"), 5000))]) };
if (out.afterInterrupt.exit === "still-running") {
  // Is the process still usable after an interrupt?
  summarize("turn5_after_interrupt", await a.turn("Reply with the word ok only."));
}
out.finalExit = await a.close();
out.stderrTail = a.stderr.slice(-600);
save();

const s = out.steps;
console.log(JSON.stringify({
  extra, token, conversationId: out.conversationId, permissionMode: out.init?.init?.permission_mode,
  t1: { status: s.turn1_implement?.status, ms: s.turn1_implement?.ms, error: s.turn1_implement?.error, resp: s.turn1_implement?.response?.slice(-200) },
  afterTurn1: out.afterTurn1,
  L1: s.turn2_recall_L1?.response?.trim().slice(-80),
  L2: { resp: s.turn3_recall_L2?.response?.trim().slice(-80), sameId: out.resumedConversationId === out.conversationId, resumedId: out.resumedConversationId },
  interrupt: { status: s.turn4_interrupt?.status, ms: s.turn4_interrupt?.ms, after: out.afterInterrupt, t5: s.turn5_after_interrupt?.status },
}, null, 2));
