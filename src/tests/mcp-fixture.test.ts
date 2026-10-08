import type {
  ConfirmPolicyInput, CreateSessionInput, GetJobInput, SubmitTurnInput, SubmitTurnOutcome, TurnweftService, UpdateSessionInput,
} from "../core/service.js";
import type { HostBinding, Job, PolicyProposal, Session, UserPolicy } from "../core/types.js";

export const proposal: PolicyProposal = {
  proposalId: "twp_proposal", nonce: "one-use-nonce", provider: "droid", canonicalRoot: "/project",
  intent: "implement", tier: "auto-medium", excessOverGrant: ["git commit", "trusted network"],
  cliVersion: "1", adapterVersion: "1", capabilityDigest: "digest", message: "Grant auto-medium for droid in /project: git commit and trusted network.",
  expiresAt: "2099-01-01T00:00:00Z",
};
export const job: Job = {
  id: "twj_job", sessionId: "tws_session", requestId: "saved-request", intent: "implement",
  promptDigest: "prompt-digest", state: "queued", acceptedAt: "2026-10-04T00:00:00Z",
};
export const session: Session = {
  id: "tws_session", provider: "droid", cwd: "/project", canonicalRoot: "/project", state: "ready", hostBindings: [],
  createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z",
};
export const policy: UserPolicy = {
  id: "twpolicy_policy", provider: proposal.provider, canonicalRoot: proposal.canonicalRoot, intent: proposal.intent,
  tier: proposal.tier, excessOverGrant: proposal.excessOverGrant, cliVersion: proposal.cliVersion,
  adapterVersion: proposal.adapterVersion, capabilityDigest: proposal.capabilityDigest,
  confirmedVia: "elicitation", confirmedAt: "2026-10-04T00:00:00Z", revision: 1,
};

export class FakeService implements TurnweftService {
  calls: Array<{ method: string; input: unknown }> = [];
  submissions: SubmitTurnInput[] = [];
  confirmations: ConfirmPolicyInput[] = [];
  confirmationNeeded = false;
  /** U19 shape: submit records a waiting job instead of returning needs_confirmation. */
  awaitingConfirmation = false;
  rejections: ConfirmPolicyInput[] = [];
  foundSession: Session | undefined = session;
  foundProposal: PolicyProposal | undefined = proposal;
  jobState: Job["state"] = "failed";
  submitOutcome?: SubmitTurnOutcome;
  private record(method: string, input?: unknown) { this.calls.push({ method, input }); }
  async listAgents(opts?: { refresh?: boolean }) { this.record("listAgents", opts); return [{ provider: "droid" as const, available: true, cliVersion: "1", adapterVersion: "1", problems: [], probedAt: "now" }]; }
  async createSession(input: CreateSessionInput) { this.record("createSession", input); return { ...session, hostBindings: [input.host] }; }
  async listSessions(filter: Parameters<TurnweftService["listSessions"]>[0]) { this.record("listSessions", filter); return [session]; }
  async getSession(id: string) { this.record("getSession", id); return this.foundSession; }
  async attachSession(id: string, host: HostBinding) { this.record("attachSession", { id, host }); return { ...session, hostBindings: [host] }; }
  async updateSession(input: UpdateSessionInput) { this.record("updateSession", input); return { ...session, requestedEffort: input.effort }; }
  async closeSession(id: string, closePolicy?: "reject_if_busy" | "cancel_running") { this.record("closeSession", { id, policy: closePolicy }); return { ...session, state: "closed" as const }; }
  async submitTurn(input: SubmitTurnInput): Promise<SubmitTurnOutcome> {
    this.record("submitTurn", input); this.submissions.push(input);
    if (this.submitOutcome) return this.submitOutcome;
    if (this.awaitingConfirmation && !this.confirmations.length) return { kind: "awaiting_confirmation", job: { ...job, state: "waiting_confirmation", requestId: input.requestId, intent: input.intent, proposalId: proposal.proposalId }, proposal };
    return this.confirmationNeeded && !this.confirmations.length ? { kind: "needs_confirmation", proposal } : { kind: "accepted", job: { ...job, requestId: input.requestId, intent: input.intent, ...(input.hostBypass ? { hostBypass: input.hostBypass } : {}) } };
  }
  async getJob(input: GetJobInput) {
    this.record("getJob", input);
    return { job: { ...job, state: this.jobState }, session, terminal: this.jobState === "failed", events: [], nextSeq: 0, nextAction: "none" as const };
  }
  async cancelJob(id: string) { this.record("cancelJob", id); return { ...job, state: "cancel_requested" as const }; }
  async confirmPolicy(input: ConfirmPolicyInput) { this.record("confirmPolicy", input); this.confirmations.push(input); return { ...policy, confirmedVia: input.via }; }
  dialogClaims: string[] = [];
  async claimConfirmationDialog(id: string, token: string) { this.record("claimConfirmationDialog", { id, token }); this.dialogClaims.push(id); return true; }
  async releaseConfirmationDialog(id: string, token: string) { this.record("releaseConfirmationDialog", { id, token }); }
  async recordConfirmationDialogChild(id: string, token: string, pid: number) { this.record("recordConfirmationDialogChild", { id, token, pid }); }
  async rejectPolicy(input: ConfirmPolicyInput) { this.record("rejectPolicy", input); this.rejections.push(input); }
  async proposePolicy(input: Parameters<TurnweftService["proposePolicy"]>[0]) { this.record("proposePolicy", input); return proposal; }
  async listPolicies(filter?: Parameters<TurnweftService["listPolicies"]>[0]) { this.record("listPolicies", filter); return [policy]; }
  async revokePolicy(id: string) { this.record("revokePolicy", id); return { ...policy, revokedAt: "now" }; }
  async getProposal(id: string) { this.record("getProposal", id); return this.foundProposal; }
}
