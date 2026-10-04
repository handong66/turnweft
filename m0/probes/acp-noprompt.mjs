// No-prompt ACP probe: initialize, session/new, unknown-ID load/resume, list.
// Does not send session/prompt, so no model call is made.
// Usage: node acp-noprompt.mjs <dim|grok|opencode|droid>
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AcpClient } from "./acp-client.mjs";
import { ACP_AGENTS, M0, freshFixture } from "./agents.mjs";

const name = process.argv[2];
const spec = ACP_AGENTS[name];
const cwd = freshFixture(`noprompt-${name}`);
const logFile = join(M0, "results", `noprompt-${name}.jsonl`);
writeFileSync(logFile, "");
const c = new AcpClient({ ...spec, cwd, logFile });
const out = { agent: name, cwd };
const step = async (key, fn) => {
  try { out[key] = await fn(); } catch (e) { out[key] = { error: e.message, rpc: e.rpc }; }
};

await step("initialize", () => c.initialize());
await step("sessionNew", () => c.request("session/new", { cwd, mcpServers: [] }, 120000));
const unknown = randomUUID();
await step("loadUnknown", () => c.request("session/load", { sessionId: unknown, cwd, mcpServers: [] }, 60000));
await step("resumeUnknown", () => c.request("session/resume", { sessionId: unknown, cwd, mcpServers: [] }, 60000));
await step("list", () => c.request("session/list", { cwd }, 60000));
out.exit = await c.close();
out.stderrTail = c.stderr.slice(-800);
writeFileSync(join(M0, "results", `noprompt-${name}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2).slice(0, 6000));
