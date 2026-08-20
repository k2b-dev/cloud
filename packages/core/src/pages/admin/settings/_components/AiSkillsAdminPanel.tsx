import { DataPanel, DataTable, type DataTableColumn, Pagination, SettingsPage, StatCell, StatGrid, StatusBadge } from "@k2b/ui";
import type { AiSkillAdminListItem, AiSkillAdminSummary } from "@valentinkolb/cloud/ai";
import { formatDateTime } from "@valentinkolb/cloud/shared";
import { SearchBar } from "@valentinkolb/cloud/ssr/islands";
import AiSkillAdminActions from "./AiSkillAdminActions.island";

type Props = {
  skills: AiSkillAdminListItem[];
  summary: AiSkillAdminSummary;
  total: number;
  page: number;
  perPage: number;
  search: string;
};

export default function AiSkillsAdminPanel(props: Props) {
  const totalPages = Math.ceil(props.total / props.perPage);
  const baseUrl = props.search
    ? `/admin/settings?tab=ai-skills&search=${encodeURIComponent(props.search)}&page=`
    : "/admin/settings?tab=ai-skills&page=";
  const columns: DataTableColumn<AiSkillAdminListItem>[] = [
    { id: "skill", header: "Skill", value: (skill) => skill.name },
    { id: "updated", header: "Updated", value: (skill) => skill.updatedAt, cellClass: "whitespace-nowrap" },
    { id: "access", header: "Access", value: (skill) => skill.accessCount, cellClass: "whitespace-nowrap" },
    { id: "admins", header: "Admins", value: (skill) => skill.adminCount, cellClass: "whitespace-nowrap" },
    { id: "actions", header: "Settings", headerClass: "w-px text-right", cellClass: "text-right whitespace-nowrap" },
  ];

  return (
    <SettingsPage
      title="AI Skills"
      subtitle="Recover and manage access to shared Assistant Skills."
      icon="ti ti-wand"
      scrollPreserveKey="admin-ai-skills"
    >
      <StatGrid columns={3}>
        <StatCell label="Skills" value={props.summary.total} sub={props.search ? "filtered" : "shared Skills"} />
        <StatCell
          label="Without admins"
          value={props.summary.unmanaged}
          sub={props.summary.unmanaged > 0 ? "recovery required" : "all manageable"}
          valueClass={props.summary.unmanaged > 0 ? "text-red-500" : "text-primary"}
          accent={props.summary.unmanaged > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
        />
        <StatCell label="Access entries" value={props.summary.totalAccess} sub={props.search ? "in search" : "across all Skills"} />
      </StatGrid>

      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <SearchBar
            action="/admin/settings?tab=ai-skills"
            value={props.search}
            placeholder="Search Skills by name or ID..."
            ariaLabel="Search AI Skills"
          />
        </div>
        <span class="shrink-0 text-xs tabular-nums text-dimmed">
          {props.skills.length} of {props.total}
        </span>
      </div>

      <DataPanel
        title="Skill records"
        subtitle="Platform-wide Skills remain listed even when their last administrator account was deleted."
        class="overflow-hidden"
        footer={<Pagination currentPage={props.page} totalPages={totalPages} baseUrl={baseUrl} />}
      >
        <DataTable
          rows={props.skills}
          columns={columns}
          getRowId={(skill) => skill.shortId}
          hoverRows
          class="overflow-x-auto"
          empty={props.search ? `No Skills matching "${props.search}".` : "No AI Skills found."}
          renderCell={({ row: skill, col }) => {
            if (col.id === "skill") {
              return (
                <div class="flex min-w-52 items-center gap-2">
                  <i class="ti ti-wand text-dimmed" aria-hidden="true" />
                  <div class="min-w-0">
                    <div class="truncate font-medium text-primary">{skill.name}</div>
                    <div class="truncate text-[10px] text-dimmed">{skill.shortId}</div>
                  </div>
                </div>
              );
            }
            if (col.id === "updated") return <span class="text-xs text-dimmed">{formatDateTime(skill.updatedAt)}</span>;
            if (col.id === "access") return <span class="text-xs tabular-nums text-dimmed">{skill.accessCount}</span>;
            if (col.id === "admins") {
              return (
                <StatusBadge
                  label={skill.adminCount === 0 ? "No admins" : `${skill.adminCount} ${skill.adminCount === 1 ? "admin" : "admins"}`}
                  tone={skill.adminCount === 0 ? "error" : "neutral"}
                />
              );
            }
            if (col.id === "actions") {
              return <AiSkillAdminActions skillId={skill.shortId} skillName={skill.name} />;
            }
            return "";
          }}
        />
      </DataPanel>
    </SettingsPage>
  );
}
