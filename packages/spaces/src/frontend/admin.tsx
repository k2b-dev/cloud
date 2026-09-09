import { i18n } from "@k2b/stdlib";
import { DataTable, type DataTableColumn, Pagination, StatCell, StatGrid, StatusBadge } from "@k2b/ui";
import type { AuthContext } from "@k2b/cloud/server";
import { getLocale } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import { ssr } from "../config";
import { spacesService } from "../service";
import { spacesPublicResources } from "../service/public-resources";
import AdminSpaceActions from "./_components/AdminSpaceActions.island";

const PER_PAGE = 100;

export const adminMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      space: "Space",
      description: "Description",
      permissions: "Permissions",
      settings: "Settings",
      spaces: "Spaces",
      filtered: "filtered",
      total: "total",
      orphaned: "Orphaned",
      noAccess: "no access",
      allReachable: "all reachable",
      accessEntries: "Access entries",
      inSearch: "in search",
      acrossAllSpaces: "across all spaces",
      shown: ({ shown, total }: { shown: number; total: number }) => `${shown} of ${total} spaces`,
      searchPlaceholder: "Search spaces by name...",
      searchLabel: "Search spaces",
      noMatch: ({ query }: { query: string }) => `No spaces matching "${query}".`,
      noneFound: "No spaces found.",
      noDescription: "No description",
      accessCount: ({ count }: { count: number }) => `${count} access ${count === 1 ? "entry" : "entries"}`,
    },
    de: {
      space: "Space",
      description: "Beschreibung",
      permissions: "Berechtigungen",
      settings: "Einstellungen",
      spaces: "Spaces",
      filtered: "gefiltert",
      total: "insgesamt",
      orphaned: "Ohne Zugriff",
      noAccess: "kein Zugriff",
      allReachable: "alle erreichbar",
      accessEntries: "Zugriffsregeln",
      inSearch: "in den Suchergebnissen",
      acrossAllSpaces: "in allen Spaces",
      shown: ({ shown, total }) => `${shown} von ${total} Spaces`,
      searchPlaceholder: "Spaces nach Namen durchsuchen...",
      searchLabel: "Spaces durchsuchen",
      noMatch: ({ query }) => `Keine Spaces passend zu „${query}“ gefunden.`,
      noneFound: "Keine Spaces gefunden.",
      noDescription: "Keine Beschreibung",
      accessCount: ({ count }) => `${count} ${count === 1 ? "Zugriffsregel" : "Zugriffsregeln"}`,
    },
  },
});

export default ssr<AuthContext>(async (c) => {
  const { t } = adminMessages.resolve([getLocale(c)]);
  const search = (c.req.query("search") ?? "").trim();
  const pageRaw = Number.parseInt(c.req.query("page") ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  // List + summary in parallel — summary is a single SQL aggregation across the
  // full filtered set, NOT just the visible page.
  const [spaces, summary] = await Promise.all([
    spacesService.space.admin.list({
      pagination: { page, perPage: PER_PAGE },
      filter: { query: search || undefined },
    }),
    spacesService.space.admin.summary({ filter: { query: search || undefined } }),
  ]);
  spaces.items = await spacesPublicResources.projectSpaces(spaces.items);

  const totalPages = Math.ceil(spaces.total / spaces.perPage);
  const baseUrl = search ? `/admin/spaces?search=${encodeURIComponent(search)}&page=` : "/admin/spaces?page=";

  const orphanedCount = summary.orphaned;
  const totalPermissions = summary.totalPermissions;
  type SpaceRow = (typeof spaces.items)[number];
  const columns: DataTableColumn<SpaceRow>[] = [
    { id: "space", header: t.space, value: (space) => space.name },
    { id: "description", header: t.description, value: (space) => space.description, cellClass: "max-w-xl" },
    { id: "permissions", header: t.permissions, value: (space) => space.permissionCount, cellClass: "whitespace-nowrap" },
    {
      id: "actions",
      header: t.settings,
      headerClass: "w-px text-right",
      cellClass: "text-right whitespace-nowrap",
    },
  ];

  return () => (
    <AdminLayout c={c} title="Spaces">
      <div class="app-rows" data-scroll-preserve="spaces-admin">
        <div class="min-w-0" style="view-transition-name: admin-spaces-title">
          <h1 class="text-base font-semibold text-primary">Spaces</h1>
        </div>

        {/* Stat cards — see skills/cloud-app/references/frontend.md § Stats */}
        <StatGrid columns={3}>
          <StatCell
            label={t.spaces}
            value={spaces.total}
            sub={search ? t.filtered : t.total}
            accent={{ tone: "blue", icon: "ti ti-layout-kanban" }}
          />
          <StatCell
            label={t.orphaned}
            value={orphanedCount}
            sub={orphanedCount > 0 ? t.noAccess : t.allReachable}
            valueClass={orphanedCount > 0 ? "text-red-500" : "text-primary"}
            accent={orphanedCount > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
          />
          <StatCell label={t.accessEntries} value={totalPermissions} sub={search ? t.inSearch : t.acrossAllSpaces} />
        </StatGrid>

        <DataTable.Panel class="min-w-0 [view-transition-name:admin-spaces-table]">
          <DataTable.Header title={t.spaces} subtitle={t.shown({ shown: spaces.items.length, total: spaces.total })} />
          <DataTable.Controls>
            <SearchBar action="/admin/spaces" value={search} placeholder={t.searchPlaceholder} ariaLabel={t.searchLabel} />
          </DataTable.Controls>
          <DataTable
            rows={spaces.items}
            columns={columns}
            getRowId={(space) => space.id}
            hoverRows
            class="overflow-x-auto"
            scrollPreserveKey="spaces-admin-table"
            empty={search ? t.noMatch({ query: search }) : t.noneFound}
            renderCell={({ row: space, col }) => {
              if (col.id === "space") {
                return (
                  <div class="flex min-w-52 items-center gap-2">
                    <span
                      class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[10px] text-white"
                      style={`background-color: ${space.color}`}
                    >
                      <i class="ti ti-layout-kanban" />
                    </span>
                    <span class="truncate font-medium text-primary">{space.name}</span>
                  </div>
                );
              }
              if (col.id === "description") {
                return (
                  <span class="block truncate" title={space.description ?? t.noDescription}>
                    {space.description || <span class="italic">{t.noDescription}</span>}
                  </span>
                );
              }
              if (col.id === "permissions") {
                return (
                  <StatusBadge
                    tone={space.permissionCount === 0 ? "error" : "neutral"}
                    variant="chip"
                    icon={space.permissionCount === 0 ? "ti ti-lock-off" : "ti ti-users"}
                    label={t.accessCount({ count: space.permissionCount })}
                  />
                );
              }
              if (col.id === "actions") return <AdminSpaceActions spaceId={space.id} spaceName={space.name} />;
              return "";
            }}
          />
          {totalPages > 1 ? (
            <DataTable.Footer>
              <Pagination currentPage={spaces.page} totalPages={totalPages} baseUrl={baseUrl} />
            </DataTable.Footer>
          ) : null}
        </DataTable.Panel>
      </div>
    </AdminLayout>
  );
});
