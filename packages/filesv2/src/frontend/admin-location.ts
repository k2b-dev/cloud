import { z } from "zod";
import { type AdminBrowseResult, AdminQuerySchema, type AdminResult, type ArchivePage } from "../contracts";
export const AdminLocationSchema = AdminQuerySchema.extend({
  view: z.enum(["overview", "directories", "archive", "settings"]).default("overview"),
  name: z.string().max(255).optional(),
  archiveId: z.string().uuid().optional(),
  path: z.string().max(4096).default(""),
});
export type AdminLocation = z.infer<typeof AdminLocationSchema>;
export type AdminView = AdminLocation["view"];
export type AdminSnapshot = { source: string; result: AdminResult; archives: ArchivePage | null; browse: AdminBrowseResult | null };
export function adminHref(location: AdminLocation, patch: Partial<AdminLocation> = {}) {
  const next = { ...location, ...patch };
  const search = new URLSearchParams();
  for (const key of ["view", "area", "kind", "after", "q", "status", "name", "archiveId", "path"] as const) {
    const value = next[key];
    if (value) search.set(key, value);
  }
  return `/admin/filesv2?${search}`;
}
export function parseAdminLocation(source: string) {
  return AdminLocationSchema.parse(Object.fromEntries(new URL(source, "https://files.invalid").searchParams));
}
