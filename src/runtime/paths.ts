import { mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Per-user private state directory (§9.1). Override with TURNWEFT_HOME (tests use this). */
export function stateDir(): string {
  const dir = process.env.TURNWEFT_HOME ?? join(homedir(), ".turnweft");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  return dir;
}

export function dbPath(): string {
  return join(stateDir(), "state.sqlite");
}

export function logDir(): string {
  const dir = join(stateDir(), "logs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
