// Provider profiles, grounded in docs/m0/M0_RESULTS.md. Each entry says how an intent maps onto
// native controls and what that tier allows beyond the grant (U11 excess, shown to the user).
import type { Message } from "../core/i18n.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import type { AgentCapabilities, Intent, ProbeResult, ProviderId } from "../core/types.js";
import { loadConfig } from "../runtime/config.js";
import { AcpConnection, type AcpProfile } from "./acp.js";
import { AgyConnection } from "./agy.js";
import { providerEnv } from "./env.js";
import type { Adapter, ConnectHooks, Connection, PermissionKind, TierSpec } from "./types.js";

export const ADAPTER_VERSION = "0.1.0";

const DIM_APP_CLI = "/Applications/DimAgent.app/Contents/Resources/runtime/cli/dim";

/** A regular file this process may execute (a directory or a non-executable file of the same name is skipped). */
function isExecutable(p: string): boolean {
  try { return statSync(p).isFile() && (accessSync(p, constants.X_OK), true); } catch { return false; }
}

function which(cmd: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(dir, cmd);
    if (dir && isExecutable(p)) return p;
  }
  return undefined;
}

/**
 * Common install locations, checked after PATH: hosts started from the GUI (Dock, Finder) often get a
 * minimal PATH without the user's shell additions.
 */
export function fallbackLocations(provider: ProviderId): string[] {
  const home = homedir();
  const common = [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const extra: Partial<Record<ProviderId, string[]>> = {
    dim: [dirname(DIM_APP_CLI)],
    opencode: [join(home, ".opencode", "bin")],
  };
  return [...common, ...(extra[provider] ?? [])].map((d) => join(d, provider));
}

/** Configured path, else PATH, else the fallback locations. A configured path is never silently replaced. */
export function resolveExecutable(provider: ProviderId, fallbacks = fallbackLocations(provider)): string | undefined {
  const configured = loadConfig().executables?.[provider];
  if (configured) return isExecutable(configured) ? configured : undefined;
  return which(provider) ?? fallbacks.find(isExecutable);
}

function missingExecutable(provider: ProviderId): string {
  const configured = loadConfig().executables?.[provider];
  return configured
    ? `executables.${provider} in ~/.turnweft/config.json (${configured}) is not an executable file`
    : `${provider} executable not found (set executables.${provider} in ~/.turnweft/config.json)`;
}

function version(exe: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(exe, ["--version"], { timeout: 15000, env: providerEnv(exe) }, (err, stdout) => {
      if (err) return resolve(undefined);
      const m = String(stdout).match(/\d+\.\d+\.\d+(?:[-+.\w]*)?(?:\s*\([0-9a-f]+\))?/);
      resolve(m ? m[0] : String(stdout).trim().slice(0, 60));
    });
  });
}

const READ_KINDS: PermissionKind[] = ["read", "search", "think", "fetch"];
const analyzeDecide = (kind: PermissionKind | undefined) => (kind && READ_KINDS.includes(kind) ? "allow" : "deny");
const implementDecide = (kind: PermissionKind | undefined) => (kind === "switch_mode" ? "deny" : "allow");

const AUTO_APPROVE_NOTE = (name: string): Message => ({ key: "autoApprove", params: { name } });

function tier(t: string, excess: Message[], decide: TierSpec["decide"], satisfiedBy: TierSpec["satisfiedBy"] = () => true): TierSpec {
  return { tier: t, excess, decide, satisfiedBy };
}

const acpCaps = (permissions: AgentCapabilities["permissions"], resume: AgentCapabilities["resumeAfterRestart"]): AgentCapabilities => ({
  transport: "acp", multiTurn: true, resumeAfterRestart: resume, cancelTurn: "protocol",
  permissions, structuredEvents: "exact", modelConfig: "session", effortConfig: "session",
});

function grokPermissionMode(): string {
  try {
    const toml = readFileSync(join(homedir(), ".grok", "config.toml"), "utf8");
    const m = toml.match(/^\s*permission_mode\s*=\s*"([^"]+)"/m);
    return m?.[1] ?? "default";
  } catch { return "default"; }
}
/** Summarize the user's OpenCode permission config (global opencode.json); project files are not consulted. */
function opencodePermissionSummary(): { key: string; text: Message } {
  for (const f of [join(homedir(), ".config", "opencode", "opencode.json"), join(homedir(), ".config", "opencode", "opencode.jsonc")]) {
    try {
      const raw = readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "");
      const perm = JSON.parse(raw).permission;
      if (perm == null) return { key: "default", text: { key: "openDefault" } };
      return { key: sha8(JSON.stringify(perm)), text: { key: "openConfig", params: { config: JSON.stringify(perm).slice(0, 200) } } };
    } catch { /* try next */ }
  }
  return { key: "default", text: { key: "openMissing" } };
}
const sha8 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);

const GROK_UNGATED = ["always-approve", "bypassPermissions", "bypass-permissions", "dontAsk", "auto"];

interface ProfileDef {
  provider: ProviderId;
  capabilities: AgentCapabilities;
  acp?: (exe: string) => AcpProfile;
  tierFor(intent: Intent): TierSpec;
}

const notFoundBy = (re: RegExp, codes: number[] = []) => (e: unknown) => {
  const x = e as { code?: number; message?: string };
  return (x?.code !== undefined && codes.includes(x.code)) || re.test(String(x?.message ?? ""));
};

const DEFS: ProfileDef[] = [
  {
    provider: "dim",
    capabilities: acpCaps("callback", "supported"),
    acp: (exe) => ({
      command: exe, args: ["acp"],
      settingsFor: (t) => [["permission", t.tier === "workspace-write" ? "workspace-write" : "read-only"]],
      isSessionNotFound: notFoundBy(/session not found/i, [-32002]),
    }),
    tierFor: (intent) => intent === "implement"
      ? tier("workspace-write", [{ key: "dimGit" }, AUTO_APPROVE_NOTE("Dim")], implementDecide, (e) => e.permission === "workspace-write")
      : tier("read-only", [], analyzeDecide, (e) => e.permission === "read-only"),
  },
  {
    provider: "droid",
    capabilities: acpCaps("callback", "supported"),
    acp: (exe) => ({
      command: exe, args: ["exec", "--output-format", "acp"],
      settingsFor: () => [["autonomy_level", "normal"]],
      isSessionNotFound: notFoundBy(/unknown session/i, [-32602]),
    }),
    tierFor: (intent) => intent === "implement"
      ? tier("normal+callback", [AUTO_APPROVE_NOTE("Droid")], implementDecide, (e) => e.autonomy_level === "normal")
      : tier("normal+callback-readonly", [], analyzeDecide, (e) => e.autonomy_level === "normal"),
  },
  {
    provider: "grok",
    capabilities: acpCaps("callback", "supported"),
    acp: (exe) => ({
      command: exe, args: ["agent", "--no-leader", "stdio"],
      settingsFor: () => [],
      isSessionNotFound: notFoundBy(/path not found|not found/i),
      staticEffective: () => ({ permission_mode: grokPermissionMode() }),
    }),
    // Grok's ACP exposes no permission option, so the real mode cannot be read back (review finding 5).
    // The config-file value is disclosed as unverified and always goes through U11 confirmation.
    tierFor: (intent) => {
      const mode = grokPermissionMode();
      const unverified: Message = { key: "grokUnverified", params: { mode } };
      if (GROK_UNGATED.includes(mode)) {
        const note: Message = { key: "grokUngated", params: { mode } };
        return intent === "implement"
          ? tier(`user-config:${mode}`, [note, unverified], implementDecide)
          : tier(`user-config:${mode}`, [note, { key: "grokReadonly" }, unverified], analyzeDecide);
      }
      return intent === "implement"
        ? tier(`config:${mode}+callback`, [AUTO_APPROVE_NOTE("Grok"), unverified], implementDecide)
        : tier(`config:${mode}+callback-readonly`, [unverified], analyzeDecide);
    },
  },
  {
    provider: "opencode",
    // Live (ling-3.1-flash-free): write, L1, kill + session/load (L2) and cancel verified. In build mode OpenCode
    // sent no permission requests: it follows its own permission config, which Turnweft cannot read back.
    capabilities: acpCaps("native-policy", "supported"),
    acp: (exe) => ({
      command: exe, args: ["acp"],
      settingsFor: (t) => [["mode", t.tier.startsWith("build") ? "build" : "plan"]],
      isSessionNotFound: notFoundBy(/not found|service failure/i),
    }),
    tierFor: (intent) => {
      const perm = opencodePermissionSummary();
      return intent === "implement"
        ? tier(`build+config:${perm.key}`, [
            { key: "openPolicy", params: { summary: perm.text } },
            { key: "openUnverified" },
          ], implementDecide, (e) => e.mode === "build")
        : tier("plan+callback-readonly", [], analyzeDecide, (e) => e.mode === "plan");
    },
  },
  {
    provider: "agy",
    capabilities: {
      transport: "native-stream", multiTurn: true, resumeAfterRestart: "supported", cancelTurn: "process",
      permissions: "native-policy", structuredEvents: "inferred", modelConfig: "launch", effortConfig: "launch",
    },
    // Live run: with accept-edits alone, the first command without an allow rule ends the turn before any edit
    // (permission_blocked). The implement tier therefore skips agy's prompts; U11 confirms it once and every
    // result reports it. agy's own settings files are not modified.
    tierFor: (intent) => intent === "implement"
      ? tier("skip-permissions+accept-edits", [{ key: "agyUngated" }], implementDecide, (e) => e.permission_mode === "always-proceed")
      : tier("request-review", [], analyzeDecide, (e) => e.permission_mode === "request-review"),
  },
];

function makeAdapter(def: ProfileDef): Adapter {
  return {
    provider: def.provider,
    adapterVersion: ADAPTER_VERSION,
    capabilities: def.capabilities,
    async probe(): Promise<ProbeResult> {
      const exe = resolveExecutable(def.provider);
      const base = { provider: def.provider, adapterVersion: ADAPTER_VERSION, probedAt: new Date().toISOString() };
      if (!exe) return { ...base, available: false, problems: [missingExecutable(def.provider)] };
      const v = await version(exe);
      const problems: string[] = [];
      if (!v) problems.push("could not read --version");
      if (def.provider === "grok") problems.push(`grok permission_mode=${grokPermissionMode()} (from ~/.grok/config.toml)`);
      return { ...base, available: Boolean(v), executable: exe, cliVersion: v, capabilities: def.capabilities, problems };
    },
    tierFor: (intent) => def.tierFor(intent),
    connect(cwd: string, hooks?: ConnectHooks): Connection {
      const exe = resolveExecutable(def.provider);
      if (!exe) throw new Error(missingExecutable(def.provider));
      return def.acp ? new AcpConnection(def.acp(exe), cwd, hooks) : new AgyConnection(exe, cwd, hooks);
    },
  };
}

export const ADAPTERS: Record<ProviderId, Adapter> = Object.fromEntries(DEFS.map((d) => [d.provider, makeAdapter(d)])) as Record<ProviderId, Adapter>;
