// Canonical project root (§7.5) and per-turn file change evidence (§10.3, §14.3).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileChangeEvidence } from "../core/types.js";

export class PathError extends Error { code = "invalid_cwd"; }

/** realpath of the requested directory; this is where the agent works. Rejects missing paths and files. */
export function workingDir(cwd: string): string {
  if (!existsSync(cwd)) throw new PathError(`directory does not exist: ${cwd}`);
  const real = realpathSync(cwd);
  if (!statSync(real).isDirectory()) throw new PathError(`not a directory: ${cwd}`);
  return real;
}

/**
 * Project root for locks and policies: the git top-level if inside a repo, else the working dir.
 * Never used as the agent's cwd (live CC test: a subdirectory of a repo was replaced by the repo root).
 */
export function canonicalRoot(cwd: string): string {
  const real = workingDir(cwd);
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: real, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return top ? realpathSync(top) : real;
  } catch {
    return real;
  }
}

export interface Snapshot { method: "git" | "none"; dirty: Map<string, string> }

function hashFile(path: string): string {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return "missing"; }
}

/** Dirty paths and their content hashes, so pre-existing changes are not attributed to the agent. */
export function snapshot(root: string): Snapshot {
  let out: string;
  try {
    out = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return { method: "none", dirty: new Map() };
  }
  const dirty = new Map<string, string>();
  const parts = out.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    const path = entry.slice(3);
    if (entry[0] === "R" || entry[0] === "C") i++; // rename source follows
    dirty.set(path, hashFile(join(root, path)));
  }
  return { method: "git", dirty };
}

/**
 * Changes during the turn. `cwdPrefix` is the session cwd relative to the repo root ("" when they are the
 * same); changes outside it are reported separately because they may be concurrent edits by someone else.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot, cwdPrefix = ""): FileChangeEvidence {
  if (before.method === "none" || after.method === "none") return { method: "none", changed: [], preexistingDirty: [] };
  const all: string[] = [];
  for (const [path, hash] of after.dirty) if (before.dirty.get(path) !== hash) all.push(path);
  for (const path of before.dirty.keys()) if (!after.dirty.has(path)) all.push(path); // reverted/committed during turn
  const inside = (p: string) => cwdPrefix === "" || p === cwdPrefix || p.startsWith(cwdPrefix.endsWith("/") ? cwdPrefix : cwdPrefix + "/");
  const changed = all.filter(inside).sort();
  const outside = all.filter((p) => !inside(p)).sort();
  return { method: "git", changed, ...(outside.length ? { changedOutsideCwd: outside } : {}), preexistingDirty: [...before.dirty.keys()].sort() };
}
