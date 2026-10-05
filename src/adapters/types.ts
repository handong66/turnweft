// Internal adapter contract (§8.3). Only runtime/ uses this; hosts never see adapters.
import type { Message } from "../core/i18n.js";
import type { AgentCapabilities, Intent, ProbeResult, ProviderId } from "../core/types.js";

export type PermissionKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";

/** How one intent maps onto a provider's native controls (§7.4 directional mapping). */
export interface TierSpec {
  /** Stable name stored in UserPolicy.tier. */
  tier: string;
  /** What this tier allows beyond the grant. Empty means no U11 confirmation is needed. */
  excess: Message[];
  /** Decide a per-request approval from the provider (ACP callback providers). */
  decide(kind: PermissionKind | undefined, title: string): "allow" | "deny";
  /** True if the read-back effective mode satisfies this tier. */
  satisfiedBy(effective: Record<string, string>): boolean;
}

export interface OpenInput {
  cwd: string;
  nativeSessionId?: string;
  tier: TierSpec;
  model?: string;
  /** U23: provider-native thinking level. */
  effort?: string;
}

export interface OpenResult {
  nativeSessionId: string;
  loaded: boolean;
  /** Read-back native settings after applying the tier (config options, mode, etc.). */
  effective: Record<string, string>;
  model?: { requested?: string; effective?: string };
  effort?: { requested?: string; effective?: string };
}

export type AdapterEvent =
  | { type: "text"; text: string }
  | { type: "thought" }
  | { type: "tool"; id?: string; kind?: string; title?: string; status?: string }
  | { type: "permission"; kind?: string; title: string; decision: "allow" | "deny" }
  | { type: "config"; effective: Record<string, string> }
  | { type: "diagnostic"; message: string };

export interface PromptOutcome {
  stopReason: string;
  /** Provider reported success but blocked actions (e.g. agy denied_actions). */
  blocked?: string[];
  usage?: Record<string, unknown>;
}

export interface Connection {
  readonly pid: number | undefined;
  open(input: OpenInput): Promise<OpenResult>;
  prompt(text: string, onEvent: (e: AdapterEvent) => void): Promise<PromptOutcome>;
  cancel(): Promise<void>;
  close(): Promise<void>;
  /** Resolves when the provider process exits. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  /** True once the provider process has exited (used to classify transport loss). */
  readonly hasExited: boolean;
  /** Current native settings snapshot, kept up to date for the connection's whole life (round 3, finding 6). */
  currentEffective(): Record<string, string>;
  /** U23: the thinking level in effect now (live read-back; for launch-flag providers, the flag passed). */
  currentEffort(): string | undefined;
  /**
   * U23: change the thinking level inside the running session, verified by read-back. Absent when the provider
   * only takes it at launch (agy); the runtime then resumes the same native session with the new flag.
   */
  setEffort?(value: string): Promise<void>;
}

/** Called the moment the provider process is spawned, before any protocol exchange (round 3, finding 4). */
export interface ConnectHooks { onSpawn?(pid: number): void }

export class AdapterError extends Error {
  constructor(public code: "session_not_found" | "auth_required" | "provider_error" | "capability_mismatch" | "not_installed" | "connection_lost" | "invalid_effort", message: string,
    /** U23: the setting may or may not have taken effect (no reliable read-back); the connection must not be reused. */
    public stateUnknown = false) {
    super(message);
  }
}

export interface Adapter {
  provider: ProviderId;
  adapterVersion: string;
  capabilities: AgentCapabilities;
  probe(): Promise<ProbeResult>;
  tierFor(intent: Intent, probe: ProbeResult): TierSpec;
  connect(cwd: string, hooks?: ConnectHooks): Connection;
}
