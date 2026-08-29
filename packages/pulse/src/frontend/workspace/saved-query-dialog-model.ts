import type { PulseExplorerQuery } from "../../contracts";
import { pulseMessages } from "../../messages";

export type SavedQueryDialogResult = {
  description: string | null;
  name: string;
};

type SaveQueryFormResult = Record<string, unknown> | null | undefined;

const cleanText = (value: unknown): string => String(value ?? "").trim();

export const defaultSavedQueryName = (
  compiled: PulseExplorerQuery | null,
  t = pulseMessages.resolve().t,
): string => {
  if (!compiled) return t.pulseQuery;
  if (compiled.kind === "metric") return compiled.metric;
  if (compiled.kind === "events") return compiled.event || t.allEvents;
  return compiled.state || t.allStates;
};

export const normalizeSavedQueryDialogResult = (result: SaveQueryFormResult): SavedQueryDialogResult | null => {
  const name = cleanText(result?.name);
  return name ? { name, description: cleanText(result?.description) || null } : null;
};
