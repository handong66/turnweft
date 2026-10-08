import type { DeniedAction, ResultWarnings } from "./types.js";
import { text, type Language } from "./i18n.js";

export const MAX_DENIED_ACTIONS = 50;
const DISPLAY_LIMIT = 5;

/** Bounded even when every denied command is different. Both denial sources share this collector. */
export class DeniedActions {
  private entries = new Map<string, DeniedAction>();
  total = 0;

  add(action: DeniedAction) {
    const count = action.count ?? 1;
    this.total += count;
    const key = `${action.kind}:${action.title}`;
    const existing = this.entries.get(key);
    if (existing) existing.count = (existing.count ?? 1) + count;
    else if (this.entries.size < MAX_DENIED_ACTIONS) this.entries.set(key, { ...action, count });
  }

  summary(): ResultWarnings {
    return this.total ? { deniedActions: [...this.entries.values()], deniedActionsTotal: this.total } : {};
  }
}

/** Also normalizes pre-cap results without changing the stored historical result. */
export function warningSummary(result: ResultWarnings): ResultWarnings {
  const denied = new DeniedActions();
  for (const action of result.deniedActions ?? []) denied.add(action);
  const summary = denied.summary();
  if (result.deniedActionsTotal !== undefined) summary.deniedActionsTotal = result.deniedActionsTotal;
  return { ...summary, ...(result.warningCodes?.length ? { warningCodes: [...new Set(result.warningCodes)] } : {}) };
}

export function deniedActionList(summary: ResultWarnings, language?: Language): string {
  const shown = (summary.deniedActions ?? []).slice(0, DISPLAY_LIMIT);
  const labels = shown.map(d => {
    const label = `${d.kind}:${d.title}`;
    return `${label.length > 200 ? label.slice(0, 200) + "…" : label}${(d.count ?? 1) > 1 ? ` (×${d.count})` : ""}`;
  });
  const total = summary.deniedActionsTotal ?? (summary.deniedActions ?? []).reduce((n, d) => n + (d.count ?? 1), 0);
  const remaining = total - shown.reduce((n, d) => n + (d.count ?? 1), 0);
  if (remaining > 0) labels.push(text("deniedActionsMore", { count: String(remaining) }, language));
  return labels.join(", ");
}
