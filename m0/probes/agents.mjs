// Launch specs for the five targets, plus fixture helpers.
import { cpSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const M0 = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DIM = "/Applications/DimAgent.app/Contents/Resources/runtime/cli/dim";

export const ACP_AGENTS = {
  dim: { command: DIM, args: ["acp"] },
  grok: { command: "grok", args: ["agent", "--no-leader", "stdio"] },
  opencode: { command: "opencode", args: ["acp"] },
  droid: { command: "droid", args: ["exec", "--output-format", "acp"] },
};

// Fresh copy of the fixture with its own git history, so diffs are attributable.
export function freshFixture(label) {
  const dir = join(M0, "runs", `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dir, { recursive: true });
  cpSync(join(M0, "fixture-template"), dir, { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=m0@turnweft.test", "-c", "user.name=m0", "commit", "-qm", "fixture");
  return dir;
}

export function gitStatus(dir) {
  return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim();
}

export function runTests(dir) {
  try {
    // Judge with a fixed command, independent of the fixture's (possibly edited) npm script.
    execFileSync("node", ["--test", "test/math.test.js"], { cwd: dir, stdio: "pipe" });
    return "pass";
  } catch {
    return "fail";
  }
}
