import { z } from "zod";
import type { ActivityBasesPage, ActivityPage } from "../activity-contracts";
import { type AdminBrowseResult, AdminQuerySchema, type AdminResult, type ArchivePage, type SharePage } from "../contracts";
import type { AdminActivityBase, AdminActivityFilters } from "./admin-history";
export const AdminLocationSchema = AdminQuerySchema.extend({
  view: z.enum(["overview", "directories", "archive", "settings", "shares", "activity", "templates"]).default("overview"),
  name: z.string().max(255).optional(),
  archiveId: z.string().uuid().optional(),
  path: z.string().max(4096).default(""),
});
export type AdminLocation = z.infer<typeof AdminLocationSchema>;
export type AdminView = AdminLocation["view"];
export type AdminSnapshot = {
  source: string;
  result: AdminResult;
  archives: ArchivePage | null;
  browse: AdminBrowseResult | null;
  shares?: SharePage;
  uploads?: {
    items: { id: string; shareId: string | null; path: string; size: number; state: string; error: string | null; updatedAt: string }[];
    next: string | null;
  };
  /** Instant the history view was loaded; its dates and ranges count from it on server and client alike. */
  now?: string;
  /** First bounded metadata page, with the same shape on SSR and the client. */
  activityBases?: ActivityBasesPage | null;
  /** Exact metadata for the initial history page and selection, including bindings outside the first page. */
  activityBaseLabels?: AdminActivityBase[];
  /** Authorized first history page for these filters; without it the view loads its own. */
  activity?: { filters: AdminActivityFilters; page: ActivityPage } | null;
};
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
