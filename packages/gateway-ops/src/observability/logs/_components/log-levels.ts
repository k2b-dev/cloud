import type { StatusTone } from "@k2b/ui";

/** The base keeps the current filters; the entry id is the last parameter. */
export const entryHref = (base: string, id: string): string => `${base}${base.includes("?") ? "&" : "?"}entry=${encodeURIComponent(id)}`;

export const LEVEL: Record<string, { icon: string; tone: StatusTone; label: string }> = {
  debug: { icon: "ti ti-bug", tone: "neutral", label: "debug" },
  info: { icon: "ti ti-info-circle", tone: "info", label: "info" },
  warn: { icon: "ti ti-alert-triangle", tone: "warning", label: "warn" },
  error: { icon: "ti ti-alert-circle", tone: "error", label: "error" },
};
