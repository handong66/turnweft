import type { Envelope } from "../core/types.js";

export function success<T>(data: T, warnings: string[] = []): Envelope<T> {
  return { ok: true, data, error: null, warnings };
}

export function failure(code: string, message: string): Envelope<never> {
  return { ok: false, data: null, error: { code, message }, warnings: [] };
}

export function serviceFailure(error: unknown): Envelope<never> {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : "service_error";
  return failure(code, error instanceof Error ? error.message : "Service request failed");
}
