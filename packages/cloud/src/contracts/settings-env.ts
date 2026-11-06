import { z } from "zod";

export const EnvSettingStatusSchema = z.object({
  key: z.string(),
  envVariable: z.string().nullable(),
  storedValuePresent: z.boolean(),
  envValuePresent: z.boolean(),
  conflict: z.enum(["none", "differs", "unknown"]),
  unreadableStoredValue: z.boolean(),
  invalidEnvValue: z.boolean(),
  needsAttention: z.boolean(),
});
export const EnvSettingsProcessSchema = z.object({
  appId: z.string(),
  instanceId: z.string().optional(),
  sampledAt: z.number().optional(),
  status: z.enum(["ok", "unavailable"]),
  settings: z.array(EnvSettingStatusSchema),
});
export const EnvSettingsStatusSchema = z.object({ needsAttention: z.boolean(), processes: z.array(EnvSettingsProcessSchema) });
export type EnvSettingStatus = z.infer<typeof EnvSettingStatusSchema>;
