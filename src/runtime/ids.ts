import { createHash, randomBytes, randomUUID } from "node:crypto";

export const newSessionId = () => `tws_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
export const newJobId = () => `twj_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
export const newPolicyId = () => `twp_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
export const newProposalId = () => `twq_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
export const newNonce = () => randomBytes(16).toString("hex");
export const now = () => new Date().toISOString();
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
