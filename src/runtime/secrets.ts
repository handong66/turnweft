// Redact provider values of at least 8 characters at persistence/output boundaries. Short flags
// (e.g. 1/true) are not secrets for this heuristic; provider launch values stay unchanged.
// Launch snapshots remain protected for this process's lifetime, even after config rotation.
import { statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { stateDir } from "./paths.js";
const known = new Map<string, Set<string>>();
const configured = new Map<string, { mtimeMs: number; size: number; values: string[] }>();
const secretLike = (value: unknown): value is string => typeof value === "string" && value.length >= 8;

export function rememberProviderValues(entries: string[]): void {
  const home = stateDir();
  const values = known.get(home) ?? new Set<string>();
  for (const value of entries) if (secretLike(value)) values.add(value);
  known.set(home, values);
}

export function providerValues(): string[] {
  const home = stateDir();
  let cache = configured.get(home);
  try {
    const { mtimeMs, size } = statSync(join(home, "config.json"));
    if (!cache || cache.mtimeMs !== mtimeMs || cache.size !== size) {
      const values = new Set<string>();
      for (const env of Object.values(loadConfig().providerEnv ?? {})) {
        if (env && typeof env === "object" && !Array.isArray(env)) {
          for (const value of Object.values(env)) if (secretLike(value)) values.add(value);
        }
      }
      cache = { mtimeMs, size, values: [...values] };
      configured.set(home, cache);
    }
  } catch {
    configured.delete(home);
    cache = undefined;
  }
  // Replace config-only values on refresh; only actual launch snapshots survive removal.
  const values = new Set([...(known.get(home) ?? []), ...(cache?.values ?? [])]);
  return [...values].sort((a, b) => b.length - a.length);
}

export function redact<T>(value: T): T {
  const secrets = providerValues();
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") {
      for (const secret of secrets) v = (v as string).split(secret).join("[REDACTED]");
      return v;
    }
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
    return v;
  };
  return visit(value) as T;
}

export function providerError(message: string, provider: string): string {
  return redact(`${message}; if required environment variables are missing, set providerEnv.${provider} in ~/.turnweft/config.json yourself (agents must not edit it)`);
}
