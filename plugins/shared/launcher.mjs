#!/usr/bin/env node
// Turnweft plugin launcher. Single source: plugins/shared/launcher.mjs, copied into each plugin by
// scripts/sync-launcher.mjs (plugins are installed as separate copies, so each needs its own file).
//
// Desktop hosts started from the Dock may not inherit the shell PATH, so `turnweft mcp` alone can fail.
// This launcher finds the installed runtime (one copy shared by Claude Code and Codex), checks versions,
// and runs `turnweft mcp`. If it cannot, it serves a minimal MCP server whose only tool explains how to
// install or upgrade, so the host shows a readable reason instead of "MCP failed to start".
// It never downloads or installs anything.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const MIN_RUNTIME = "0.1.0-alpha.4";
const MIN_NODE = "22.13.0";
const HOME = homedir();

// Standalone plugins cannot import the runtime's message catalog before it is installed.
let appleLanguage;
function language() {
  if (["en", "zh"].includes(process.env.TURNWEFT_LANG)) return process.env.TURNWEFT_LANG;
  try {
    const configured = JSON.parse(readFileSync(join(process.env.TURNWEFT_HOME ?? join(homedir(), ".turnweft"), "config.json"), "utf8")).language;
    if (["en", "zh"].includes(configured)) return configured;
  } catch { /* no config */ }
  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const locale = process.env[key]?.trim();
    if (locale) return /^zh/i.test(locale) ? "zh" : "en";
  }
  if (process.platform !== "darwin") return "en";
  if (appleLanguage === undefined) {
    const result = spawnSync("defaults", ["read", "-g", "AppleLanguages"], { encoding: "utf8", timeout: 5000 });
    const first = result.status === 0 && result.stdout?.match(/\(\s*"?([^",\s)]+)/)?.[1];
    appleLanguage = first && /^zh/i.test(first) ? "zh" : "en";
  }
  return appleLanguage;
}

const messages = {
  zh: {
    missing: "找不到 Turnweft 运行时（turnweft 命令）。请在终端运行 `npm install -g turnweft`，装好后重启 Claude Code / Codex。若装在非常规位置，可设置 TURNWEFT_BIN 指向 turnweft。",
    old: (runtime) => `Turnweft 运行时版本 ${runtime.version} 低于插件要求的 ${MIN_RUNTIME}（位置：${runtime.bin}）。请运行 npm install -g turnweft 升级后重启宿主。`,
    node: `Turnweft 需要 Node.js ${MIN_NODE} 或更高版本，当前启动插件的是 ${process.versions.node}，也没有找到更新的 node。请安装新版 Node.js 后重启宿主。`,
  },
  en: {
    missing: "Turnweft runtime (turnweft command) was not found. Run `npm install -g turnweft` in a terminal, then restart Claude Code / Codex. For a custom location, set TURNWEFT_BIN to the turnweft executable.",
    old: (runtime) => `Turnweft runtime ${runtime.version} is older than the plugin requires (${MIN_RUNTIME}, at ${runtime.bin}). Run npm install -g turnweft to upgrade, then restart the host.`,
    node: `Turnweft requires Node.js ${MIN_NODE} or later. This plugin was launched with ${process.versions.node}, and no newer node was found. Install a newer Node.js and restart the host.`,
  },
};

function cmp(a, b) {
  const pa = String(a).split(/[.-]/), pb = String(b).split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "", y = pb[i] ?? "";
    const nx = Number(x), ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) { if (nx !== ny) return nx - ny; continue; }
    if (x !== y) return x === "" ? 1 : y === "" ? -1 : x < y ? -1 : 1; // release > prerelease
  }
  return 0;
}

function candidateBinDirs() {
  const dirs = new Set((process.env.PATH ?? "").split(delimiter).filter(Boolean));
  for (const d of ["/opt/homebrew/bin", "/usr/local/bin", join(HOME, ".npm-global/bin"), join(HOME, ".volta/bin"),
    join(HOME, ".local/bin"), join(HOME, ".turnweft/bin"), join(HOME, "Library/pnpm"), join(HOME, ".bun/bin")]) dirs.add(d);
  const nvm = join(HOME, ".nvm/versions/node");
  if (existsSync(nvm)) for (const v of readdirSync(nvm)) dirs.add(join(nvm, v, "bin"));
  const npmPrefix = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8", timeout: 5000 });
  if (npmPrefix.status === 0 && npmPrefix.stdout.trim()) dirs.add(join(npmPrefix.stdout.trim(), "bin"));
  return [...dirs];
}

/** Locate the runtime entry (dist/cli/main.js) and its package version. */
function findRuntime() {
  const explicit = process.env.TURNWEFT_BIN;
  const bins = explicit ? [explicit] : candidateBinDirs().map((d) => join(d, "turnweft"));
  for (const bin of bins) {
    if (!existsSync(bin)) continue;
    let main;
    try { main = realpathSync(bin); } catch { continue; }
    // Walk up from dist/cli/main.js to the package root.
    let dir = dirname(main);
    for (let i = 0; i < 5; i++, dir = dirname(dir)) {
      const pj = join(dir, "package.json");
      if (!existsSync(pj)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pj, "utf8"));
        if (pkg.name === "turnweft") return { bin, main, version: pkg.version, binDir: dirname(bin) };
      } catch { /* keep walking */ }
    }
  }
  return undefined;
}

function nodeVersion(exe) {
  const r = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? r.stdout.trim().replace(/^v/, "") : undefined;
}

/** Prefer the node running this launcher; otherwise a node next to the runtime or on the search path. */
function findNode(runtime) {
  if (cmp(process.versions.node, MIN_NODE) >= 0) return process.execPath;
  const dirs = [runtime?.binDir, ...candidateBinDirs()].filter(Boolean);
  for (const d of dirs) {
    const exe = join(d, "node");
    const v = existsSync(exe) && nodeVersion(exe);
    if (v && cmp(v, MIN_NODE) >= 0) return exe;
  }
  return undefined;
}

function serveSetupMessage(message) {
  // Minimal stdio MCP server: initialize, tools/list, tools/call -> the setup message.
  const tool = { name: "turnweft_setup", description: "Turnweft is not ready on this machine. Call this to see why and how to fix it.", inputSchema: { type: "object", properties: {} } };
  let buf = "";
  const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  process.stderr.write(`[turnweft launcher] ${message}\n`);
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === undefined) continue;
      if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "turnweft-setup", version: "0" }, instructions: message } });
      else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [tool] } });
      else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: message }] } });
      else send({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  });
}

const runtime = findRuntime();
if (!runtime) {
  serveSetupMessage(messages[language()].missing);
} else if (cmp(runtime.version, MIN_RUNTIME) < 0) {
  serveSetupMessage(messages[language()].old(runtime));
} else {
  const node = findNode(runtime);
  if (!node) {
    serveSetupMessage(messages[language()].node);
  } else {
    const child = spawn(node, [runtime.main, "mcp"], { stdio: "inherit", env: { ...process.env, TURNWEFT_LAUNCHED_BY: "plugin" } });
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => child.kill(sig));
    child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  }
}
