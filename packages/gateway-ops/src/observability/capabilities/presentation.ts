import type { CapabilityExecutionStatus, CapabilityValueMeta } from "@k2b/cloud/capabilities/store";
import type { CapabilityOrigin } from "@k2b/cloud/contracts";
import type { StatusTone } from "@k2b/ui";

/**
 * `denied` and `rejected` are refusals rather than defects, so they stay amber
 * and neutral: a red console teaches operators to ignore red.
 */
export const STATUS_TONE: Record<CapabilityExecutionStatus, StatusTone> = {
  succeeded: "ok",
  failed: "error",
  timed_out: "error",
  invalid_input: "warning",
  denied: "warning",
  rejected: "neutral",
};

export const ORIGIN_ICON: Record<CapabilityOrigin, string> = {
  assistant: "ti ti-sparkles",
  mcp: "ti ti-plug-connected",
  http: "ti ti-world",
  app: "ti ti-app-window",
};

/** A call slower than this is worth looking at even when it succeeded. */
export const SLOW_DURATION_MS = 5_000;

export type ValueShape = {
  type: CapabilityValueMeta["type"];
  /** Array length, string length or total object key count; null when the type has no size. */
  size: number | null;
  keys: string[];
  omittedKeys: number;
  /** Scalar rendering for numbers and booleans, which the store keeps verbatim. */
  value: string | null;
};

/** Shape metadata is a public contract but not a display contract; localise around this. */
export const valueShape = (meta: CapabilityValueMeta | null | undefined): ValueShape | null => {
  if (!meta) return null;
  if (meta.type === "object") {
    return { type: "object", size: meta.keys.length + meta.omittedKeys, keys: meta.keys, omittedKeys: meta.omittedKeys, value: null };
  }
  if (meta.type === "array") return { type: "array", size: meta.length, keys: [], omittedKeys: 0, value: null };
  if (meta.type === "string") return { type: "string", size: meta.length, keys: [], omittedKeys: 0, value: null };
  if (meta.type === "number" || meta.type === "boolean") {
    return { type: meta.type, size: null, keys: [], omittedKeys: 0, value: String(meta.value) };
  }
  return { type: meta.type, size: null, keys: [], omittedKeys: 0, value: null };
};
