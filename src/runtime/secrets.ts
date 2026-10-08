// Redact configured provider values at persistence/output boundaries, including values from earlier
// launches in this process after config rotation. Never persist the environment itself.
import { loadConfig } from "./config.js";
import { stateDir } from "./paths.js";
const known = new Map<string, Set<string>>();

export function rememberProviderValues(entries: string[]): void {
  const home = stateDir();
  const values = known.get(home) ?? new Set<string>();
  for (const value of entries) if (value) values.add(value);
  known.set(home, values);
}

export function providerValues(): string[] {
  const home = stateDir();
  const values = known.get(home) ?? new Set<string>();
  for (const env of Object.values(loadConfig().providerEnv ?? {})) {
    if (env && typeof env === "object" && !Array.isArray(env)) {
      for (const value of Object.values(env)) if (typeof value === "string" && value) values.add(value);
    }
  }
  known.set(home, values);
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
