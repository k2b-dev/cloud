import type { AiAppSkillIssue, AiSkillAdminListItem, AiSkillAdminSummary } from "@k2b/cloud/ai";
import { formatDateTime } from "@k2b/cloud/shared";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import { DataPanel, DataTable, type DataTableColumn, Pagination, SettingsPage, StatCell, StatGrid, StatusBadge, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import AiAppSkillIssueActions from "./AiAppSkillIssueActions.island";
import AiSkillAdminActions from "./AiSkillAdminActions.island";
import { settingsMessages } from "./messages";

type Props = {
  skills: AiSkillAdminListItem[];
  summary: AiSkillAdminSummary;
  total: number;
  page: number;
  perPage: number;
  search: string;
  /** App Skills that Cloud does not offer: deleted by an administrator or not installable. */
  appSkillIssues: AiAppSkillIssue[];
  /** Registered apps' names in the request locale; an offline app falls back to its stored name. */
  appNames: Readonly<Record<string, string>>;
};

export default function AiSkillsAdminPanel(props: Props) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const appName = (source: { appId: string; appName: string }) => props.appNames[source.appId] ?? source.appName;
  const totalPages = Math.ceil(props.total / props.perPage);
  const baseUrl = props.search
    ? `/admin/settings?tab=ai-skills&search=${encodeURIComponent(props.search)}&page=`
    : "/admin/settings?tab=ai-skills&page=";
  const columns: DataTableColumn<AiSkillAdminListItem>[] = [
    { id: "skill", header: t().skill, value: (skill) => skill.name },
    { id: "source", header: t().skillSource, value: (skill) => (skill.source ? appName(skill.source) : "") },
    { id: "updated", header: t().updated, value: (skill) => skill.updatedAt, cellClass: "whitespace-nowrap" },
    { id: "access", header: t().access, value: (skill) => skill.accessCount, cellClass: "whitespace-nowrap" },
    { id: "admins", header: t().admins, value: (skill) => skill.adminCount, cellClass: "whitespace-nowrap" },
    { id: "actions", header: t().settings, headerClass: "w-px text-right", cellClass: "text-right whitespace-nowrap" },
  ];
  const issueColumns: DataTableColumn<AiAppSkillIssue>[] = [
    { id: "skill", header: t().skill, value: (issue) => issue.name },
    { id: "source", header: t().skillSource, value: (issue) => appName(issue) },
    { id: "state", header: t().status },
    { id: "actions", header: t().settings, headerClass: "w-px text-right", cellClass: "text-right whitespace-nowrap" },
  ];

  return (
    <SettingsPage title={t().aiSkills} subtitle={t().aiSkillsDescription} icon="ti ti-wand" scrollPreserveKey="admin-ai-skills">
      <StatGrid columns={3}>
        <StatCell label={t().skills} value={props.summary.total} sub={props.search ? t().filtered : t().sharedSkills} />
        <StatCell
          label={t().withoutAdmins}
          value={props.summary.unmanaged}
          sub={props.summary.unmanaged > 0 ? t().recoveryRequired : t().allManageable}
          valueClass={props.summary.unmanaged > 0 ? "text-red-500" : "text-primary"}
          accent={props.summary.unmanaged > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
        />
        <StatCell label={t().accessEntries} value={props.summary.totalAccess} sub={props.search ? t().inSearch : t().acrossAllSkills} />
      </StatGrid>

      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <SearchBar
            action="/admin/settings?tab=ai-skills"
            value={props.search}
            placeholder={t().searchSkills}
            ariaLabel={t().searchAiSkills}
          />
        </div>
        <span class="shrink-0 text-xs tabular-nums text-dimmed">
          {t().shownOfTotal({ shown: props.skills.length, total: props.total })}
        </span>
      </div>

      <DataPanel
        title={t().skillRecords}
        subtitle={t().skillRecordsDescription}
        class="overflow-hidden"
        footer={<Pagination currentPage={props.page} totalPages={totalPages} baseUrl={baseUrl} />}
      >
        <DataTable
          rows={props.skills}
          columns={columns}
          getRowId={(skill) => skill.shortId}
          hoverRows
          class="overflow-x-auto"
          empty={props.search ? t().noSkillsMatch({ search: props.search }) : t().noSkills}
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
            if (col.id === "source") {
              const source = skill.source;
              if (!source) return <span class="text-xs text-dimmed">{t().customSkill}</span>;
              return (
                <div class="flex min-w-36 flex-col items-start gap-1 text-xs">
                  <span class="text-secondary">{t().fromApp({ app: appName(source) })}</span>
                  <Show when={!source.available}>
                    <StatusBadge tone="neutral" icon={null} label={t().appSkillUnavailable} />
                  </Show>
                  <Show when={source.status !== "current"}>
                    <StatusBadge
                      tone={source.status === "update_available" ? "warning" : "neutral"}
                      icon={null}
                      label={source.status === "update_available" ? t().appSkillUpdate : t().appSkillCustomized}
                    />
                  </Show>
                </div>
              );
            }
            if (col.id === "updated")
              return <span class="text-xs text-dimmed">{formatDateTime(skill.updatedAt, { locale: locale() })}</span>;
            if (col.id === "access") return <span class="text-xs tabular-nums text-dimmed">{skill.accessCount}</span>;
            if (col.id === "admins") {
              if (skill.source && skill.adminCount === 0) return <span class="text-xs text-dimmed">{t().managedByApp}</span>;
              return (
                <StatusBadge
                  label={skill.adminCount === 0 ? t().noAdmins : t().adminCount({ count: skill.adminCount })}
                  tone={skill.adminCount === 0 ? "error" : "neutral"}
                />
              );
            }
            if (col.id === "actions") {
              return (
                <AiSkillAdminActions
                  skillId={skill.shortId}
                  skillName={skill.name}
                  revision={skill.revision}
                  source={skill.source ? { appName: appName(skill.source), status: skill.source.status } : null}
                />
              );
            }
            return "";
          }}
        />
      </DataPanel>

      <Show when={props.appSkillIssues.length > 0}>
        <DataPanel title={t().appSkillsNotInstalled} subtitle={t().appSkillsNotInstalledDescription} class="overflow-hidden">
          <DataTable
            rows={props.appSkillIssues}
            columns={issueColumns}
            getRowId={(issue) => `${issue.appId}/${issue.name}`}
            class="overflow-x-auto"
            renderCell={({ row: issue, col }) => {
              if (col.id === "skill") {
                return (
                  <div class="flex min-w-52 items-center gap-2">
                    <i class="ti ti-wand text-dimmed" aria-hidden="true" />
                    <span class="truncate font-medium text-primary">{issue.name}</span>
                  </div>
                );
              }
              if (col.id === "source") return <span class="text-xs text-secondary">{t().fromApp({ app: appName(issue) })}</span>;
              if (col.id === "state") {
                return (
                  <div class="flex min-w-36 flex-col items-start gap-1 text-xs">
                    <StatusBadge
                      tone={issue.state === "invalid" ? "error" : "neutral"}
                      icon={null}
                      label={
                        issue.state === "deleted"
                          ? t().appSkillDeleted
                          : issue.state === "name_taken"
                            ? t().appSkillNameTaken
                            : t().appSkillInvalid
                      }
                    />
                    <Show when={issue.state === "invalid"}>
                      <span class="text-dimmed">{t().appSkillInvalidHelp}</span>
                    </Show>
                    <Show when={!issue.available}>
                      <StatusBadge tone="neutral" icon={null} label={t().appSkillUnavailable} />
                    </Show>
                  </div>
                );
              }
              if (col.id === "actions" && issue.state !== "invalid") {
                return <AiAppSkillIssueActions appId={issue.appId} appName={appName(issue)} name={issue.name} state={issue.state} />;
              }
              return "";
            }}
          />
        </DataPanel>
      </Show>
    </SettingsPage>
  );
}
