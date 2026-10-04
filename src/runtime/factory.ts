import type { TurnweftService } from "../core/service.js";
import { LocalService } from "./service.js";

export async function createService(): Promise<TurnweftService> {
  return new LocalService();
}
