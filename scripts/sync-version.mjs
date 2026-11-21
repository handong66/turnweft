#!/usr/bin/env node
// Keep plugin manifest versions equal to package.json, so a release never ships mismatched versions.
//   node scripts/sync-version.mjs          write package.json's version into the plugin manifests and README status lines
//   node scripts/sync-version.mjs --check  exit 1 if any of them differs (run by prepublishOnly)
// `npm version <v>` runs this through the "version" lifecycle script. The MCP server reads package.json at
// runtime. MIN_RUNTIME in plugins/shared/launcher.mjs is a compatibility floor and is maintained by hand.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFESTS = ["plugins/claude-code/.claude-plugin/plugin.json", "plugins/codex/.codex-plugin/plugin.json"];
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const check = process.argv.includes("--check");

let mismatched = 0;
for (const rel of MANIFESTS) {
  const file = join(root, rel);
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  if (manifest.version === version) continue;
  if (check) { console.error(`${rel}: version ${manifest.version} does not match package.json ${version}`); mismatched++; continue; }
  manifest.version = version;
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`${rel}: ${version}`);
}

// The status line near the top of each README names the exact released version.
export const STATUS_LINES = [["README.md", /^(> Status: `)([^`]+)(`)/m], ["README.zh-CN.md", /^(> 状态：`)([^`]+)(`)/m]];
for (const [rel, pattern] of STATUS_LINES) {
  const file = join(root, rel);
  const text = readFileSync(file, "utf8");
  const found = text.match(pattern);
  if (!found) { console.error(`${rel}: status line not found`); mismatched++; continue; }
  if (found[2] === version) continue;
  if (check) { console.error(`${rel}: status line says ${found[2]}, package.json is ${version}`); mismatched++; continue; }
  writeFileSync(file, text.replace(pattern, `$1${version}$3`));
  console.log(`${rel}: ${version}`);
}
process.exit(mismatched ? 1 : 0);
