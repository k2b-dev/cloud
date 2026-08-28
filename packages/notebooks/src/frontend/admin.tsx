import { DataPanel, DataTable, type DataTableColumn, Pagination, StatCell, StatGrid, StatusBadge } from "@k2b/ui";
import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { AdminLayout } from "@valentinkolb/cloud/ssr";
import { SearchBar } from "@valentinkolb/cloud/ssr/islands";
import { ssr } from "../config";
import { notebooksService } from "../service";
import AdminNotebookActions from "./_components/AdminNotebookActions.island";
import AdminNotebooksAppSettings from "./_components/AdminNotebooksAppSettings.island";
import { notebooksAdminMessages } from "./admin-messages";

const PER_PAGE = 100;

export default ssr<AuthContext>(async (c) => {
  const t = notebooksAdminMessages.resolve([getLocale(c)]).t;
  const search = (c.req.query("search") ?? "").trim();
  const pageRaw = Number.parseInt(c.req.query("page") ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  // List + summary in parallel — summary is a single SQL aggregation across the
  // full filtered set, NOT just the visible page.
  const [notebooks, summary] = await Promise.all([
    notebooksService.notebook.admin.list({
      pagination: { page, perPage: PER_PAGE },
      filter: { query: search || undefined },
    }),
    notebooksService.notebook.admin.summary({ filter: { query: search || undefined } }),
  ]);

  const totalPages = Math.ceil(notebooks.total / notebooks.perPage);
  const baseUrl = search ? `/admin/notebooks?search=${encodeURIComponent(search)}&page=` : "/admin/notebooks?page=";

  const orphanedCount = summary.orphaned;
  const totalPermissions = summary.totalPermissions;
  type NotebookRow = (typeof notebooks.items)[number];
  const columns: DataTableColumn<NotebookRow>[] = [
    { id: "notebook", header: t.notebook, value: (notebook) => notebook.name },
    { id: "description", header: t.description, value: (notebook) => notebook.description, cellClass: "max-w-xl" },
    { id: "permissions", header: t.permissions, value: (notebook) => notebook.permissionCount, cellClass: "whitespace-nowrap" },
    {
      id: "actions",
      header: t.settings,
      headerClass: "w-px text-right",
      cellClass: "text-right whitespace-nowrap",
    },
  ];

  return () => (
    <AdminLayout c={c} title={t.notebooks}>
      <div class="app-rows">
        <div class="min-w-0" style="view-transition-name: admin-notebooks-title">
          <h1 class="text-base font-semibold text-primary">{t.notebooks}</h1>
        </div>

        {/* Stat cards — see skills/cloud-app/references/frontend.md § Stats */}
        <StatGrid columns={3}>
          <StatCell
            label={t.notebooks}
            value={notebooks.total}
            sub={search ? t.filtered : t.total}
            accent={{ tone: "blue", icon: "ti ti-notebook" }}
          />
          <StatCell
            label={t.orphaned}
            value={orphanedCount}
            sub={orphanedCount > 0 ? t.noAccess : t.allReachable}
            valueClass={orphanedCount > 0 ? "text-red-500" : "text-primary"}
            accent={orphanedCount > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
          />
          <StatCell label={t.accessEntries} value={totalPermissions} sub={search ? t.inSearch : t.acrossAllNotebooks} />
        </StatGrid>

        <div class="flex items-center gap-2">
          <div class="min-w-0 flex-1">
            <SearchBar action="/admin/notebooks" value={search} placeholder={t.searchPlaceholder} ariaLabel={t.searchLabel} />
          </div>
          <span class="shrink-0 text-xs tabular-nums text-dimmed">
            {t.countOf({ shown: notebooks.items.length, total: notebooks.total })}
          </span>
          <AdminNotebooksAppSettings />
        </div>

        <DataPanel
          title={t.notebookRecords}
          subtitle={t.countOf({ shown: notebooks.items.length, total: notebooks.total })}
          class="overflow-hidden"
          footer={<Pagination currentPage={notebooks.page} totalPages={totalPages} baseUrl={baseUrl} />}
        >
          <DataTable
            rows={notebooks.items}
            columns={columns}
            getRowId={(notebook) => notebook.id}
            hoverRows
            class="overflow-x-auto"
            empty={search ? t.noMatching({ search }) : t.noNotebooks}
            renderCell={({ row: notebook, col }) => {
              if (col.id === "notebook") {
                return (
                  <div class="flex min-w-52 items-center gap-2">
                    <i class={`${notebook.icon ?? "ti ti-notebook"} text-dimmed`} />
                    <span class="truncate font-medium text-primary">{notebook.name}</span>
                  </div>
                );
              }
              if (col.id === "description") {
                return (
                  <span class="block truncate" title={notebook.description ?? t.noDescription}>
                    {notebook.description || <span class="italic">{t.noDescription}</span>}
                  </span>
                );
              }
              if (col.id === "permissions") {
                return (
                  <StatusBadge
                    tone={notebook.permissionCount === 0 ? "error" : "neutral"}
                    label={t.accessCount({ count: notebook.permissionCount })}
                  />
                );
              }
              if (col.id === "actions") return <AdminNotebookActions notebookId={notebook.shortId} notebookName={notebook.name} />;
              return "";
            }}
          />
        </DataPanel>
      </div>
    </AdminLayout>
  );
});
