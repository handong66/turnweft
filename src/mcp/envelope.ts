import type { Envelope } from "../core/types.js";
import type { JobView } from "../core/service.js";
import { text } from "../core/i18n.js";

/** Shared by MCP and CLI, including status-only and recovered jobs without a final result. */
export function jobWarnings(view: JobView): string[] {
  const jobs = view.result?.concurrentWrites ?? view.job.concurrentWrites;
  const warnings = jobs?.length ? [text("concurrentWrites", { jobs: jobs.join(", ") })] : [];
  for (const code of view.result?.warningCodes ?? []) {
    const denied = view.result?.deniedActions ?? [];
    warnings.push(code === "empty_output" ? text("emptyOutput") : text("deniedActions", {
      count: String(denied.length), actions: denied.map(d => `${d.kind}:${d.title}`).join(", "),
    }));
  }
  return warnings;
}

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
