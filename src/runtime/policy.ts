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
export function confirm(store: Store, proposalId: string, nonce: string, via: UserPolicy["confirmedVia"]) {
  try {
    return store.decideProposal({
      proposalId, nonce, decision: "confirmed", via,
      makePolicy: (p) => {
        const prior = store.findActivePolicy({ provider: p.provider, canonicalRoot: p.canonicalRoot, intent: p.intent, tier: p.tier, capabilityDigest: p.capabilityDigest });
        return {
          id: newPolicyId(), provider: p.provider, canonicalRoot: p.canonicalRoot, intent: p.intent, tier: p.tier,
          excessOverGrant: p.excessOverGrant, cliVersion: p.cliVersion, adapterVersion: p.adapterVersion,
          capabilityDigest: p.capabilityDigest, confirmedVia: via, confirmedAt: now(), revision: (prior?.revision ?? 0) + 1,
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
