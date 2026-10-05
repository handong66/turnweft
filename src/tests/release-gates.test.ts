// Docs/changelog gate and changelog release helpers (scripts/docs-gate.mjs, scripts/changelog.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const load = (p: string) => import(new URL(`../../scripts/${p}`, import.meta.url).href);
const { gate, isUserFacing, parseNameStatus, addsChangelogEntry } = await load("docs-gate.mjs");
const { hasSection, release } = await load("changelog.mjs");

const ENTRY = "@@ -9,0 +10 @@\n+- Fixed the thing.\n";
const ns = (...rows: string[][]) => parseNameStatus(rows.flat().join("\0") + "\0");

test("user-facing changes need a new CHANGELOG.md entry; tests and docs alone do not", () => {
  assert.equal(isUserFacing("src/runtime/worker.ts"), true);
  assert.equal(isUserFacing("plugins/claude-code/host-mode-hook.mjs"), true);
  assert.equal(isUserFacing("package.json"), true);
  assert.equal(isUserFacing("src/tests/core-runtime.test.ts"), false);
  assert.equal(isUserFacing("README.md"), false);
  assert.equal(gate(ns(["M", "src/runtime/worker.ts"]), "").ok, false);
  assert.equal(gate(ns(["M", "src/runtime/worker.ts"], ["M", "CHANGELOG.md"]), ENTRY).ok, true);
  assert.equal(gate(ns(["M", "src/tests/x.test.ts"], ["M", "README.md"]), "").ok, true);
  assert.equal(gate([], "").ok, true);
});

test("round 14: deleting or only reformatting CHANGELOG.md does not pass; renames count on both sides", () => {
  assert.equal(gate(ns(["M", "src/runtime/worker.ts"], ["D", "CHANGELOG.md"]), ENTRY).ok, false, "deleted changelog");
  assert.equal(gate(ns(["M", "src/runtime/worker.ts"], ["M", "CHANGELOG.md"]), "@@ -1 +1 @@\n-# Changelog\n+# Change log\n").ok, false, "no new entry");
  assert.equal(addsChangelogEntry("+- An entry"), true);
  assert.equal(addsChangelogEntry("+  - A nested entry"), true);
  assert.equal(addsChangelogEntry("-- removed\n+## [Unreleased]"), false);
  const moved = ns(["R100", "src/runtime/ids.ts", "src/tests/ids.ts"]);
  assert.deepEqual(moved[0], { status: "R", paths: ["src/runtime/ids.ts", "src/tests/ids.ts"] });
  assert.equal(gate(moved, "").ok, false, "moving production code into tests is still a user-facing change");
  assert.equal(gate(ns(["M", "src/a b.ts"]), "").userFacing[0], "src/a b.ts", "paths with spaces survive -z parsing");
});

test("npm version turns Unreleased into the version and keeps the comparison links in step", () => {
  const base = "https://github.com/o/r";
  const before = `# Changelog\n\n## [Unreleased]\n\n### Fixed\n- a bug\n\n## [0.1.0] - 2026-01-01\n- old\n\n[Unreleased]: ${base}/compare/v0.1.0...HEAD\n[0.1.0]: ${base}/releases/tag/v0.1.0\n`;
  const after = release(before, "0.2.0", "2026-02-02");
  assert.match(after, /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-02-02\n\n### Fixed\n- a bug/);
  assert.match(after, new RegExp(`\\[Unreleased\\]: ${base}/compare/v0\\.2\\.0\\.\\.\\.HEAD\\n\\[0\\.2\\.0\\]: ${base}/compare/v0\\.1\\.0\\.\\.\\.v0\\.2\\.0`));
  assert.equal(hasSection(after, "0.2.0"), true);
  assert.equal(release(after, "0.2.0", "2026-02-03"), after, "idempotent");
  assert.throws(() => release(after, "0.3.0", "2026-03-03"), /empty/);
});

test("the repository changelog has a section for the package version", () => {
  const root = new URL("../../", import.meta.url);
  const version = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).version;
  assert.equal(hasSection(readFileSync(new URL("CHANGELOG.md", root), "utf8"), version), true, `add a CHANGELOG.md section for ${version}`);
});
