// Docs/changelog gate and changelog release helpers (scripts/docs-gate.mjs, scripts/changelog.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const load = (p: string) => import(new URL(`../../scripts/${p}`, import.meta.url).href);
const { gate, isUserFacing } = await load("docs-gate.mjs");
const { hasSection, release } = await load("changelog.mjs");

test("user-facing changes need a CHANGELOG.md entry; tests and docs alone do not", () => {
  assert.equal(isUserFacing("src/runtime/worker.ts"), true);
  assert.equal(isUserFacing("plugins/claude-code/host-mode-hook.mjs"), true);
  assert.equal(isUserFacing("package.json"), true);
  assert.equal(isUserFacing("src/tests/core-runtime.test.ts"), false);
  assert.equal(isUserFacing("README.md"), false);
  assert.equal(gate(["src/runtime/worker.ts"]).ok, false);
  assert.equal(gate(["src/runtime/worker.ts", "CHANGELOG.md"]).ok, true);
  assert.equal(gate(["src/tests/x.test.ts", "README.md"]).ok, true);
  assert.equal(gate([]).ok, true);
});

test("npm version turns Unreleased into the version; an empty Unreleased cannot be released", () => {
  const before = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n- a bug\n\n## [0.1.0] - 2026-01-01\n- old\n";
  const after = release(before, "0.2.0", "2026-02-02");
  assert.match(after, /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-02-02\n\n### Fixed\n- a bug/);
  assert.equal(hasSection(after, "0.2.0"), true);
  assert.equal(release(after, "0.2.0", "2026-02-03"), after, "idempotent");
  assert.throws(() => release(after, "0.3.0", "2026-03-03"), /empty/);
  assert.equal(hasSection(before, "0.1.0-alpha.2"), false);
});

test("the repository changelog has a section for the package version", () => {
  const root = new URL("../../", import.meta.url);
  const version = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).version;
  assert.equal(hasSection(readFileSync(new URL("CHANGELOG.md", root), "utf8"), version), true, `add a CHANGELOG.md section for ${version}`);
});
