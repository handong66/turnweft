#!/usr/bin/env node
// Copy the single launcher source into every plugin directory (plugins are installed as separate copies).
import { copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "plugins/shared/launcher.mjs");
for (const p of ["plugins/claude-code", "plugins/codex"]) {
  if (!existsSync(join(root, p))) continue;
  copyFileSync(src, join(root, p, "launcher.mjs"));
  console.log(`launcher -> ${p}/launcher.mjs`);
}
