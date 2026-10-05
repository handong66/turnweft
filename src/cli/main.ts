#!/usr/bin/env node
import { text } from "../core/i18n.js";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { TurnweftService } from "../core/service.js";
import { PROVIDERS } from "../core/types.js";
import type { Envelope, HostBinding, Intent, ProviderId } from "../core/types.js";
import { boundedWait, confirmationRequired, startMcpServer } from "../mcp/server.js";
import { failure, serviceFailure, success } from "../mcp/envelope.js";
import { macosConfirm, spawnDialogHelper, type NativeConfirm } from "../mcp/native-dialog.js";
import { ownerToken, stopAndConfirm } from "../runtime/proc.js";
import { createService } from "../runtime/factory.js";

export interface CliIO {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable;
}

const options = {
  json: { type: "boolean" }, help: { type: "boolean", short: "h" },
  agent: { type: "string" }, cwd: { type: "string" }, name: { type: "string" }, model: { type: "string" },
  session: { type: "string" }, intent: { type: "string" }, "prompt-file": { type: "string" }, "request-id": { type: "string" },
  policy: { type: "string" }, "include-closed": { type: "boolean" }, refresh: { type: "boolean" },
  "wait-ms": { type: "string" }, "after-seq": { type: "string" }, "include-result": { type: "boolean" },
  "result-offset": { type: "string" }, "result-limit": { type: "string" },
} as const;

function human(data: unknown): string {
  if (Array.isArray(data)) return data.length ? data.map(human).join("\n") : text("noEntries");
  if (data && typeof data === "object") {
    const value = data as Record<string, unknown>;
    if ("job" in value) {
      const job = value.job as { id: string; state: string };
      const result = value.result as { finalText?: string } | undefined;
      return `${text("jobSummary", { id: job.id, state: job.state, next: String(value.nextAction ?? "none") })}${result?.finalText ? `\n${result.finalText}` : ""}`;
    }
    if (value.kind === "needs_confirmation") return text("needsConfirmation");
  }
  return typeof data === "string" ? data : JSON.stringify(data);
}

function output(io: CliIO, envelope: Envelope<unknown>, json: boolean): number {
  if (json) io.stdout.write(`${JSON.stringify(envelope)}\n`);
  else {
    (envelope.ok ? io.stdout : io.stderr).write(`${envelope.ok ? human(envelope.data) : `${envelope.error?.code}: ${envelope.error?.message}`}\n`);
    for (const warning of envelope.warnings) io.stderr.write(`${warning}\n`);
  }
  return envelope.ok ? 0 : 1;
}

/**
 * Detached helper started by the MCP server (U19): shows the macOS dialog for one proposal and applies the
 * human's choice. Allow confirms (waiting jobs start), Deny rejects (they are cancelled); closing it or expiry
 * changes nothing. Ownership is recorded on the proposal with a pid+start-time token, so only one live dialog
 * exists per proposal; the dialog closes itself when the proposal is decided elsewhere (round 5, 7/8).
 */
export async function runDialog(service: TurnweftService, proposalId: string, io: Pick<CliIO, "stderr">,
  confirm: NativeConfirm = macosConfirm, pollMs = 2000): Promise<number> {
  const logLine = (msg: string) => {
    try {
      const dir = join(process.env.TURNWEFT_HOME ?? join(homedir(), ".turnweft"), "logs");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(join(dir, "dialog.log"), `${new Date().toISOString()} ${proposalId} ${msg}\n`, { mode: 0o600 });
    } catch { /* diagnostics only */ }
    io.stderr.write(`dialog ${proposalId}: ${msg}\n`);
  };
  const proposal = await service.getProposal(proposalId);
  if (!proposal) { logLine("proposal not found"); return 1; }
  if (proposal.decision) { logLine(`already ${proposal.decision}`); return 0; }
  if (proposal.waitingJobs === 0) { logLine("no job is waiting for it"); return 0; }
  const remaining = Date.parse(proposal.expiresAt) - Date.now();
  if (remaining <= 0) { logLine("expired"); return 0; }
  const token = ownerToken();
  if (!(await service.claimConfirmationDialog(proposalId, token))) { logLine("another live dialog owns it"); return 0; }
  const controller = new AbortController();
  let child: { pid: number; token: string } | undefined;
  const watch = setInterval(async () => {
    // Close when decided elsewhere, or when no job waits for it any more (cancelled / session closed) (round 6, 4).
    try { const p = await service.getProposal(proposalId); if (!p || p.decision || p.waitingJobs === 0) controller.abort(); } catch { /* keep the dialog */ }
  }, pollMs);
  try {
    const r = await confirm(proposal, remaining, controller.signal, (pid) => {
      child = { pid, token: ownerToken(pid) };
      // If a successor could not learn about this dialog, do not keep it on screen (round 7, 2).
      void service.recordConfirmationDialogChild(proposalId, token, pid).catch((e) => {
        logLine(`could not record the dialog process: ${(e as Error).message}; closing it`);
        controller.abort();
      });
    });
    if (r.accepted) await service.confirmPolicy({ proposalId, nonce: proposal.nonce, via: "native-dialog" });
    else if (r.detail === "denied in dialog") await service.rejectPolicy({ proposalId, nonce: proposal.nonce, via: "native-dialog" });
    logLine(r.detail);
    return 0;
  } catch (e) {
    logLine(`error: ${(e as Error).message}`); // e.g. decided in a terminal at the same moment
    return 1;
  } finally {
    clearInterval(watch);
    // An abort can report back before the dialog process exits: release only once it is confirmed gone;
    // otherwise keep the record so a successor must stop it first (round 7, 2).
    if (child && !(await stopAndConfirm(child.pid, child.token))) logLine("dialog process not confirmed stopped; keeping its record");
    else await service.releaseConfirmationDialog(proposalId, token).catch(() => {});
  }
}

/**
 * Host integrations the real CLI entry enables; tests run without them (no dialogs). The CLI never takes a host
 * bypass signal (U21): its environment can be set by whoever runs it, so a confirmation is always asked (round 11, 2).
 */
export interface CliHooks {
  /** U19: show the macOS confirmation dialog for a waiting job, as the MCP path does. */
  showDialog?: (proposalId: string) => boolean;
}

export async function runCli(
  argv: string[],
  serviceOrFactory: TurnweftService | (() => Promise<TurnweftService>) = createService,
  io: CliIO = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
  hooks: CliHooks = {},
): Promise<number> {
  let json = argv.includes("--json");
  let command: string | undefined;
  try {
    const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    json = values.json ?? false;
    command = positionals[0];
    if (values.help || !command) return output(io, success(text("usage")), json);
    const action = positionals[1];
    const id = positionals[2];
    const only = (keys: string[], count: number) => {
      if (positionals.length !== count) throw new Error("Missing or unexpected positional arguments; use --help");
      for (const key of Object.keys(values)) {
        if (!["json", ...keys].includes(key)) throw new Error(`Option --${key} is not valid for this command`);
      }
    };
    const required = (value: string | undefined, label: string): string => {
      if (!value?.trim()) throw new Error(`${label} is required`);
      return value;
    };
    const agent = (): ProviderId | undefined => {
      if (values.agent !== undefined && !PROVIDERS.includes(values.agent as ProviderId)) throw new Error("Invalid --agent");
      return values.agent as ProviderId | undefined;
    };
    const number = (value: string | undefined, label: string, minimum = 0): number | undefined => {
      if (value === undefined) return undefined;
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) throw new Error(`Invalid ${label}`);
      return Number(value);
    };
    // Validate before constructing the runtime or reading a proposal.
    switch (command) {
      case "mcp": only([], 1); break;
      case "dialog": only([], 2); required(action, "proposalId"); break;
      case "doctor": only(["refresh"], 1); break;
      case "agents": if (action !== "list") throw new Error("Expected agents list"); only(["refresh"], 2); break;
      case "session":
        switch (action) {
          case "create": only(["agent", "cwd", "name", "model"], 2); required(agent(), "--agent"); required(values.cwd, "--cwd"); break;
          case "list": only(["cwd", "agent", "include-closed"], 2); agent(); break;
          case "get": case "attach": only([], 3); required(id, "sessionId"); break;
          case "close": only(["policy"], 3); required(id, "sessionId"); if (values.policy !== undefined && !["reject_if_busy", "cancel_running"].includes(values.policy)) throw new Error("Invalid --policy"); break;
          default: throw new Error("Invalid session action");
        }
        break;
      case "send":
        only(["session", "intent", "prompt-file", "request-id"], 1);
        required(values.session, "--session");
        if (values.intent !== undefined && !["analyze", "implement"].includes(values.intent)) throw new Error("Invalid --intent");
        if (values["request-id"] !== undefined) required(values["request-id"], "--request-id");
        if (values["prompt-file"] !== undefined) required(values["prompt-file"], "--prompt-file");
        break;
      case "job":
        only(["wait-ms", "after-seq", "include-result", "result-offset", "result-limit"], 3);
        if (!["status", "wait", "result"].includes(action ?? "")) throw new Error("Expected job status|wait|result");
        required(id, "jobId");
        number(values["wait-ms"], "--wait-ms"); number(values["after-seq"], "--after-seq");
        number(values["result-offset"], "--result-offset"); number(values["result-limit"], "--result-limit", 1);
        break;
      case "cancel": only([], 2); required(action, "jobId"); break;
      case "policy":
        if (action === "list") { only(["cwd", "agent"], 2); agent(); }
        else if (action === "revoke" || action === "grant") { only([], 3); required(id, "policy/proposal ID"); }
        else throw new Error("Expected policy list|revoke|grant");
        if (action === "grant" && (!io.stdin.isTTY || !io.stdout.isTTY)) return output(io, failure("tty_required", "policy grant requires stdin and stdout to be TTY; open a terminal and type yes manually"), json);
        break;
      default: throw new Error(`Unknown command: ${command}`);
    }
    const service = typeof serviceOrFactory === "function" ? await serviceOrFactory() : serviceOrFactory;
    const host: HostBinding = { hostKind: "cli", connectionId: "cli" };
    let envelope: Envelope<unknown>;
    switch (command) {
      case "mcp": await startMcpServer(service); return 0;
      case "dialog": return await runDialog(service, action!, io);
      case "doctor": case "agents": envelope = success(await service.listAgents({ refresh: values.refresh })); break;
      case "session":
        switch (action) {
          case "create": envelope = success(await service.createSession({ provider: agent()!, cwd: values.cwd!, name: values.name, model: values.model, host })); break;
          case "list": envelope = success(await service.listSessions({ canonicalRoot: values.cwd, provider: agent(), includeClosed: values["include-closed"] })); break;
          case "get": {
            const session = await service.getSession(id!);
            envelope = session ? success(session) : failure("session_not_found", `Session not found: ${id}`); break;
          }
          case "attach": envelope = success(await service.attachSession(id!, host)); break;
          case "close": envelope = success(await service.closeSession(id!, values.policy as "reject_if_busy" | "cancel_running" | undefined)); break;
          default: throw new Error("Invalid session action");
        }
        break;
      case "send": {
        const requestId = values["request-id"] ?? randomUUID();
        if (values["request-id"] === undefined) io.stderr.write(`requestId: ${requestId}\n`);
        const chunks: Buffer[] = [];
        let prompt: string;
        if (values["prompt-file"] !== undefined) prompt = await readFile(values["prompt-file"], "utf8");
        else { for await (const chunk of io.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); prompt = Buffer.concat(chunks).toString("utf8"); }
        required(prompt, "prompt");
        const outcome = await service.submitTurn({ sessionId: values.session!, prompt, requestId, intent: (values.intent ?? "analyze") as Intent, host });
        if (outcome.kind === "awaiting_confirmation") hooks.showDialog?.(outcome.proposal.proposalId);
        envelope = outcome.kind === "accepted" ? success({ ...outcome, requestId, jobId: outcome.job.id, nextAction: "wait" })
          : outcome.kind === "awaiting_confirmation" ? success({ kind: "awaiting_confirmation", requestId, jobId: outcome.job.id, nextAction: "wait" },
              [text("waitingJob", { id: outcome.job.id, proposal: outcome.proposal.proposalId })])
          : outcome.kind === "needs_confirmation" ? success({ ...confirmationRequired(outcome.proposal).data, requestId }, confirmationRequired(outcome.proposal).warnings)
          : { ...failure(outcome.code, outcome.message), error: { code: outcome.code, message: outcome.message, details: { requestId } } };
        break;
      }
      case "job": envelope = success(await service.getJob({ jobId: id!, waitMs: boundedWait(number(values["wait-ms"], "--wait-ms") ?? (action === "wait" ? 25_000 : 0)), afterSeq: number(values["after-seq"], "--after-seq"), includeResult: values["include-result"] ?? action === "result", resultOffset: number(values["result-offset"], "--result-offset"), resultLimit: number(values["result-limit"], "--result-limit", 1) })); break;
      case "cancel": envelope = success(await service.cancelJob(action!)); break;
      case "policy":
        if (action === "list") envelope = success(await service.listPolicies({ canonicalRoot: values.cwd, provider: agent() }));
        else if (action === "revoke") envelope = success(await service.revokePolicy(id!));
        else {
          const proposal = await service.getProposal(id!);
          if (!proposal) return output(io, failure("proposal_not_found", `Proposal not found: ${id}`), json);
          // With --json, stdout still contains exactly one Envelope; the trusted prompt is on stderr.
          const terminal = json ? io.stderr : io.stdout;
          terminal.write(`${proposal.message}\n\n${text("grantDetails", {
            provider: proposal.provider, root: proposal.canonicalRoot, intent: proposal.intent, tier: proposal.tier,
            excess: proposal.excessOverGrant.length ? proposal.excessOverGrant.map(operation => `  - ${operation}`).join("\n") : text("none"),
            expires: proposal.expiresAt, id: proposal.proposalId, version: proposal.cliVersion,
            adapter: proposal.adapterVersion, digest: proposal.capabilityDigest,
          })}`);
          const reader = createInterface({ input: io.stdin, output: terminal, terminal: false });
          const controller = new AbortController();
          reader.once("close", () => controller.abort());
          let answer: string;
          try { answer = await reader.question(text("grantPrompt"), { signal: controller.signal }); }
          catch { return output(io, failure("confirmation_cancelled", text("cancelled")), json); }
          finally { reader.close(); }
          if (answer === "yes") {
            const policy = await service.confirmPolicy({ proposalId: proposal.proposalId, nonce: proposal.nonce, via: "cli-tty" });
            envelope = success(json ? policy : text("confirmed", { provider: policy.provider, intent: policy.intent, tier: policy.tier, root: policy.canonicalRoot, id: policy.id }));
          } else if (answer === "no") {
            // Explicit denial: jobs waiting on this proposal are cancelled (U19).
            await service.rejectPolicy({ proposalId: proposal.proposalId, nonce: proposal.nonce, via: "cli-tty" });
            envelope = failure("confirmation_denied", text("denied"));
          } else envelope = failure("confirmation_declined", text("declined"));
        }
        break;
      default: throw new Error("Unknown command");
    }
    return output(io, envelope, json);
  } catch (error) {
    const envelope = error instanceof Error && (error.name === "TypeError" || /required|Invalid|Expected|Unknown command|Option|arguments/.test(error.message))
      ? failure("invalid_arguments", error.message) : serviceFailure(error);
    if (command === "mcp") { io.stderr.write(`${JSON.stringify(envelope)}\n`); return 1; }
    return output(io, envelope, json);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await runCli(process.argv.slice(2), createService, undefined, {
    showDialog: (id) => spawnDialogHelper(id, fileURLToPath(import.meta.url)),
  });
}
