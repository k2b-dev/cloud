import type { AnnouncementEntry } from "@k2b/cloud/contracts";
import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { announcements } from "@k2b/cloud/services";
import { formatDateTime } from "@k2b/cloud/shared";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import { adminMessages } from "../messages";
import type { AnnouncementRow } from "./AnnouncementsScreen";
import AnnouncementsScreen from "./AnnouncementsScreen.island";

const state = (entry: AnnouncementEntry, now: number): AnnouncementRow["state"] => {
  const published = new Date(entry.publishedAt).getTime();
  const expires = entry.expiresAt ? new Date(entry.expiresAt).getTime() : null;
  if (published > now) return "scheduled";
  if (expires && expires <= now) return "expired";
  return "active";
};

/** Announcements and banners: the list, and the entry the address opens (`?entry=<id>` or `?entry=new`). */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const t = adminMessages.resolve([locale]).t;
  const items = await announcements.admin.list();
  const now = Date.now();
  const dates = { ...getDateConfig(c), locale };
  const rows: AnnouncementRow[] = items.map((entry) => ({
    ...entry,
    state: state(entry, now),
    published: formatDateTime(entry.publishedAt, dates),
    expires: entry.expiresAt ? formatDateTime(entry.expiresAt, dates) : t.noExpiry,
  }));
  const requested = c.req.query("entry") ?? null;
  // An entry that no longer exists opens nothing: the list stays, as after a delete in another tab.
  const open = requested === "new" || rows.some((row) => row.id === requested) ? requested : null;
  return () => (
    <AdminLayout c={c} ui="v2" title={t.announcements}>
      <AnnouncementsScreen nav={adminNavigation(c)} rows={rows} open={open} />
    </AdminLayout>
  );
});
