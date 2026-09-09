import { AccessEntrySchema, PermissionLevelSchema, ServiceAccountCredentialSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { SpaceDetailSchema, SpaceWormholeSchema } from "./contracts";

export const SpaceViewSchema = z.enum(["list", "table", "kanban", "calendar"]);
export type ViewType = z.infer<typeof SpaceViewSchema>;

export const SpaceUserSettingsSchema = z.object({
  view: SpaceViewSchema,
  hideSettings: z.boolean(),
});
export type SpaceUserSettings = z.infer<typeof SpaceUserSettingsSchema>;

export const SpaceApiKeySchema = ServiceAccountCredentialSchema.extend({
  permission: PermissionLevelSchema,
});

export const SpaceSettingsContextSchema = z.object({
  space: SpaceDetailSchema,
  settings: SpaceUserSettingsSchema,
  permission: z.enum(["read", "write", "admin"]),
  accessEntries: z.array(AccessEntrySchema),
  apiKeys: z.array(SpaceApiKeySchema),
  wormholes: z.array(SpaceWormholeSchema),
});
export type SpaceSettingsContext = z.infer<typeof SpaceSettingsContextSchema>;
