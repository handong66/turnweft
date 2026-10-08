// Minimal agy stand-in for adapter tests (not a test file): checks --effort the way agy 1.2.17 does, emits init,
// and answers each stream-json input line with the level it was launched with.
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const at = args.indexOf("--effort");
const effort = at >= 0 ? args[at + 1] : undefined;
if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) {
  process.stderr.write(`error: invalid model selection (--model "" --effort "${effort}"): invalid --effort "${effort}" (valid: low, medium, high, xhigh, max)\n`);
  process.exit(1);
}
const conversation = args.includes("--conversation") ? args[args.indexOf("--conversation") + 1] : "agy-new-conv";
process.stdout.write(`${JSON.stringify({ event: "init", conversation_id: conversation, init: { permission_mode: "request-review" } })}\n`);
createInterface({ input: process.stdin }).on("line", line => {
  const prompt = JSON.parse(line).message.content[0].text;
  if (prompt.startsWith("denied:")) {
    process.stdout.write(`${JSON.stringify({ event: "result", result: {
      status: prompt === "denied:cancelled" ? "CANCELLED" : "SUCCESS",
      response: prompt === "denied:empty" ? "" : "Review complete",
      denied_actions: [{ action: "command", display_name: "RunCommand" }],
    } })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ event: "result", result: { status: "SUCCESS", response: `effort=${effort ?? "default"}` } })}\n`);
});
