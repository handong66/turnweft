#!/usr/bin/env node
// Commit gate (.githooks/pre-commit and pre-merge-commit): a commit that changes user-facing code must add a
// CHANGELOG.md entry, and the docs listed below must be checked. The staged content must pass the privacy scan.
// Emergency only: `git commit --no-verify`.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Paths whose changes users can notice (behaviour, plugins, packaging). Tests and docs alone are not. */
export function isUserFacing(file) {
  if (file.startsWith("src/tests/")) return false;
  return file.startsWith("src/") || file.startsWith("plugins/") || file === "package.json"
    || file === ".claude-plugin/marketplace.json" || file === ".agents/plugins/marketplace.json";
}

/** Parse `git diff --cached --name-status -z`: renames and copies count on both sides. */
export function parseNameStatus(raw) {
  const parts = raw.split("\0").filter((p) => p !== "");
  const changes = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (status.startsWith("R") || status.startsWith("C")) changes.push({ status: status[0], paths: [parts[i++], parts[i++]] });
    else changes.push({ status: status[0], paths: [parts[i++]] });
  }
  return changes;
}

/** Normalized list entries ("- text") of a changelog section, or of the whole file when no heading is given. */
export function entries(text, heading) {
  let body = text;
  if (heading) {
    const parts = text.split(new RegExp(`^## \\[${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][^\\n]*$`, "m"));
    if (parts.length < 2) return [];
    body = parts[1].split(/^## \[/m)[0];
  }
  return body.split("\n").map((l) => l.match(/^\s*[-*] (\S.*)$/)?.[1]?.trim()).filter(Boolean);
}

const versions = (text) => [...text.matchAll(/^## \[(\d[^\]]*)\]/gm)].map((m) => m[1]);

/**
 * True if CHANGELOG.md gained a real entry: a line under [Unreleased] whose text appeared nowhere in the previous
 * file (re-indenting or moving an old entry does not count), or a new version section (`npm version`).
 */
export function changelogAdvanced(before, after) {
  const old = new Set(entries(before));
  if (entries(after, "Unreleased").some((e) => !old.has(e))) return true;
  const had = new Set(versions(before));
  return versions(after).some((v) => !had.has(v));
}

export function gate(changes, before, after) {
  const userFacing = [...new Set(changes.flatMap((c) => c.paths).filter(isUserFacing))];
  if (!userFacing.length) return { ok: true, userFacing };
  const log = changes.find((c) => c.paths.includes("CHANGELOG.md"));
  const ok = Boolean(log) && log.status !== "D" && changelogAdvanced(before, after);
  return { ok, userFacing };
}

export const DOCS_TO_CHECK = [
  "CHANGELOG.md (required: add an entry under [Unreleased])",
  "README.md and README.zh-CN.md (keep both languages in step)",
  "plugins/claude-code/skills/turnweft/SKILL.md and plugins/codex/skills/turnweft/SKILL.md",
  "TURNWEFT_DESIGN_AND_DEVELOPMENT_PLAN.md (decisions in §1.3, affected sections)",
  "docs/e2e/E2E_RESULTS.md (when behaviour was tested live)",
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const changes = parseNameStatus(git("diff", "--cached", "--name-status", "-z", "-M"));
  const show = (rev) => { try { return git("show", `${rev}:CHANGELOG.md`); } catch { return ""; } };
  const r = gate(changes, show("HEAD"), show(""));
  if (!r.ok) {
    console.error("Commit blocked: user-facing files changed without a new CHANGELOG.md entry.\n");
    console.error("Changed: " + r.userFacing.join(", ") + "\n");
    console.error("Update and stage the docs that apply:\n" + DOCS_TO_CHECK.map((d) => "  - " + d).join("\n"));
    console.error("\n(Emergency only: git commit --no-verify)");
    process.exit(1);
  }
  try {
    execFileSync(process.execPath, [join(ROOT, "scripts", "privacy-scan.mjs"), "--index", ROOT], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
  } catch {
    console.error("Commit blocked: the privacy scan of the staged content found something (see above).");
    process.exit(1);
  }
}
