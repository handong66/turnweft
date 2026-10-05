#!/usr/bin/env node
// Pre-commit gate (.githooks/pre-commit): a commit that changes user-facing code must also update CHANGELOG.md,
// and the docs listed below must be checked. Also runs the privacy scan. Bypass only in an emergency:
// `git commit --no-verify`.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Paths whose changes users can notice (behaviour, plugins, packaging). Tests and docs alone are not. */
export function isUserFacing(file) {
  if (file.startsWith("src/tests/")) return false;
  return file.startsWith("src/") || file.startsWith("plugins/") || file === "package.json" || file === ".claude-plugin/marketplace.json" || file === ".agents/plugins/marketplace.json";
}

export function gate(stagedFiles) {
  const userFacing = stagedFiles.filter(isUserFacing);
  if (!userFacing.length || stagedFiles.includes("CHANGELOG.md")) return { ok: true, userFacing };
  return { ok: false, userFacing };
}

export const DOCS_TO_CHECK = [
  "CHANGELOG.md (required: add an entry under [Unreleased])",
  "README.md and README.zh-CN.md (keep both languages in step)",
  "plugins/claude-code/skills/turnweft/SKILL.md and plugins/codex/skills/turnweft/SKILL.md",
  "TURNWEFT_DESIGN_AND_DEVELOPMENT_PLAN.md (decisions in §1.3, affected sections)",
  "docs/e2e/E2E_RESULTS.md (when behaviour was tested live)",
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMRD"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const r = gate(staged);
  if (!r.ok) {
    console.error("Commit blocked: user-facing files changed without a CHANGELOG.md entry.\n");
    console.error("Changed: " + r.userFacing.join(", ") + "\n");
    console.error("Update and stage the docs that apply:\n" + DOCS_TO_CHECK.map((d) => "  - " + d).join("\n"));
    console.error("\n(Emergency only: git commit --no-verify)");
    process.exit(1);
  }
  try { execFileSync(process.execPath, ["scripts/privacy-scan.mjs"], { stdio: ["ignore", "ignore", "inherit"] }); }
  catch {
    console.error("Commit blocked: the privacy scan found something. Run: node scripts/privacy-scan.mjs");
    process.exit(1);
  }
}
