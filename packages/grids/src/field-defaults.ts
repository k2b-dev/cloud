import { type DateContext, dates } from "@k2b/stdlib";

export const isDateNowDefault = (value: unknown): value is { kind: "now" } =>
  typeof value === "object" && value !== null && "kind" in value && value.kind === "now" && Object.keys(value).length === 1;

/** Shared by server writes and form initialization; callers choose the instant. */
export const materializeFieldDefault = (
  field: { type: string; config: Record<string, unknown>; defaultValue: unknown },
  options: { dateConfig?: DateContext; now?: Date } = {},
): unknown => {
  if (field.type !== "date" || !isDateNowDefault(field.defaultValue)) return field.defaultValue;
  const now = options.now ?? new Date();
  return field.config.includeTime === true ? now.toISOString() : dates.formatDateKey(now, options.dateConfig);
};
