#!/usr/bin/env node
// Point git at the repository's hooks (.githooks). Runs from `npm install` (prepare).
// Never overrides a different core.hooksPath you already set; skipped in CI or with TURNWEFT_SKIP_HOOKS=1.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const skip = process.env.CI || process.env.TURNWEFT_SKIP_HOOKS === "1";
if (!skip && existsSync(".git") && existsSync(".githooks")) {
  const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  // The effective value from any scope (local, global, system): a global hooks setup must keep working here.
  let current = "";
  try { current = git("config", "--get", "core.hooksPath"); } catch { /* unset everywhere */ }
  if (current && current !== ".githooks") {
    console.warn(`turnweft: core.hooksPath is already "${current}"; leaving it. To enable the docs/changelog gate, run: git config core.hooksPath .githooks`);
  } else if (!current) {
    try { git("config", "--local", "core.hooksPath", ".githooks"); }
    catch { console.warn("turnweft: could not enable the git hooks; run: git config core.hooksPath .githooks"); }
  }
}
