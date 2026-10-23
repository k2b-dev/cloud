import { z } from "zod";

/** Geoapify plans in the order the administration offers them. */
export const GEO_PLAN_IDS = ["free", "api10", "api25", "api50", "api100", "api250", "custom"] as const;
export type GeoPlanId = (typeof GEO_PLAN_IDS)[number];

/**
 * Ledger function groups in display order. Every paid geo call reserves under one of these groups;
 * the administration shows one share line per group.
 */
export const GEO_USAGE_GROUPS = ["tiles", "places", "route", "address"] as const;
export type GeoUsageGroup = (typeof GEO_USAGE_GROUPS)[number];

/** Largest credit value a geo budget setting accepts (stored as thousandths in a bigint ledger). */
export const GEO_MAX_CREDITS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
/** Largest custom request rate the token bucket accepts. */
export const GEO_MAX_RPS = Math.floor(Number.MAX_SAFE_INTEGER / 9000);
/** Upper bound of a pasted provider key; Geoapify keys are 32 characters. */
export const GEO_MAX_KEY_LENGTH = 256;

export type GeoAdminPerson = { id: string; name: string };

export type GeoAdminKey = {
  /** `unreadable`: a stored key exists but this installation cannot decrypt it; geo is off until it is replaced or removed. */
  state: "none" | "set" | "unreadable";
  setAt: string | null;
  setBy: GeoAdminPerson | null;
};

export type GeoAdminBudget = {
  plan: GeoPlanId;
  customRps: number;
  customDailyCredits: number;
  monthlyCredits: number;
  personDailyCredits: number;
  /** Budget settings whose stored value cannot be read; saving the form replaces them. */
  unreadable: Array<GeoBudgetField | "plan">;
  changedAt: string | null;
  changedBy: GeoAdminPerson | null;
};

export type GeoAdminStatus = {
  key: GeoAdminKey;
  budget: GeoAdminBudget;
  plans: Record<Exclude<GeoPlanId, "custom">, { dailyCredits: number; rps: number }>;
  /** `app.timezone`: dates on the page and the budget periods use it. */
  timezone: string;
};

export type GeoAdminUsage = {
  /** Credits. Values may carry fractions (a map tile costs 0.25). */
  month: { period: string; used: number; limit: number; resetsAt: string };
  /** Cloud-wide use today against the provider's daily allowance of the selected plan. */
  today: { period: string; used: number; allowance: number; resetsAt: string };
  shares: Array<{ group: GeoUsageGroup; credits: number }>;
  /** Access subjects whose use today reached the per-person daily limit. */
  peopleAtLimit: number;
  timezone: string;
};

export const GeoKeyInputSchema = z.object({ apiKey: z.string().max(GEO_MAX_KEY_LENGTH * 4) }).strict();

export const GeoBudgetInputSchema = z
  .object({
    plan: z.enum(GEO_PLAN_IDS),
    customRps: z.unknown(),
    customDailyCredits: z.unknown(),
    monthlyCredits: z.unknown(),
    personDailyCredits: z.unknown(),
  })
  .strict();
export type GeoBudgetInput = z.infer<typeof GeoBudgetInputSchema>;
export type GeoBudgetField = "customRps" | "customDailyCredits" | "monthlyCredits" | "personDailyCredits";

/** Stable field error codes; the page renders their text. */
export const GeoBudgetFieldErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("not_whole_number") }),
  z.object({ code: z.literal("too_small"), min: z.number() }),
  z.object({ code: z.literal("too_large"), max: z.number() }),
  z.object({ code: z.literal("above_monthly"), max: z.number() }),
]);
export type GeoBudgetFieldError = z.infer<typeof GeoBudgetFieldErrorSchema>;
/** The 400 answer of a refused budget save. */
export const GeoBudgetRefusalSchema = z.object({
  code: z.literal("geo_budget_invalid"),
  errors: z.partialRecord(z.enum(["customRps", "customDailyCredits", "monthlyCredits", "personDailyCredits"]), GeoBudgetFieldErrorSchema),
});

export type GeoKeyError =
  | { code: "geo_key_missing" }
  | { code: "geo_key_malformed" }
  | { code: "geo_key_rejected" }
  | { code: "geo_key_unverified" };

/** Validate one budget number; `null` when it is acceptable. */
const checkNumber = (value: unknown, min: number, max: number): GeoBudgetFieldError | null => {
  if (typeof value !== "number" || !Number.isInteger(value)) return { code: "not_whole_number" };
  if (value < min) return { code: "too_small", min };
  if (value > max) return { code: "too_large", max };
  return null;
};

/** Check the whole form before anything is written; the same rules as the settings registry plus the pair rule. */
export const validateGeoBudget = (input: GeoBudgetInput) => {
  const errors: Partial<Record<GeoBudgetField, GeoBudgetFieldError>> = {};
  const fields: Array<[GeoBudgetField, number, number]> = [
    ["monthlyCredits", 0, GEO_MAX_CREDITS],
    ["personDailyCredits", 0, GEO_MAX_CREDITS],
  ];
  if (input.plan === "custom") fields.push(["customRps", 1, GEO_MAX_RPS], ["customDailyCredits", 1, GEO_MAX_CREDITS]);
  for (const [field, min, max] of fields) {
    const error = checkNumber(input[field], min, max);
    if (error) errors[field] = error;
  }
  const month = input.monthlyCredits,
    day = input.personDailyCredits;
  if (!errors.monthlyCredits && !errors.personDailyCredits && typeof month === "number" && typeof day === "number" && day > month)
    errors.personDailyCredits = { code: "above_monthly", max: month };
  return errors;
};

/** Shape check before the provider sees a key: printable ASCII without spaces, as Geoapify issues them. */
export const geoKeyProblem = (apiKey: string): "geo_key_missing" | "geo_key_malformed" | null => {
  if (!apiKey) return "geo_key_missing";
  if (apiKey.length > GEO_MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(apiKey)) return "geo_key_malformed";
  return null;
};
