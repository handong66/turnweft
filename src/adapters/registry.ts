import type { ProviderId } from "../core/types.js";
import { fakeAdapter } from "./fake.js";
import { ADAPTERS } from "./providers.js";
import type { Adapter } from "./types.js";

export function getAdapter(provider: ProviderId): Adapter {
  if (process.env.TURNWEFT_FAKE_ADAPTERS === "1") return fakeAdapter(provider);
  const a = ADAPTERS[provider];
  if (!a) throw new Error(`unknown provider ${provider}`);
  return a;
}
