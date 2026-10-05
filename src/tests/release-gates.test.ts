// Docs/changelog gate and changelog release helpers (scripts/docs-gate.mjs, scripts/changelog.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const load = (p: string) => import(new URL(`../../scripts/${p}`, import.meta.url).href);
const { gate, isUserFacing, parseNameStatus, changelogAdvanced } = await load("docs-gate.mjs");
const { hasSection, release, notes } = await load("changelog.mjs");

const BEFORE = "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n- Existing entry\n";
const AFTER = "# Changelog\n\n## [Unreleased]\n- Fixed the thing.\n\n## [0.1.0] - 2026-01-01\n- Existing entry\n";
const ns = (...rows: string[][]) => parseNameStatus(rows.flat().join("\0") + "\0");

test("user-facing changes need a new CHANGELOG.md entry; tests and docs alone do not", () => {
  assert.equal(isUserFacing("src/runtime/worker.ts"), true);
  assert.equal(isUserFacing("plugins/claude-code/host-mode-hook.mjs"), true);
  assert.equal(isUserFacing("package.json"), true);
  assert.equal(isUserFacing("src/tests/core-runtime.test.ts"), false);
  assert.equal(isUserFacing("README.md"), false);
  assert.equal(gate(ns(["M", "src/runtime/worker.ts"]), BEFORE, BEFORE).ok, false);
  assert.equal(gate(ns(["M", "src/runtime/worker.ts"], ["M", "CHANGELOG.md"]), BEFORE, AFTER).ok, true);
  assert.equal(gate(ns(["M", "src/tests/x.test.ts"], ["M", "README.md"]), BEFORE, BEFORE).ok, true);
  assert.equal(gate([], "", "").ok, true);
});

test("round 14/15: deleting, reformatting or re-indenting CHANGELOG.md does not pass; renames count on both sides", () => {
  const worker = ["M", "src/runtime/worker.ts"];
  assert.equal(gate(ns(worker, ["D", "CHANGELOG.md"]), BEFORE, "").ok, false, "deleted changelog");
  assert.equal(gate(ns(worker, ["M", "CHANGELOG.md"]), BEFORE, BEFORE.replace("# Changelog", "# Change log")).ok, false, "format only");
  assert.equal(gate(ns(worker, ["M", "CHANGELOG.md"]), BEFORE, BEFORE.replace("- Existing entry", "  - Existing entry")).ok, false, "re-indented old entry");
  assert.equal(gate(ns(worker, ["M", "CHANGELOG.md"]), BEFORE, BEFORE.replace("- Existing entry", "- Existing entry\n- Sneaky")).ok, false, "entry added to an old release, not Unreleased");
  assert.equal(changelogAdvanced(BEFORE, BEFORE.replace("## [Unreleased]\n", "## [Unreleased]\n- Existing entry\n")), false, "moving an old entry into Unreleased");
  const released = AFTER.replace("## [Unreleased]\n- Fixed the thing.\n", "## [Unreleased]\n\n## [0.2.0] - 2026-02-02\n- Fixed the thing.\n");
  assert.equal(changelogAdvanced(AFTER, released, { from: "0.1.0", to: "0.2.0" }), true, "npm version release");
  // Round 16: a release only counts with the real package.json version change and a non-empty, matching section.
  assert.equal(changelogAdvanced(AFTER, released), false, "no version change in package.json");
  assert.equal(changelogAdvanced(BEFORE, BEFORE.replace("## [Unreleased]\n", "## [Unreleased]\n\n## [9.9.9] - x\n"), { from: "0.1.0", to: "9.9.9" }), false, "empty version heading");
  assert.equal(changelogAdvanced(BEFORE, BEFORE.replace("## [0.1.0]", "## [0.1.1]"), { from: "0.1.0", to: "0.1.1" }), false, "renaming an old heading");
  assert.equal(changelogAdvanced(BEFORE, BEFORE.replace("## [Unreleased]\n", "## [Unreleased]\n\n## [9.9.9] - x\n- y\n"), { from: "0.1.0", to: "0.2.0" }), false, "section for a different version");
  const moved = ns(["R100", "src/runtime/ids.ts", "src/tests/ids.ts"]);
  assert.deepEqual(moved[0], { status: "R", paths: ["src/runtime/ids.ts", "src/tests/ids.ts"] });
  assert.equal(gate(moved, BEFORE, BEFORE).ok, false, "moving production code into tests is still a user-facing change");
  assert.equal(gate(ns(["M", "src/a b.ts"]), BEFORE, BEFORE).userFacing[0], "src/a b.ts", "paths with spaces survive -z parsing");
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

test("release notes are the version's changelog section, without the comparison links", () => {
  const text = "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-02-02\n\n### Fixed\n- b\n\n## [0.1.0] - 2026-01-01\n- a\n\n[Unreleased]: x\n[0.2.0]: y\n";
  assert.equal(notes(text, "0.2.0"), "### Fixed\n- b\n");
  assert.equal(notes(text, "0.1.0"), "- a\n");
  assert.throws(() => notes(text, "9.9.9"), /no section/);
});
