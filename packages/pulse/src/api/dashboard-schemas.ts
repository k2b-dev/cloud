import { z } from "zod";
import { DashboardDefinitionSchema, PublicDashboardPanelSchema } from "../dashboard-contracts";
import { DashboardSnapshotSchema } from "../service/dashboard-cache";
export const DashboardSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  name: z.string(),
  definition: DashboardDefinitionSchema,
  revision: z.number().int().positive(),
  published: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const DashboardsPageSchema = z.object({ items: z.array(DashboardSchema), total: z.number(), nextOffset: z.number().nullable() });
export const DashboardPanelResultSchema = z.object({
  panelId: z.string(),
  status: z.enum(["ready", "refreshing", "error", "waiting"]),
  error: z.string().nullable(),
  nextRefreshAt: z.string(),
  lastGood: DashboardSnapshotSchema.nullable(),
  variant: z.string(),
  attribution: z.object({ text: z.string(), url: z.string(), license: z.string(), licenseUrl: z.string() }).nullable(),
});
export const PublicDashboardSchema = z.object({
  id: z.string(),
  name: z.string(),
  revision: z.number().int(),
  timeZone: z.string().describe("IANA time zone of the base; dashboard times read in it."),
  panels: z.array(PublicDashboardPanelSchema),
});
