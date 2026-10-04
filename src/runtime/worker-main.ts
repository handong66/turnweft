#!/usr/bin/env node
// Entry point for a detached session worker: node worker-main.js <sessionId>
import { runWorker, shutdownWorker } from "./worker.js";

const sessionId = process.argv[2];
if (!sessionId) { console.error("usage: worker-main <sessionId>"); process.exit(2); }
// Stop the provider before exiting so a successor never finds an orphaned native executor (finding 1).
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => { void shutdownWorker().finally(() => process.exit(0)); });
runWorker(sessionId)
  .then((reason) => { console.error(`[turnweft-worker ${sessionId}] exit: ${reason}`); process.exit(0); })
  .catch((e) => { console.error(`[turnweft-worker ${sessionId}] crash:`, e); process.exit(1); });
