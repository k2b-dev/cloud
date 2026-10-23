import { SearchBar } from "@k2b/cloud/ssr/islands";
import { navigateTo, refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  Checkbox,
  FilterChip,
  type FilterChipSection,
  NoticeCard,
  NumberInput,
  prompts,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";
import { apiClient as loggingClient } from "../api-client";
import { buildLogFilterUrl, defaultLogFilter, hasActiveLogFilters, type LogFilterState } from "./types";

type Props = {
  filter: LogFilterState;
  sources: string[];
  retentionDays: number;
  retentionUnreadable?: boolean;
};

export default function LogFilterBar(props: Props) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const levelOptions: FilterChipSection[] = [
    {
      options: [
        { value: "all", label: t.all, icon: "ti ti-list" },
        { value: "debug", label: t.debug, icon: "ti ti-bug" },
        { value: "info", label: t.info, icon: "ti ti-info-circle" },
        { value: "warn", label: t.warn, icon: "ti ti-alert-triangle" },
        { value: "error", label: t.error, icon: "ti ti-alert-circle" },
      ],
    },
  ];
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

  const handleSettings = () =>
    prompts.dialog<void>(
      (close) => <LogRetentionDialog retentionDays={props.retentionDays} unreadable={props.retentionUnreadable} close={close} />,
      { title: t.logSettings, size: "small" },
    );

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
          <ButtonLink href={baseUrl} variant="ghost" size="sm" aria-label={t.clearAllFilters}>
            <i class="ti ti-x" aria-hidden="true" /> {t.clear}
          </ButtonLink>
        )}
        <div class="ml-auto flex items-center gap-2 shrink-0">
          <Tooltip.Anchor content={t.configureLogRetention}>
            <Button type="button" variant="secondary" size="sm" onClick={handleSettings} aria-label={t.logSettings}>
              <i class="ti ti-settings" />
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

export function LogRetentionDialog(props: { retentionDays: number; unreadable?: boolean; close: () => void }) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const [days, setDays] = createSignal<number | null>(props.retentionDays);
  const [unreadable, setUnreadable] = createSignal(props.unreadable);
  const [replace, setReplace] = createSignal(false);
  const save = mutations.create({
    mutation: async () => {
      const response = await loggingClient.settings.retention.$put({
        json: { retentionDays: days()!, replaceUnreadable: unreadable() === true && replace() },
      });
      if (!response.ok) {
        const body = await response.json();
        const failure = body.message ?? t.saveFailed;
        if ("code" in body && body.code === "setting_unreadable") {
          try {
            const latest = await loggingClient.settings.retention.$get();
            if (!latest.ok) throw new Error(t.recoveryFailed);
            setUnreadable((await latest.json()).unreadable);
          } catch {
            throw new Error(`${failure} ${t.recoveryFailed}`);
          }
        }
        throw new Error(failure);
      }
    },
    onSuccess: () => {
      toast.success(t.logRetentionUpdated);
      props.close();
      refreshCurrentPath();
    },
  });
  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (days() && (!unreadable() || replace()) && !save.loading()) void save.mutate(undefined);
      }}
    >
      <Show when={unreadable()}>
        <NoticeCard tone="warning" title={t.unreadableTitle} detail={t.unreadableDetail}>
          <Checkbox
            label={`${t.replaceStored}: ${t.retentionDays}`}
            value={replace()}
            onValueChange={setReplace}
            disabled={save.loading()}
          />
        </NoticeCard>
      </Show>
      <NumberInput
        label={t.retentionDays}
        value={days()}
        onValueChange={setDays}
        min={1}
        required
        disabled={save.loading() || (unreadable() && !replace())}
      />
      <Show when={save.error()}>
        <NoticeCard tone="danger" title={t.saveFailed} detail={save.error()?.message} />
      </Show>
      <div class="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={props.close} disabled={save.loading()}>
          {t.cancel}
        </Button>
        <Button type="submit" loading={save.loading()} disabled={!days() || (unreadable() && !replace())}>
          {t.save}
        </Button>
      </div>
    </form>
  );
}
