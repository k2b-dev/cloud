import { navigateTo, refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, FilterChip, type FilterChipSection, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { SearchBar } from "@valentinkolb/cloud/ssr/islands";
import { apiClient as loggingClient } from "../api-client";
import { buildLogFilterUrl, defaultLogFilter, hasActiveLogFilters, type LogFilterState } from "./types";
import { gatewayOpsMessages } from "../../../messages";

type Props = {
  filter: LogFilterState;
  sources: string[];
  retentionDays: number;
};

export default function LogFilterBar(props: Props) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const levelOptions: FilterChipSection[] = [{ options: [
    { value: "all", label: t.all, icon: "ti ti-list" },
    { value: "debug", label: t.debug, icon: "ti ti-bug" },
    { value: "info", label: t.info, icon: "ti ti-info-circle" },
    { value: "warn", label: t.warn, icon: "ti ti-alert-triangle" },
    { value: "error", label: t.error, icon: "ti ti-alert-circle" },
  ] }];
  const baseUrl = "/admin/observability/logs";
  const { filter } = props;

  const navigate = (params: Partial<LogFilterState>) => {
    navigateTo(buildLogFilterUrl(baseUrl, { ...params, page: 1 }, filter));
  };

  const sourceOptions = (): FilterChipSection[] => [
    { multiple: true, options: props.sources.map((s) => ({ value: s, label: s, icon: "ti ti-code" })) },
  ];

  const hasFilters = hasActiveLogFilters(filter);
  const searchAction = buildLogFilterUrl(baseUrl, { level: filter.level, sources: filter.sources }, filter);

  // ── Settings mutation ──
  const saveMutation = mutations.create<void, number>({
    mutation: async (days) => {
      const res = await loggingClient.settings.retention.$put({ json: { retentionDays: days } });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.message ?? t.saveFailed);
      }
    },
    onSuccess: () => toast.success(t.logRetentionUpdated),
    onError: (err) => prompts.error(err.message),
  });

  const handleSettings = async () => {
    const result = await prompts.form({
      title: t.logSettings,
      icon: "ti ti-settings",
      confirmText: t.save,
      fields: {
        retention_days: { type: "number" as const, label: t.retentionDays, default: props.retentionDays, min: 1, required: true },
      },
    });
    if (result) await saveMutation.mutate(result.retention_days);
  };

  // ── Cleanup mutation ──
  const cleanupMutation = mutations.create<{ deleted: number }, number>({
    mutation: async (days) => {
      const res = await loggingClient.cleanup.$delete({ query: { days: String(days) } });
      const result = await res.json();
      if (!res.ok) throw new Error((result as { message?: string }).message ?? t.cleanupFailed);
      return result as { deleted: number };
    },
    onSuccess: (data) => {
      toast.success(t.deletedLogEntries({ count: data.deleted }));
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleCleanup = async () => {
    const result = await prompts.form({
      title: t.cleanupLogs,
      icon: "ti ti-trash",
      confirmText: t.delete,
      variant: "danger",
      fields: { days: { type: "number" as const, label: t.deleteOlderThanDays, default: 30, min: 1, required: true } },
    });
    if (result) await cleanupMutation.mutate(result.days);
  };

  return (
    <div class="flex flex-col gap-2">
      {/* Row 1: search */}
      <SearchBar action={searchAction} value={filter.search} placeholder={t.searchLogs} ariaLabel={t.searchLogsLabel} />

      {/* Row 2: filters + count + actions */}
      <div class="flex items-center gap-2 flex-wrap">
        <FilterChip
          label={t.level}
          icon="ti ti-filter"
          options={levelOptions}
          value={[filter.level]}
          onValueChange={(v) => navigate({ level: v[0] ?? "all" })}
          isActive={filter.level !== defaultLogFilter.level}
          defaultValue={[defaultLogFilter.level]}
        />
        {props.sources.length > 0 && (
          <FilterChip
            label={t.services}
            icon="ti ti-code"
            options={sourceOptions()}
            value={filter.sources}
            onValueChange={(value) => navigate({ sources: value })}
            isActive={filter.sources.length > 0}
            defaultValue={[]}
          />
        )}
        {hasFilters && (
          <a href={baseUrl} class="text-[10px] text-red-500 tabular-nums hidden sm:inline" aria-label={t.clearAllFilters}>
            <i class="ti ti-x" /> {t.clear}
          </a>
        )}
        <div class="ml-auto flex items-center gap-2 shrink-0">
          <Tooltip.Anchor content={t.configureLogRetention}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleSettings}
              disabled={saveMutation.loading()}
              aria-label={t.logSettings}
            >
              <i class={saveMutation.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-settings"} />
              <span class="hidden sm:inline">{t.settings}</span>
            </Button>
          </Tooltip.Anchor>
          <Tooltip.Anchor content={t.deleteOldLogEntries}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleCleanup}
              disabled={cleanupMutation.loading()}
              aria-label={t.cleanupLogs}
            >
              <i class={cleanupMutation.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-trash"} />
              <span class="hidden sm:inline">{t.cleanup}</span>
            </Button>
          </Tooltip.Anchor>
        </div>
      </div>
    </div>
  );
}
