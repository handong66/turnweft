// Environment for a provider process. Its own directory goes first on PATH, so a CLI found outside the
// host's PATH (see resolveExecutable) can still find the helpers installed next to it. The Node running
// Turnweft is appended when PATH has no node, so a CLI that is a `#!/usr/bin/env node` script still starts.
import { delimiter, dirname, isAbsolute } from "node:path";

export function providerEnv(exe: string, base: NodeJS.ProcessEnv = process.env, nodeDir = dirname(process.execPath)): NodeJS.ProcessEnv {
  const parts = (base.PATH ?? "").split(delimiter).filter(Boolean);
  const own = isAbsolute(exe) ? dirname(exe) : undefined;
  const out = own ? [own, ...parts.filter((d) => d !== own)] : [...parts]; // moved to the front if already present
  if (!out.includes(nodeDir)) out.push(nodeDir);
  const path = out.join(delimiter);
  return path === (base.PATH ?? "") ? base : { ...base, PATH: path };
}
