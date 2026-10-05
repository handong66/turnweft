#!/usr/bin/env node
// Point git at the repository's hooks (.githooks). Runs from `npm install` (prepare); silent outside a git checkout.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
if (existsSync(".git") && existsSync(".githooks")) {
  try { execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" }); } catch { /* not a git checkout */ }
}
