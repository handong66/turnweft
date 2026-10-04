#!/usr/bin/env node
// Release check: scan what would be published for secrets, personal data and local paths.
//   node scripts/privacy-scan.mjs [dir]         the git-tracked files of a repository (default: cwd)
//   node scripts/privacy-scan.mjs --pack [dir]  the files `npm pack` would publish (packed locally, never uploaded)
// Exits 1 when anything is found, including files it could not scan (binary or too large). Findings print the
// rule and location only, never the matched text, so a real secret does not end up in a terminal or CI log.
// Raw agent logs (m0/results/) must never be tracked: agents load local context (memories, skill lists,
// home paths) and the protocol logs record it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const pack = args.includes("--pack");
const root = args.find((a) => !a.startsWith("--")) ?? process.cwd();
const MAX_BYTES = 5_000_000;

const badNames = [
  ["raw agent log", (f) => /^m0\/results\/./.test(f) && !f.endsWith("README.md")],
  ["secret file", (f) => /(^|\/)\.env(\.[^/]*)?$/.test(f) && !/\.example$/.test(f)],
  ["secret file", (f) => /(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$|\.(pem|p12|pfx|key)$|(^|\/)(credentials|auth|token)s?\.json$|(^|\/)\.npmrc$|(^|\/)\.netrc$/i.test(f)],
];

const patterns = [
  ["home path", /\/(?:Users|home)\/(?!runner\/|USER\/|you\/|<)[A-Za-z0-9._-]+\//g],
  ["home path", /\b[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\\s]+/g],
  ["personal directory", /~\/(?:Downloads|Desktop|Documents|Projects|Library\/Mobile Documents)\/[^\s`'")]+/g],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["API key", /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{30,}|ctx7sk-[A-Za-z0-9-]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b/g],
  ["cloud credential", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\bya29\.[0-9A-Za-z_-]{20,}/g],
  ["payment or chat token", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b|\bwhsec_[A-Za-z0-9]{16,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b|hooks\.slack\.com\/services\/T[A-Za-z0-9]+/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/g],
  ["credential in URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi],
  ["email", /\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com|anthropic\.com|openai\.com|example\.(?:com|org)|[A-Za-z0-9-]+\.test\b)[A-Za-z0-9-]+\.[A-Za-z.]{2,}\b/g],
];

/** package-lock.json: registry URLs and integrity hashes are expected; every other line is scanned. */
const lockNoise = (line) => /"(?:resolved|integrity)":\s*"(?:https:\/\/registry\.npmjs\.org\/|sha\d+-)/.test(line);

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name), base) : [relative(base, join(dir, e.name))]);
}

let scanRoot = root, files, cleanup = () => {};
if (pack) {
  const tmp = mkdtempSync(join(tmpdir(), "turnweft-pack-"));
  cleanup = () => rmSync(tmp, { recursive: true, force: true });
  const out = execFileSync("npm", ["pack", "--json", "--pack-destination", tmp], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const tarball = join(tmp, JSON.parse(out)[0].filename);
  execFileSync("tar", ["-xzf", tarball, "-C", tmp]);
  scanRoot = join(tmp, "package");
  files = listFiles(scanRoot);
} else {
  files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
}

let found = 0;
const report = (where, rule) => { console.log(`${where}: ${rule}`); found++; };
for (const f of files) {
  for (const [rule, test] of badNames) if (test(f)) report(f, rule);
  const p = join(scanRoot, f);
  let buf;
  try { if (statSync(p).size > MAX_BYTES) { report(f, `not scanned: larger than ${MAX_BYTES} bytes`); continue; } buf = readFileSync(p); } catch { continue; }
  if (buf.subarray(0, 8000).includes(0)) { report(f, "not scanned: binary file"); continue; }
  const lock = f.endsWith("package-lock.json");
  buf.toString("utf8").split("\n").forEach((line, i) => {
    if (lock && lockNoise(line)) return;
    for (const [rule, re] of patterns) for (const _ of line.matchAll(re)) report(`${f}:${i + 1}`, rule);
  });
}
cleanup();
const what = pack ? "npm package" : relative(process.cwd(), root) || ".";
console.log(found ? `\n${found} finding(s) in ${what}` : `clean: ${files.length} files checked in ${what}`);
process.exit(found ? 1 : 0);
