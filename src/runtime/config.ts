// User-level trusted configuration (§12): ~/.turnweft/config.json. Project files never widen this.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ProviderId } from "../core/types.js";
import { stateDir } from "./paths.js";

export interface TurnweftConfig {
  /** U25: fail-fast never grants permission; it only suppresses waiting. */
  confirmationMode?: "wait" | "fail-fast";
  /** User-only launch environment, never accepted from project files or task arguments. */
  providerEnv?: Partial<Record<ProviderId, Record<string, string>>>;
  /** U24: user-only opt-in; exact real paths of project roots, never inherited by worktrees. */
  parallelWrites?: string[];
  ignoredParallelWrites?: Array<{ entry: unknown; reason: string }>;
  /** Absolute executable per provider; tools may not override this at call time (§11.1). */
  executables?: Partial<Record<ProviderId, string>>;
  /** Idle release after this many ms for sessions with verified L2 (U13). */
  idleReleaseMs?: number;
  /** Fail a turn after this long with no provider activity (M0 §6: OpenCode swallows provider errors). */
  inactivityTimeoutMs?: number;
  /** Max bounded wait a host may request, kept below the host tool timeout. */
  maxWaitMs?: number;
  /** Reserved; runtime pending-action timeout is not implemented. */
  permissionTimeoutMs?: number;
  /** After cancel (explicit or watchdog), close the provider if it has not stopped within this time. */
  cancelGraceMs?: number;
  /** Bound for connect + initialize + session open/load + settings. */
  openTimeoutMs?: number;
  /** Language of text shown to people (dialog, CLI, proposals): "en" or "zh". Read by core/i18n.ts. */
  language?: "en" | "zh";
}

export const DEFAULTS = {
  idleReleaseMs: 10 * 60_000,
  inactivityTimeoutMs: 10 * 60_000,
  maxWaitMs: 25_000,
  permissionTimeoutMs: 15 * 60_000,
  cancelGraceMs: 15_000,
  openTimeoutMs: 120_000,
};

export function loadConfig(): TurnweftConfig & typeof DEFAULTS {
  const p = join(stateDir(), "config.json");
  let user: TurnweftConfig = {};
  if (existsSync(p)) {
    try { user = JSON.parse(readFileSync(p, "utf8")) ?? {}; } catch { /* ignore malformed configuration */ }
  }
  const parallel = inspectParallelWrites(user.parallelWrites);
  const env = (k: string) => (process.env[k] ? Number(process.env[k]) : undefined);
  return {
    ...DEFAULTS,
    ...user,
    confirmationMode: user.confirmationMode === "fail-fast" ? "fail-fast" : "wait",
    parallelWrites: parallel.roots,
    ignoredParallelWrites: parallel.ignored,
    idleReleaseMs: env("TURNWEFT_IDLE_RELEASE_MS") ?? user.idleReleaseMs ?? DEFAULTS.idleReleaseMs,
    inactivityTimeoutMs: env("TURNWEFT_INACTIVITY_MS") ?? user.inactivityTimeoutMs ?? DEFAULTS.inactivityTimeoutMs,
    cancelGraceMs: env("TURNWEFT_CANCEL_GRACE_MS") ?? user.cancelGraceMs ?? DEFAULTS.cancelGraceMs,
    openTimeoutMs: env("TURNWEFT_OPEN_TIMEOUT_MS") ?? user.openTimeoutMs ?? DEFAULTS.openTimeoutMs,
  };
}

/** Invalid, missing and non-directory entries cannot grant concurrent write access. */
export function inspectParallelWrites(value: unknown): { roots: string[]; ignored: Array<{ entry: unknown; reason: string }> } {
  const ignored: Array<{ entry: unknown; reason: string }> = [];
  const roots = new Set<string>();
  if (!Array.isArray(value)) return { roots: [], ignored: value === undefined ? [] : [{ entry: value, reason: "expected an array" }] };
  for (const entry of value) {
    if (typeof entry !== "string") { ignored.push({ entry, reason: "not a string" }); continue; }
    if (!isAbsolute(entry)) { ignored.push({ entry, reason: "not an absolute path" }); continue; }
    try {
      const root = realpathSync(entry);
      if (statSync(root).isDirectory()) roots.add(root);
      else ignored.push({ entry, reason: "not a directory" });
    } catch { ignored.push({ entry, reason: "missing or inaccessible path" }); }
  }
  return { roots: [...roots], ignored };
}

/** Calls may opt out of waiting, but cannot override a user's fail-fast preference. */
export function nonInteractive(request?: boolean): boolean {
  return request === true || loadConfig().confirmationMode === "fail-fast";
}
