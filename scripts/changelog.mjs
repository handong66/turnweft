#!/usr/bin/env node
// CHANGELOG.md helpers for the release lifecycle.
//   node scripts/changelog.mjs --check    exit 1 unless CHANGELOG.md has a section for package.json's version
//                                         (prepublishOnly)
//   node scripts/changelog.mjs --release  turn "## [Unreleased]" into "## [<version>] - <date>" and add a fresh
//                                         Unreleased section ("version" lifecycle, run by `npm version <v>`)
//   node scripts/changelog.mjs --notes [v]  print the section for v (default: package.json's version), used as the
//                                         GitHub Release notes: gh release create v<v> --notes-file <(... --notes)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "CHANGELOG.md");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function hasSection(text, v) { return new RegExp(`^## \\[${esc(v)}\\]`, "m").test(text); }

export function release(text, v, date) {
  if (hasSection(text, v)) return text; // already released under this version
  if (!/^## \[Unreleased\]/m.test(text)) throw new Error("CHANGELOG.md has no [Unreleased] section");
  const body = text.split(/^## \[Unreleased\][ \t]*$/m)[1].split(/^## \[/m)[0];
  if (!body.trim()) throw new Error("CHANGELOG.md [Unreleased] is empty: describe the changes before releasing");
  let out = text.replace(/^## \[Unreleased\][ \t]*$/m, `## [Unreleased]\n\n## [${v}] - ${date}`);
  // Keep the comparison links at the bottom in step: Unreleased compares from the new tag, and the new version
  // compares from the previous one.
  const link = out.match(/^\[Unreleased\]: (\S+)\/compare\/(\S+)\.\.\.HEAD$/m);
  if (link) {
    const [line, base, prev] = link;
    out = out.replace(line, `[Unreleased]: ${base}/compare/v${v}...HEAD\n[${v}]: ${base}/compare/${prev}...v${v}`);
  }
  return out;
}

/** The body of one version's section (without its heading), for release notes. */
export function notes(text, v) {
  const parts = text.split(new RegExp(`^## \\[${esc(v)}\\][^\\n]*$`, "m"));
  if (parts.length < 2) throw new Error(`CHANGELOG.md has no section for ${v}`);
  return parts[1].split(/^## \[|^\[[^\]]+\]: /m)[0].trim() + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = readFileSync(file, "utf8");
  if (process.argv.includes("--check")) {
    if (!hasSection(text, version)) { console.error(`CHANGELOG.md has no section for ${version}`); process.exit(1); }
  } else if (process.argv.includes("--release")) {
    writeFileSync(file, release(text, version, new Date().toISOString().slice(0, 10)));
  } else if (process.argv.includes("--notes")) {
    const v = process.argv[process.argv.indexOf("--notes") + 1] ?? version;
    process.stdout.write(notes(text, v.startsWith("--") ? version : v));
  } else { console.error("usage: changelog.mjs --check | --release | --notes [version]"); process.exit(2); }
}
