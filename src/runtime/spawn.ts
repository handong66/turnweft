// Start a detached session worker. Shared by the service (on submit/poll) and by workers that find a
// project lock held by a session whose worker died (so that session's recovery runs).
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logDir } from "./paths.js";
import { isOwnerGone } from "./proc.js";
import type { Store } from "./store.js";

export function spawnWorker(sessionId: string) {
  const main = join(dirname(fileURLToPath(import.meta.url)), "worker-main.js");
  const log = openSync(join(logDir(), `worker-${sessionId}.log`), "a", 0o600);
  try {
    const child = spawn(process.execPath, [main, sessionId], { detached: true, stdio: ["ignore", log, log], env: process.env });
    child.on("error", () => { /* the next poll retries */ });
    child.unref();
  } finally {
    closeSync(log); // the child holds its own copy
  }
}

/** Wake a worker unless a live owner already holds the session lease. */
export function ensureWorkerFor(store: Store, sessionId: string, spawnFn: (id: string) => void = spawnWorker) {
  const lease = store.getLease(sessionId);
  if (lease && lease.ownerToken !== "" && !isOwnerGone(lease.ownerPid, lease.ownerToken)) return;
  spawnFn(sessionId);
}
