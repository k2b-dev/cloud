import { z } from "zod";
import { readStates } from "../settings/store";

export const GEO_PLANS = {
  free: { dailyCredits: 3000, rps: 5 },
  api10: { dailyCredits: 10000, rps: 12 },
  api25: { dailyCredits: 25000, rps: 15 },
  api50: { dailyCredits: 50000, rps: 20 },
  api100: { dailyCredits: 100000, rps: 25 },
  api250: { dailyCredits: 250000, rps: 30 },
} as const;
const ConfigSchema = z.object({
  apiKey: z.string(),
  timezone: z.string(),
  plan: z.enum(["free", "api10", "api25", "api50", "api100", "api250", "custom"]),
  customRps: z.number().int().positive(),
  customDailyCredits: z.number().int().positive(),
  monthlyCredits: z.number().int().nonnegative(),
  personDailyCredits: z.number().int().nonnegative(),
});
export type GeoConfig = z.infer<typeof ConfigSchema>;
export const geoPlan = (config: GeoConfig) =>
  config.plan === "custom" ? { rps: config.customRps, dailyCredits: config.customDailyCredits } : GEO_PLANS[config.plan];
export const readGeoConfig = async (): Promise<GeoConfig> => {
  // Direct encrypted-row reads: configuration checks never touch Valkey or put this key in its settings cache.
  const keys = [
    "geo.api_key",
    "geo.plan",
    "geo.custom_rps",
    "geo.custom_daily_credits",
    "geo.monthly_budget_credits",
    "geo.person_daily_credits",
    "app.timezone",
  ];
  const values = await readStates(keys);
  return ConfigSchema.parse({
    apiKey: values.get("geo.api_key")?.value,
    plan: values.get("geo.plan")?.value,
    customRps: values.get("geo.custom_rps")?.value,
    customDailyCredits: values.get("geo.custom_daily_credits")?.value,
    monthlyCredits: values.get("geo.monthly_budget_credits")?.value,
    personDailyCredits: values.get("geo.person_daily_credits")?.value,
    timezone: values.get("app.timezone")?.value,
  });
};
