import { DataPanel, DataTable, type DataTableColumn, Pagination, SettingsPage, StatCell, StatGrid, StatusBadge, useLocale } from "@k2b/ui";
import type { AiProjectAdminListItem, AiProjectAdminSummary } from "@k2b/cloud/ai";
import { formatDateTime } from "@k2b/cloud/shared";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import AiProjectAdminActions from "./AiProjectAdminActions.island";
import { settingsMessages } from "./messages";

type Props = {
  projects: AiProjectAdminListItem[];
  summary: AiProjectAdminSummary;
  total: number;
  page: number;
  perPage: number;
  search: string;
};

export default function AiProjectsAdminPanel(props: Props) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const totalPages = Math.ceil(props.total / props.perPage);
  const baseUrl = props.search
    ? `/admin/settings?tab=ai-projects&search=${encodeURIComponent(props.search)}&page=`
    : "/admin/settings?tab=ai-projects&page=";
  const columns: DataTableColumn<AiProjectAdminListItem>[] = [
    { id: "project", header: t().project, value: (project) => project.name },
    { id: "updated", header: t().updated, value: (project) => project.updatedAt, cellClass: "whitespace-nowrap" },
    { id: "access", header: t().access, value: (project) => project.accessCount, cellClass: "whitespace-nowrap" },
    { id: "admins", header: t().admins, value: (project) => project.adminCount, cellClass: "whitespace-nowrap" },
    { id: "actions", header: t().settings, headerClass: "w-px text-right", cellClass: "text-right whitespace-nowrap" },
  ];

  return (
    <SettingsPage title={t().aiProjects} subtitle={t().aiProjectsDescription} icon="ti ti-folders" scrollPreserveKey="admin-ai-projects">
      <StatGrid columns={3}>
        <StatCell label={t().projects} value={props.summary.total} sub={props.search ? t().filtered : t().sharedProjects} />
        <StatCell
          label={t().withoutAdmins}
          value={props.summary.unmanaged}
          sub={props.summary.unmanaged > 0 ? t().recoveryRequired : t().allManageable}
          valueClass={props.summary.unmanaged > 0 ? "text-red-500" : "text-primary"}
          accent={props.summary.unmanaged > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
        />
        <StatCell label={t().accessEntries} value={props.summary.totalAccess} sub={props.search ? t().inSearch : t().acrossAllProjects} />
      </StatGrid>

      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <SearchBar
            action="/admin/settings?tab=ai-projects"
            value={props.search}
            placeholder={t().searchProjects}
            ariaLabel={t().searchAiProjects}
          />
        </div>
        <span class="shrink-0 text-xs tabular-nums text-dimmed">
          {t().shownOfTotal({ shown: props.projects.length, total: props.total })}
        </span>
      </div>

      <DataPanel
        title={t().projectRecords}
        subtitle={t().projectRecordsDescription}
        class="overflow-hidden"
        footer={<Pagination currentPage={props.page} totalPages={totalPages} baseUrl={baseUrl} />}
      >
        <DataTable
          rows={props.projects}
          columns={columns}
          getRowId={(project) => project.shortId}
          hoverRows
          class="overflow-x-auto"
          empty={props.search ? t().noProjectsMatch({ search: props.search }) : t().noProjects}
          renderCell={({ row: project, col }) => {
            if (col.id === "project") {
              return (
                <div class="flex min-w-52 items-center gap-2">
                  <i class={`${project.icon || "ti ti-folders"} text-dimmed`} aria-hidden="true" />
                  <div class="min-w-0">
                    <div class="truncate font-medium text-primary">{project.name}</div>
                    <div class="truncate text-[10px] text-dimmed">{project.shortId}</div>
                  </div>
                </div>
              );
            }
            if (col.id === "updated")
              return <span class="text-xs text-dimmed">{formatDateTime(project.updatedAt, { locale: locale() })}</span>;
            if (col.id === "access") return <span class="text-xs tabular-nums text-dimmed">{project.accessCount}</span>;
            if (col.id === "admins") {
              return (
                <StatusBadge
                  label={project.adminCount === 0 ? t().noAdmins : t().adminCount({ count: project.adminCount })}
                  tone={project.adminCount === 0 ? "error" : "neutral"}
                />
              );
            }
            if (col.id === "actions") return <AiProjectAdminActions projectId={project.shortId} projectName={project.name} />;
            return "";
          }}
        />
      </DataPanel>
    </SettingsPage>
  );
}
