import { DataTable, type DataTableColumn, Placeholder, StatCell, StatGrid } from "@k2b/ui";
import type { AnnouncementEntry } from "@k2b/cloud/contracts";
import { getLocale, type AuthContext } from "@k2b/cloud/server";
import { announcements } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import AnnouncementActions from "./AnnouncementActions.island";
import { adminMessages } from "../messages";

const fmtDate = (value: string | null, locale: string) =>
  value ? new Date(value).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : "—";

const state = (entry: AnnouncementEntry): "scheduled" | "expired" | "active" => {
  const now = Date.now();
  const published = new Date(entry.publishedAt).getTime();
  const expires = entry.expiresAt ? new Date(entry.expiresAt).getTime() : null;
  if (published > now) return "scheduled";
  if (expires && expires <= now) return "expired";
  return "active";
};

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const t = adminMessages.resolve([locale]).t;
  const items = await announcements.admin.list();
  const active = items.filter((item) => state(item) === "active").length;
  const scheduled = items.filter((item) => state(item) === "scheduled").length;
  const banners = items.filter((item) => item.kind === "banner").length;

  const columns: DataTableColumn<AnnouncementEntry>[] = [
    { id: "title", header: t.title, value: (entry) => entry.title },
    { id: "kind", header: t.type, value: (entry) => entry.kind },
    { id: "version", header: t.version, value: (entry) => entry.version, headerClass: "text-right", cellClass: "text-right tabular-nums" },
    { id: "state", header: t.state, value: (entry) => state(entry) },
    { id: "published", header: t.published, value: (entry) => entry.publishedAt, cellClass: "whitespace-nowrap" },
    { id: "expires", header: t.expires, value: (entry) => entry.expiresAt, cellClass: "whitespace-nowrap" },
    {
      id: "actions",
      header: <span class="sr-only">{t.actions}</span>,
      headerClass: "w-px text-right",
      cellClass: "text-right whitespace-nowrap",
    },
  ];

  return () => (
    <AdminLayout c={c} title={t.announcements}>
      <div class="app-rows">
        <div class="flex flex-wrap items-center justify-between gap-3" style="view-transition-name: admin-announcements-title">
          <div class="min-w-0">
            <h1 class="text-base font-semibold text-primary">{t.announcements}</h1>
            <p class="mt-1 text-xs text-dimmed">{t.announcementsPageDescription}</p>
          </div>
          <AnnouncementActions mode="create" />
        </div>

        <StatGrid columns={4}>
          <StatCell label={t.entries} value={items.length} sub={t.total} accent={{ tone: "blue", icon: "ti ti-speakerphone" }} />
          <StatCell label={t.active} value={active} sub={t.visibleNow} accent={{ tone: "emerald", icon: "ti ti-circle-check" }} />
          <StatCell label={t.scheduled} value={scheduled} sub={t.futurePublish} />
          <StatCell label={t.banners} value={banners} sub={t.dismissible} />
        </StatGrid>

        {items.length > 0 ? (
          <section class="paper overflow-hidden" style="view-transition-name: admin-announcements-table">
            <DataTable
              ariaLabel={t.announcements}
              rows={items}
              columns={columns}
              getRowId={(entry) => entry.id}
              hoverRows
              class="overflow-x-auto"
              renderCell={({ row: entry, col }) => {
                if (col.id === "title") {
                  return (
                    <div class="flex min-w-56 items-center gap-2">
                      <i class={entry.kind === "banner" ? "ti ti-message text-dimmed" : "ti ti-speakerphone text-dimmed"} />
                      <div class="min-w-0">
                        <p class="truncate font-medium text-primary">{entry.title}</p>
                        <p class="truncate text-[10px] text-dimmed">{entry.body}</p>
                      </div>
                    </div>
                  );
                }
                if (col.id === "kind")
                  return <span class="text-xs text-secondary">{entry.kind === "banner" ? t.banner : t.announcement}</span>;
                if (col.id === "version") return <span class="text-xs text-secondary">v{entry.version}</span>;
                if (col.id === "state") {
                  const currentState = state(entry);
                  const meta = {
                    scheduled: { label: t.scheduled, class: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
                    expired: { label: t.expired, class: "bg-zinc-100 text-dimmed dark:bg-zinc-800" },
                    active: { label: t.active, class: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" },
                  }[currentState];
                  return <span class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.class}`}>{meta.label}</span>;
                }
                if (col.id === "published") return <span class="text-xs text-dimmed">{fmtDate(entry.publishedAt, locale)}</span>;
                if (col.id === "expires") return <span class="text-xs text-dimmed">{fmtDate(entry.expiresAt, locale)}</span>;
                if (col.id === "actions") return <AnnouncementActions mode="row" entry={entry} />;
                return "";
              }}
            />
          </section>
        ) : (
          <Placeholder surface="paper" description={t.noAnnouncements} />
        )}
      </div>
    </AdminLayout>
  );
});
