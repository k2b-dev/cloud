import { z } from "zod";

/** Administrator inventory: neither effective/default values nor credentials leave the owner. */
export const AdminSettingStatusSchema = z.object({
  key: z.string(),
  kind: z.string(),
  group: z.string(),
  stored: z.enum(["none", "readable", "unreadable"]),
  storedValuePresent: z.boolean(),
  envBacked: z.boolean(),
});
export const AdminSettingsCatalogSchema = z.object({ settings: z.array(AdminSettingStatusSchema) });
