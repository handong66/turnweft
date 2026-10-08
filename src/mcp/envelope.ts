import type { Envelope } from "../core/types.js";
import type { JobView } from "../core/service.js";
import { deniedActionList, warningSummary } from "../core/denied-actions.js";
import { text } from "../core/i18n.js";

/** Shared by MCP and CLI, including status-only and recovered jobs without a final result. */
export function jobWarnings(view: JobView): string[] {
  const jobs = view.result?.concurrentWrites ?? view.job.concurrentWrites;
  const warnings = jobs?.length ? [text("concurrentWrites", { jobs: jobs.join(", ") })] : [];
  if (view.job.state === "waiting_confirmation" && view.job.confirmationMode === "fail-fast") warnings.push(text("markBlocked"));
  const summary = warningSummary(view.result ?? view.job);
  for (const code of summary.warningCodes ?? []) {
    if (code === "empty_output") warnings.push(text("emptyOutput"));
    else if (code === "truncated") warnings.push(text("truncatedOutput"));
    else if (code === "denied_actions") warnings.push(text("deniedActions", {
      count: String(summary.deniedActionsTotal ?? 0), actions: deniedActionList(summary),
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
