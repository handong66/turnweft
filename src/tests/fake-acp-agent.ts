// Minimal ACP agent for adapter tests (not a test file). FAKE_ACP_STYLE selects the thinking-level behaviour
// observed in live probes (U23):
//   dim       thought_level; values depend on the model; unknown values are rejected with invalidParams
//   droid     reasoning_effort; set answers {} and reports via config_option_update; unknown values are ignored
//   opencode  effort; a model switch resets it to "low"
//   legacy    reasoning_effort without a category
//   none      no thinking-level option
//   stubborn  like droid, but keeps its level even for offered values (read-back mismatch)
//   staleload loadSession answers with a level ("high") newer than the real one; replay then reports "auto"
//   vanish    model m2 has no thinking-level option at all
//   silent    set answers {} and never reports (no fresh read-back)
//   emptied   set answers with an empty option list
//   custom    the level is "think_depth" (category thought_level); "effort" is an unrelated option
// prompt replies with the real level, so tests can check what the agent actually runs with.
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, RequestError, ndJsonStream } from "@agentclientprotocol/sdk";

const style = process.env.FAKE_ACP_STYLE ?? "dim";
const effortId = style === "custom" ? "think_depth" : style === "dim" || style === "staleload" || style === "vanish" ? "thought_level" : style === "opencode" ? "effort" : "reasoning_effort";
const levels: Record<string, string[]> = effortId === "thought_level"
  ? { m1: ["auto", "none", "high", "max"], m2: ["auto", "high", "max"] }
  : { m1: ["low", "medium", "high", "xhigh"], m2: ["low", "high", "max"] };
const state: Record<string, string> = { model: "m1", [effortId]: effortId === "thought_level" ? "auto" : "high" };

const select = (id: string, category: string | undefined, values: string[]) => ({
  id, name: id, type: "select", currentValue: state[id], ...(category ? { category } : {}),
  options: values.map((value) => ({ value, name: value })),
});
let emptied = false;
state.effort ??= "on"; // the unrelated "effort" option of the custom style
const options = () => emptied ? [] : [
  select("model", "model", ["m1", "m2"]),
  ...(style === "custom" ? [select("effort", "other", ["on", "off", "low", "high"])] : []),
  ...(style === "none" || (style === "vanish" && state.model === "m2") ? [] : [select(effortId, style === "legacy" ? undefined : "thought_level", levels[state.model!]!)]),
];

const conn = new AgentSideConnection((c) => ({
  initialize: async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
  newSession: async () => ({ sessionId: "fake-acp-1", configOptions: options() }),
  loadSession: async () => {
    if (style !== "staleload") return { configOptions: options() };
    const answer = options().map((o) => (o.id === effortId ? { ...o, currentValue: "high" } : o));
    setTimeout(() => void c.sessionUpdate({ sessionId: "fake-acp-1", update: { sessionUpdate: "config_option_update", configOptions: options() } } as never), 50);
    return { configOptions: answer };
  },
  authenticate: async () => ({}),
  prompt: async () => {
    await c.sessionUpdate({ sessionId: "fake-acp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `level=${state[effortId] ?? "none"}` } } } as never);
    return { stopReason: "end_turn" };
  },
  cancel: async () => {},
  setSessionConfigOption: async (p: { configId: string; value: unknown }) => {
    const value = String(p.value);
    if (p.configId === "model") {
      state.model = value;
      if (style === "opencode") state[effortId] = "low";
    } else if (p.configId === effortId) {
      const ok = levels[state.model!]!.includes(value);
      if (!ok && style === "dim") throw RequestError.invalidParams({ configId: p.configId, value }, "Unknown ACP thought level value");
      if (ok && style !== "stubborn") state[effortId] = value;
    }
    if (style === "silent") return {} as never;
    if (style === "emptied") { emptied = true; return { configOptions: [] } as never; }
    if (style === "droid" || style === "stubborn") {
      setTimeout(() => void c.sessionUpdate({ sessionId: "fake-acp-1", update: { sessionUpdate: "config_option_update", configOptions: options() } } as never), 50);
      return {} as never;
    }
    return { configOptions: options() } as never;
  },
}) as never, ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>));
void conn;
