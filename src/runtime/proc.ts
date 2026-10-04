// Process identity (§8.6, §9.2): a PID alone can be reused, so owners are identified by
// "pid:start-time". An owner is gone only when that exact process no longer exists.
import { execFileSync } from "node:child_process";

export function processStartTime(pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export function ownerToken(pid = process.pid): string {
  return `${pid}:${processStartTime(pid) ?? "unknown"}`;
}

/**
 * True only when the exact process (pid + start time) is proven gone. Unknown is treated as alive:
 * a failed `ps` must never let a successor take over a live owner (review finding 2).
 */
export function isOwnerGone(pid: number, token: string): boolean {
  if (!pid || !token) return true;
  try { process.kill(pid, 0); } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
  // A zombie has exited; it only waits to be reaped by its parent.
  try {
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (stat.startsWith("Z")) return true;
  } catch { /* fall through to the identity check */ }
  const started = processStartTime(pid);
  if (!started) return false;
  if (token.endsWith(":unknown")) return false;
  return token !== `${pid}:${started}`;
}

/**
 * Live (non-zombie) members of a process group, or ok=false when that cannot be determined.
 * Providers are spawned as group leaders, so pgid = leader pid. A failed probe is never read as "empty"
 * (round 3, finding 3): only pgrep's exit status 1 means no match.
 */
export function groupMembers(pgid: number): { ok: boolean; pids: number[] } {
  let out: string;
  try {
    out = execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    return (e as { status?: number }).status === 1 ? { ok: true, pids: [] } : { ok: false, pids: [] };
  }
  const pids = out.split("\n").map((l) => Number(l.trim())).filter((n) => n > 0 && n !== process.pid);
  const live: number[] = [];
  for (const p of pids) {
    try {
      const stat = execFileSync("ps", ["-o", "stat=", "-p", String(p)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (!stat.startsWith("Z") && stat !== "") live.push(p);
    } catch (e) {
      // ps exits 1 when the process vanished between pgrep and ps; anything else is unknown -> assume alive.
      if ((e as { status?: number }).status !== 1) live.push(p);
    }
  }
  return { ok: true, pids: live };
}

/** State of the leader recorded at spawn time ("pid:start-time"). */
export function leaderState(pid: number, token: string): "same" | "dead" | "reused" | "unknown" {
  if (!pid || !token || token.endsWith(":unknown")) return "unknown";
  try { process.kill(pid, 0); } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
  try {
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (stat.startsWith("Z")) return "dead";
  } catch { /* fall through */ }
  const started = processStartTime(pid);
  if (!started) return "unknown";
  return token === `${pid}:${started}` ? "same" : "reused";
}

/**
 * The provider recorded at spawn (pid + start time) and everything left in its process group are gone.
 * "reused": the kernel does not hand out a pid that is still in use as a process group id, so a reused
 * leader pid proves the original group no longer exists, and nothing is signalled (round 3, finding 2).
 */
export function nativeStopped(pid: number, token: string): boolean {
  if (pid === process.pid) return true;
  const st = leaderState(pid, token);
  if (st === "reused") return true;
  if (st !== "dead") return false;
  const g = groupMembers(pid);
  return g.ok && g.pids.length === 0;
}

/**
 * Stop a provider group identified by the token recorded at spawn, and wait for proof it is gone.
 * Never re-derives the identity at stop time; never signals a reused pid. Returns false when stopping
 * cannot be confirmed (the caller must then freeze, not continue).
 * Limitation: processes that moved to a new session/group (setsid) are not tracked.
 */
export async function stopAndConfirm(pid: number, token: string, graceMs = 5000): Promise<boolean> {
  if (pid === process.pid) return true;
  // Test-only: simulate a provider that cannot be confirmed stopped (freeze path). Never set in normal use.
  if (process.env.TURNWEFT_TEST_UNSTOPPABLE === "1") return false;
  const st = leaderState(pid, token);
  if (st === "reused") return true;
  if (st === "unknown") return false;
  if (nativeStopped(pid, token)) return true;
  const signalGroup = (sig: NodeJS.Signals) => {
    try { process.kill(-pid, sig); } catch { if (leaderState(pid, token) === "same") { try { process.kill(pid, sig); } catch { /* gone */ } } }
  };
  signalGroup("SIGTERM");
  const until = Date.now() + graceMs;
  while (Date.now() < until) {
    if (nativeStopped(pid, token)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (leaderState(pid, token) !== "reused") signalGroup("SIGKILL");
  for (let i = 0; i < 20; i++) {
    if (nativeStopped(pid, token)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Signal a whole process group (children were spawned detached as group leaders). */
export function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM") {
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}
