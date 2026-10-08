// U11 policy evaluation (§7.4): directional mapping, one-time confirmation per provider × project × intent,
// re-validation on version/capability change. Proposals are generated here, never by the model.
import { currentLanguage, renderMessage, text } from "../core/i18n.js";
import type { Intent, PolicyProposal, ProbeResult, ProviderId, UserPolicy } from "../core/types.js";
import type { TierSpec } from "../adapters/types.js";
import { newNonce, newPolicyId, newProposalId, now, sha256 } from "./ids.js";
import type { Store } from "./store.js";

/** U19: a confirmation waits for the human; it is not denied on timeout, only expires after a day. */
export const PROPOSAL_TTL_MS = 24 * 60 * 60_000;

// Existing confirmations hash the original Chinese bytes, regardless of the display language.
export function capabilityDigest(provider: ProviderId, probe: ProbeResult, tier: TierSpec): string {
  return sha256(JSON.stringify({ provider, cliVersion: probe.cliVersion, adapterVersion: probe.adapterVersion, tier: tier.tier, excess: tier.excess.map(message => renderMessage(message, "zh")) }));
}

export type PolicyKey = { provider: ProviderId; canonicalRoot: string; intent: Intent; probe: ProbeResult; tier: TierSpec };

/** Non-mutating check used by the worker right before running (review finding 3). */
export function matchPolicy(store: Store, a: PolicyKey): { ok: true; policy?: UserPolicy } | { ok: false } {
  if (a.tier.excess.length === 0) return { ok: true };
  const digest = capabilityDigest(a.provider, a.probe, a.tier);
  const policy = store.findActivePolicy({ provider: a.provider, canonicalRoot: a.canonicalRoot, intent: a.intent, tier: a.tier.tier, capabilityDigest: digest });
  return policy ? { ok: true, policy } : { ok: false };
}

/** Build (do not store) the proposal shown to the human. The service stores it inside its submit transaction. */
export function buildProposal(a: PolicyKey): PolicyProposal {
  const digest = capabilityDigest(a.provider, a.probe, a.tier);
  const language = currentLanguage();
  const excess = a.tier.excess.map(message => renderMessage(message, language));
  return {
    proposalId: newProposalId(),
    nonce: newNonce(),
    provider: a.provider,
    canonicalRoot: a.canonicalRoot,
    intent: a.intent,
    tier: a.tier.tier,
    excessOverGrant: excess,
    cliVersion: a.probe.cliVersion ?? "unknown",
    adapterVersion: a.probe.adapterVersion,
    capabilityDigest: digest,
    message: text("proposal", { provider: a.provider, version: a.probe.cliVersion ?? text("unknownVersion", undefined, language), root: a.canonicalRoot, tier: a.tier.tier, intent: text(a.intent, undefined, language), excess: excess.join("\n- ") }, language),
    expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
  };
}

export class PolicyError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** Confirm atomically with the release of every waiting job on the same key (round 5, 2). */
export function confirm(store: Store, proposalId: string, nonce: string, via: UserPolicy["confirmedVia"], expiresAt?: string) {
  if (expiresAt && (via !== "cli-tty" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) throw new PolicyError("invalid_expiry", "policy expiry must be in the future and granted in a terminal");
  try {
    return store.decideProposal({
      proposalId, nonce, decision: "confirmed", via,
      makePolicy: (p) => {
        const prior = store.findActivePolicy({ provider: p.provider, canonicalRoot: p.canonicalRoot, intent: p.intent, tier: p.tier, capabilityDigest: p.capabilityDigest });
        return {
          id: newPolicyId(), provider: p.provider, canonicalRoot: p.canonicalRoot, intent: p.intent, tier: p.tier,
          excessOverGrant: p.excessOverGrant, cliVersion: p.cliVersion, adapterVersion: p.adapterVersion,
          capabilityDigest: p.capabilityDigest, confirmedVia: via, confirmedAt: now(), ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}), revision: (prior?.revision ?? 0) + 1,
        };
      },
    });
  } catch (e) { throw new PolicyError((e as { code?: string }).code ?? "policy_error", (e as Error).message); }
}

/** Reject atomically with the cancellation of every waiting job on the same key. */
export function reject(store: Store, proposalId: string, nonce: string, via: string) {
  try { return store.decideProposal({ proposalId, nonce, decision: "rejected", via }); }
  catch (e) { throw new PolicyError((e as { code?: string }).code ?? "policy_error", (e as Error).message); }
}

/** HH:MM means the next occurrence in the user's local timezone; ISO must include a timezone. */
export function parsePolicyUntil(value: string, current = new Date()): string {
  let end: Date;
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    const [h, m] = value.split(":").map(Number);
    end = new Date(current); end.setHours(h!, m!, 0, 0);
    if (end.getTime() <= current.getTime()) end.setDate(end.getDate() + 1);
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) end = new Date(value);
  else throw new PolicyError("invalid_expiry", "--until requires HH:MM or an ISO timestamp with timezone");
  if (!Number.isFinite(end.getTime()) || end.getTime() <= current.getTime()) throw new PolicyError("invalid_expiry", "--until must be in the future");
  return end.toISOString();
}
