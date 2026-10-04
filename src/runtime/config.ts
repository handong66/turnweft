// User-level trusted configuration (§12): ~/.turnweft/config.json. Project files never widen this.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderId } from "../core/types.js";
import { stateDir } from "./paths.js";

export interface TurnweftConfig {
  /** Absolute executable per provider; tools may not override this at call time (§11.1). */
  executables?: Partial<Record<ProviderId, string>>;
  /** Idle release after this many ms for sessions with verified L2 (U13). */
  idleReleaseMs?: number;
  /** Fail a turn after this long with no provider activity (M0 §6: OpenCode swallows provider errors). */
  inactivityTimeoutMs?: number;
  /** Max bounded wait a host may request, kept below the host tool timeout. */
  maxWaitMs?: number;
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
    try { user = JSON.parse(readFileSync(p, "utf8")); } catch { /* ignore malformed; doctor reports it */ }
  }
  const env = (k: string) => (process.env[k] ? Number(process.env[k]) : undefined);
  return {
    ...DEFAULTS,
    ...user,
    idleReleaseMs: env("TURNWEFT_IDLE_RELEASE_MS") ?? user.idleReleaseMs ?? DEFAULTS.idleReleaseMs,
    inactivityTimeoutMs: env("TURNWEFT_INACTIVITY_MS") ?? user.inactivityTimeoutMs ?? DEFAULTS.inactivityTimeoutMs,
    cancelGraceMs: env("TURNWEFT_CANCEL_GRACE_MS") ?? user.cancelGraceMs ?? DEFAULTS.cancelGraceMs,
    openTimeoutMs: env("TURNWEFT_OPEN_TIMEOUT_MS") ?? user.openTimeoutMs ?? DEFAULTS.openTimeoutMs,
  };
}
