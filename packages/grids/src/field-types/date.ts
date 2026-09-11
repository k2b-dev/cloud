import { z } from "zod";
import { fail, ok, type ValueFieldType } from "./types";
import { fieldValidationMessages } from "./validation-messages";

const DateConfigSchema = z
  .object({
    includeTime: z.boolean().optional(),
    min: z.string().optional(),
    max: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const includeTime = data.includeTime ?? false;
    const min = data.min === undefined ? null : parseAndCanonicalize(data.min, includeTime);
    const max = data.max === undefined ? null : parseAndCanonicalize(data.max, includeTime);
    if (data.min !== undefined && min === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: includeTime ? "min must be a timezone-aware ISO date-time" : "min must be an ISO date",
        path: ["min"],
      });
    }
    if (data.max !== undefined && max === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: includeTime ? "max must be a timezone-aware ISO date-time" : "max must be an ISO date",
        path: ["max"],
      });
    }
    if (min !== null && max !== null && min > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "min cannot exceed max",
        path: ["min"],
      });
    }
  });

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[zZ]|[+-]\d{2}:?\d{2})$/;

const isValidDateOnly = (value: string): boolean => {
  if (!DATE_ONLY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

const normalizeInstant = (raw: string): string | null => {
  if (!INSTANT_RE.test(raw)) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
};

const parseAndCanonicalize = (raw: string, includeTime: boolean): string | null => {
  if (includeTime) {
    return normalizeInstant(raw);
  }
  // Date-only fields keep the calendar date the user supplied. If an
  // API caller sends a timestamp, use its leading YYYY-MM-DD date part
  // instead of converting through UTC and potentially shifting the day.
  const date = DATE_PREFIX_RE.exec(raw)?.[1];
  return date && isValidDateOnly(date) ? date : null;
};

export const dateHandler: ValueFieldType = {
  type: "date",
  kind: "value",
  configSchema: DateConfigSchema,
  validate(raw, configRaw, required, context) {
    const t = fieldValidationMessages(context?.locale);
    const parsed = DateConfigSchema.safeParse(configRaw ?? {});
    if (!parsed.success) return fail(t.config);
    const config = parsed.data;

    if (raw === null || raw === undefined || raw === "") {
      return required ? fail(t.required) : ok(null);
    }
    if (typeof raw !== "string") return fail(t.dateString);

    const canonical = parseAndCanonicalize(raw, config.includeTime ?? false);
    if (canonical === null) return fail(t.date);

    if (config.min !== undefined) {
      const cMin = parseAndCanonicalize(config.min, config.includeTime ?? false);
      if (cMin === null) return fail(t.minConfig);
      if (canonical < cMin) return fail(t.min({ value: config.min }));
    }
    if (config.max !== undefined) {
      const cMax = parseAndCanonicalize(config.max, config.includeTime ?? false);
      if (cMax === null) return fail(t.maxConfig);
      if (canonical > cMax) return fail(t.max({ value: config.max }));
    }

    return ok(canonical);
  },
};
