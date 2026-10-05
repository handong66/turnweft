import { createRequire } from "node:module";
import { text } from "../core/i18n.js";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import type { CreateSessionInput, SubmitTurnInput, TurnweftService } from "../core/service.js";
import { PROVIDERS } from "../core/types.js";
import type { Envelope, HostBinding, PolicyProposal, ProviderId } from "../core/types.js";
import { failure, serviceFailure, success } from "./envelope.js";
import { spawnDialogHelper } from "./native-dialog.js";
import { hostBypass, pruneHookRecords, type CallContext } from "../runtime/host-mode.js";
import { dirname as pathDirname } from "node:path";
import { fileURLToPath } from "node:url";

// One source of truth for the version: dist/mcp/server.js and dist-test/mcp/server.js both sit two levels below package.json.
const PACKAGE_VERSION: string = createRequire(import.meta.url)("../../package.json").version;

export interface McpServerOptions {
  connectionId?: string;
  maxWaitMs?: number;
  hostToolTimeoutMs?: number;
  elicitationTimeoutMs?: number;
  onDiagnostic?: (info: { sandbox_mode?: unknown; workspaces?: unknown }) => void;
  /** Second U11 channel (U19): start the detached dialog helper for a proposal. startMcpServer enables the macOS one. */
  showDialog?: (proposalId: string) => boolean;
  /** U21: read the host's own bypass signal for a submission. startMcpServer enables the real detector. */
  hostBypass?: (host: HostBinding, meta: Record<string, unknown> | undefined, call: CallContext) => string | undefined;
}

export type SessionAction =
  | ({ action: "create" } & Omit<CreateSessionInput, "host">)
  | { action: "list"; scope?: "this_host" | "project"; canonicalRoot?: string; provider?: ProviderId; includeClosed?: boolean }
  | { action: "get" | "attach"; sessionId: string }
  | { action: "close"; sessionId: string; policy?: "reject_if_busy" | "cancel_running" };

const string = { type: "string", minLength: 1 } as const;
const boolean = { type: "boolean" } as const;
const integer = { type: "integer", minimum: 0 } as const;
const provider = { type: "string", enum: [...PROVIDERS] } as const;
const object = (properties: Record<string, JsonSchemaType>, required: string[] = []): Tool["inputSchema"] =>
  ({ type: "object", properties, required, additionalProperties: false });
const sessionSchema: Tool["inputSchema"] = {
  type: "object",
  oneOf: [
    object({ action: { const: "create" }, provider, cwd: string, name: string, model: string }, ["action", "provider", "cwd"]),
    {
      ...object({ action: { const: "list" }, scope: { enum: ["this_host", "project"] }, canonicalRoot: string, provider, includeClosed: boolean }, ["action"]),
      allOf: [{ if: { properties: { scope: { const: "project" } }, required: ["scope"] }, then: { required: ["canonicalRoot"] } }],
    },
    ...["get", "attach"].map(action => object({ action: { const: action }, sessionId: string }, ["action", "sessionId"])),
    object({ action: { const: "close" }, sessionId: string, policy: { enum: ["reject_if_busy", "cancel_running"] } }, ["action", "sessionId"]),
  ],
};
const turnSchema = object({ sessionId: string, prompt: string, requestId: string }, ["sessionId", "prompt", "requestId"]);
const tools: Tool[] = [
  { name: "turnweft_agents", description: "List targets, versions, capabilities and problems; does not submit a model task.", inputSchema: object({ refresh: boolean }), annotations: { readOnlyHint: true } },
  { name: "turnweft_session", description: "Create/list/get/attach/close an exact session. Names are labels, not resume handles. List scope defaults to this_host; project requires canonicalRoot and finds sessions across hosts before explicit attach.", inputSchema: sessionSchema },
  { name: "turnweft_ask", description: "Submit analyze intent in the background. Generate and save requestId before calling; reuse it for retries. If the result is awaiting_confirmation, keep calling turnweft_job in the same turn until the job starts (up to ~10 minutes); never resubmit.", inputSchema: turnSchema },
  { name: "turnweft_delegate", description: "Submit implement intent in the background, with human U11 confirmation when required. Save requestId before calling. If the result is awaiting_confirmation, a Turnweft dialog is waiting for the user: keep calling turnweft_job (waitMs 25000, afterSeq = previous nextSeq) in the same turn until the job leaves waiting_confirmation (up to ~10 minutes); never resubmit.", inputSchema: turnSchema },
  { name: "turnweft_job", description: "Read job state, events and paged results. Defaults to immediate return; waits are bounded. ok describes the query, not job success.", inputSchema: object({ jobId: string, afterSeq: integer, waitMs: integer, includeResult: boolean, resultOffset: integer, resultLimit: { type: "integer", minimum: 1 } }, ["jobId"]), annotations: { readOnlyHint: true } },
  { name: "turnweft_cancel", description: "Request cancellation of an exact job; the returned state determines whether it has stopped.", inputSchema: object({ jobId: string }, ["jobId"]) },
];

export function hostBinding(meta: Record<string, unknown> | undefined, clientName: string | undefined, connectionId: string): HostBinding {
  const turn = meta?.["x-codex-turn-metadata"];
  if (turn && typeof turn === "object" && "thread_id" in turn && typeof turn.thread_id === "string" && turn.thread_id.trim()) {
    return { hostKind: "codex", conversationId: turn.thread_id };
  }
  const claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  // Pending live verification: this variable may be inherited; use it only for session binding.
  if (clientName === "claude-code" && claudeSessionId?.trim()) {
    return { hostKind: "claude-code", conversationId: claudeSessionId };
  }
  const hostKind = /codex/i.test(clientName ?? "") ? "codex" : /claude|\bcc\b/i.test(clientName ?? "") ? "claude-code" : "cli";
  return { hostKind, connectionId };
}

export function boundedWait(waitMs = 0, opts: McpServerOptions = {}): number {
  const timeout = opts.hostToolTimeoutMs ?? 30_000;
  const max = opts.maxWaitMs ?? 25_000;
  if (!Number.isInteger(timeout) || timeout < 2 || !Number.isInteger(max) || max < 0) {
    throw new Error("Timeout must be an integer >= 2 ms; maxWaitMs must be a nonnegative integer");
  }
  return Math.min(waitMs, max, 25_000, timeout - 1);
}

/** The nonce is internal to core and the human confirmation channel; the model never sees it (live CC test). */
function publicProposal(proposal: PolicyProposal): Omit<PolicyProposal, "nonce"> {
  const { nonce: _nonce, ...rest } = proposal;
  return rest;
}

/** Append one diagnostic line about the confirmation channel to ~/.turnweft/logs/mcp.log (best effort). */
function logConfirmation(entry: Record<string, unknown>) {
  try {
    const dir = join(process.env.TURNWEFT_HOME ?? join(homedir(), ".turnweft"), "logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, "mcp.log"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch { /* diagnostics never affect the call */ }
}

/** Our own field: accept + confirm:true allows, accept + confirm:false is an explicit denial; anything else is ambiguous. */
const confirmSchema = () => ({
  type: "object" as const,
  properties: { confirm: { type: "boolean" as const, title: text("confirmTitle") } },
  required: ["confirm"],
});

export function confirmationRequired(proposal: PolicyProposal, reason?: string) {
  return success({ kind: "needs_confirmation" as const, proposal: publicProposal(proposal), nextAction: "confirm_policy" as const }, [
    ...(reason ? [reason] : []),
    `Ask the user to run turnweft policy grant ${proposal.proposalId} in a terminal, then resubmit with the same requestId.`,
  ]);
}

function toolResult(envelope: Envelope<unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: { ...envelope }, isError: !envelope.ok };
}

export function createMcpServer(service: TurnweftService, opts: McpServerOptions = {}): Server {
  const connectionId = opts.connectionId ?? randomUUID();
  boundedWait(0, opts);
  const requestedTimeout = opts.elicitationTimeoutMs ?? 25_000;
  if (!Number.isInteger(requestedTimeout) || requestedTimeout < 1) throw new Error("elicitationTimeoutMs must be a positive integer");
  const elicitationTimeout = Math.min(requestedTimeout, (opts.hostToolTimeoutMs ?? 30_000) - 1);
  const server = new Server({ name: "turnweft", version: PACKAGE_VERSION }, { capabilities: { tools: {} } });
  const validator = new AjvJsonSchemaValidator();
  const validators = new Map(tools.map(tool => [tool.name, validator.getValidator<Record<string, unknown>>(tool.inputSchema)]));
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const validate = validators.get(request.params.name);
    if (!validate) return toolResult(failure("unknown_tool", `Unknown tool: ${request.params.name}`));
    const args = validate(request.params.arguments ?? {});
    if (!args.valid) return toolResult(failure("invalid_arguments", args.errorMessage));
    const input = args.data;
    const host = hostBinding(request.params._meta, server.getClientVersion()?.name, connectionId);
    try {
      const meta = request.params._meta?.["x-codex-turn-metadata"];
      if (meta && typeof meta === "object") {
        // Host workspace claims are diagnostic only; they never become grants.
        try { opts.onDiagnostic?.({ sandbox_mode: "sandbox_mode" in meta ? meta.sandbox_mode : undefined, workspaces: "workspaces" in meta ? meta.workspaces : undefined }); } catch { /* Diagnostics cannot change authorization. */ }
      }
      let envelope: Envelope<unknown>;
      switch (request.params.name) {
        case "turnweft_agents": envelope = success(await service.listAgents(input)); break;
        case "turnweft_session": {
          const action = input as SessionAction;
          switch (action.action) {
            case "create": {
              const { action: _, ...fields } = action;
              envelope = success(await service.createSession({ ...fields, host })); break;
            }
            case "list": {
              const { action: _, scope = "this_host", ...filter } = action;
              envelope = success(await service.listSessions(scope === "project" ? filter : { ...filter, host })); break;
            }
            case "get": {
              const session = await service.getSession(action.sessionId);
              envelope = session ? success(session) : failure("session_not_found", `Session not found: ${action.sessionId}`); break;
            }
            case "attach": envelope = success(await service.attachSession(action.sessionId, host)); break;
            case "close": envelope = success(await service.closeSession(action.sessionId, action.policy)); break;
          }
          break;
        }
        case "turnweft_ask":
        case "turnweft_delegate": {
          let bypass: string | undefined;
          try { bypass = opts.hostBypass?.(host, request.params._meta, { toolName: request.params.name, requestId: String((input as { requestId?: unknown }).requestId ?? "") }); }
          catch { bypass = undefined; } // unreadable: ask as usual
          const turn: SubmitTurnInput = { ...(input as Pick<SubmitTurnInput, "sessionId" | "prompt" | "requestId">), host, intent: request.params.name === "turnweft_ask" ? "analyze" : "implement", ...(bypass ? { hostBypass: bypass } : {}) };
          let outcome = await service.submitTurn(turn);
          if (outcome.kind === "needs_confirmation") {
            const proposal = outcome.proposal;
            const client = server.getClientVersion();
            const caps = server.getClientCapabilities()?.elicitation;
            const started = Date.now();
            const reasons: string[] = [];
            let via: "elicitation" | "native-dialog" | undefined;
            // Channel 1: MCP elicitation shown by the host.
            if (caps?.form && !extra.signal.aborted) {
              try {
                const response = await server.elicitInput({ mode: "form", message: proposal.message, requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: text("confirmTitle") } }, required: ["confirm"] } }, { timeout: elicitationTimeout, signal: extra.signal, relatedRequestId: extra.requestId });
                const ok = response.action === "accept" && response.content?.confirm === true && !extra.signal.aborted;
                logConfirmation({ client, caps, channel: "elicitation", proposalId: proposal.proposalId, outcome: response.action, confirm: response.content?.confirm, ms: Date.now() - started });
                if (ok) via = "elicitation";
                else if (extra.signal.aborted) reasons.push("The caller cancelled the request");
                else reasons.push(`Host elicitation returned ${response.action}${response.action === "accept" ? " (confirmation unchecked)" : ""}, after ${Date.now() - started} ms`);
              } catch (error) {
                logConfirmation({ client, caps, channel: "elicitation", proposalId: proposal.proposalId, outcome: "error", error: String((error as Error)?.message ?? error), ms: Date.now() - started });
                reasons.push(`Host elicitation failed or timed out (${String((error as Error)?.message ?? error).slice(0, 120)})`);
              }
            } else {
              reasons.push(extra.signal.aborted ? "The caller cancelled the request" : "The host did not advertise MCP elicitation form support");
            }
            // Channel 3: the terminal (`turnweft policy grant`), reported back to the caller.
            if (!via) return toolResult(confirmationRequired(proposal, `${reasons.join("; ")}; no task was started.`));
            await service.confirmPolicy({ proposalId: proposal.proposalId, nonce: proposal.nonce, via });
            if (extra.signal.aborted) return toolResult(confirmationRequired(proposal, "Request cancelled; the task was not resubmitted."));
            outcome = await service.submitTurn(turn);
          }
          if (outcome.kind === "awaiting_confirmation") {
            // U19: the job is recorded and waits; it starts by itself once the human confirms.
            const proposal = outcome.proposal;
            const client = server.getClientVersion();
            const caps = server.getClientCapabilities()?.elicitation;
            const reasons: string[] = [];
            let confirmedNow = false;
            if (caps?.form && !extra.signal.aborted) {
              const t0 = Date.now();
              try {
                const response = await server.elicitInput({ mode: "form", message: proposal.message, requestedSchema: confirmSchema() }, { timeout: elicitationTimeout, signal: extra.signal, relatedRequestId: extra.requestId });
                logConfirmation({ client, caps, channel: "elicitation", proposalId: proposal.proposalId, outcome: response.action, confirm: response.content?.confirm, ms: Date.now() - t0 });
                if (response.action === "accept" && response.content?.confirm === true && !extra.signal.aborted) {
                  await service.confirmPolicy({ proposalId: proposal.proposalId, nonce: proposal.nonce, via: "elicitation" });
                  confirmedNow = true;
                } else if (response.action === "accept" && response.content?.confirm === false && !extra.signal.aborted) {
                  // Only an explicit answer to our own field is a person's denial. Timing proves nothing (round 6, 1).
                  await service.rejectPolicy({ proposalId: proposal.proposalId, nonce: proposal.nonce, via: "elicitation" });
                  envelope = success({ kind: "cancelled" as const, job: { ...outcome.job, state: "cancelled" as const }, jobId: outcome.job.id, nextAction: "none" as const },
                    ["The user explicitly denied the host confirmation; the task was cancelled (confirmation_denied)."]);
                  break;
                } else {
                  // decline / cancel / missing answer: ambiguous (some hosts auto-decline), so keep waiting and ask elsewhere.
                  reasons.push(extra.signal.aborted ? "The caller cancelled the request" : `Host elicitation returned ${response.action} without an explicit answer (the host may auto-decline); keep waiting`);
                }
              } catch (error) {
                logConfirmation({ client, caps, channel: "elicitation", proposalId: proposal.proposalId, outcome: "error", error: String((error as Error)?.message ?? error), ms: Date.now() - t0 });
                reasons.push("Host elicitation failed or timed out");
              }
            } else reasons.push(extra.signal.aborted ? "The caller cancelled the request" : "The host did not advertise elicitation support");
            if (confirmedNow) {
              envelope = success({ kind: "accepted" as const, job: outcome.job, jobId: outcome.job.id, nextAction: "wait" as const }, ["Confirmed through host elicitation; the task is queued."]);
              break;
            }
            const shown = !extra.signal.aborted && (opts.showDialog?.(proposal.proposalId) ?? false);
            logConfirmation({ client, channel: "native-dialog", proposalId: proposal.proposalId, outcome: shown ? "requested" : "not_requested" });
            envelope = success({ kind: "awaiting_confirmation" as const, job: outcome.job, jobId: outcome.job.id, proposal: publicProposal(proposal), nextAction: "poll_until_confirmed" as const }, [
              shown ? "Turnweft requested a dialog on the user's screen (title Turnweft); it waits for the user to choose and never auto-denies." : "Could not request a Turnweft native dialog; ask the user to confirm in a terminal.",
              `Next: explain the confirmation to the user, then keep calling turnweft_job in this turn (jobId ${outcome.job.id}, waitMs 25000, afterSeq = previous nextSeq) until it leaves waiting_confirmation; do not end this turn or resubmit. Wait up to about 10 minutes, then ask the user to say "continue" after confirming.`,
              `The user can also run turnweft policy grant ${proposal.proposalId} in a terminal (yes to allow, no to deny). Denial cancels the task.`,
              ...reasons.map((r) => `Note: ${r}.`),
            ]);
            break;
          }
          envelope = outcome.kind === "accepted" ? success({ ...outcome, jobId: outcome.job.id, nextAction: "wait" },
              outcome.job.hostBypass ? [`Authorized by the host's bypass mode (${outcome.job.hostBypass}); no confirmation was asked. The result reports the actual permission tier.`] : [])
            : outcome.kind === "needs_confirmation" ? confirmationRequired(outcome.proposal) : failure(outcome.code, outcome.message);
          break;
        }
        case "turnweft_job": {
          const view = await service.getJob({ ...input, jobId: input.jobId as string, waitMs: boundedWait(input.waitMs as number | undefined, opts) });
          if (view.job.state === "waiting_confirmation" && view.job.proposalId) opts.showDialog?.(view.job.proposalId); // retry; the helper dedupes (round 5, 8)
          envelope = success(view, view.job.state === "waiting_confirmation"
            ? [`Still waiting for the user to choose in the Turnweft dialog (or run turnweft policy grant in a terminal). Keep calling turnweft_job (waitMs 25000, afterSeq ${view.nextSeq}); do not end this turn or resubmit.`]
            : []);
          break;
        }
        case "turnweft_cancel": envelope = success(await service.cancelJob(input.jobId as string)); break;
        default: return toolResult(failure("unknown_tool", "Unknown tool"));
      }
      return toolResult(envelope);
    } catch (error) { return toolResult(serviceFailure(error)); }
  });
  return server;
}

export async function startMcpServer(service: TurnweftService, opts: McpServerOptions = {}): Promise<Server> {
  const cliMain = join(pathDirname(fileURLToPath(import.meta.url)), "..", "cli", "main.js");
  const server = createMcpServer(service, { showDialog: (id) => spawnDialogHelper(id, cliMain), hostBypass: (host, meta, call) => hostBypass(host, meta, call), ...opts });
  pruneHookRecords();
  await server.connect(new StdioServerTransport());
  return server;
}
