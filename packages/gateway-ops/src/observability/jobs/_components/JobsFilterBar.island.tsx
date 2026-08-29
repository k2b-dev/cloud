import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, type FilterChipSection, useLocale } from "@k2b/ui";
import { SearchBar } from "@valentinkolb/cloud/ssr/islands";
import {
  buildJobsFilterUrl,
  defaultJobsFilter,
  hasActiveJobsFilters,
  type JobsFilterState,
  jobsDurationOptions,
  jobsWindowOptions,
} from "./types";
import { gatewayOpsMessages } from "../../../messages";

type Props = {
  filter: JobsFilterState;
};

const baseUrl = "/admin/observability/jobs";

export default function JobsFilterBar(props: Props) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const windowOptions: FilterChipSection[] = [{
    options: jobsWindowOptions.map((option) => ({
      value: option.value,
      label: option.value.endsWith("m")
        ? t.lastMinutes({ count: Number(option.value.slice(0, -1)) })
        : option.value.endsWith("d")
          ? t.lastDays({ count: Number(option.value.slice(0, -1)) })
          : t.lastHours({ count: Number(option.value.slice(0, -1)) }),
      icon: "ti ti-clock",
    })),
  }];
  const healthOptions: FilterChipSection[] = [{ options: [
    { value: "all", label: t.allStates, icon: "ti ti-list" },
    { value: "failed", label: t.failed, icon: "ti ti-alert-circle" },
    { value: "running", label: t.running, icon: "ti ti-loader" },
    { value: "healthy", label: t.healthy, icon: "ti ti-check" },
  ] }];
  const typeOptions: FilterChipSection[] = [{ options: [
    { value: "all", label: t.allTypes, icon: "ti ti-stack-2" },
    { value: "job", label: t.backgroundJobs, icon: "ti ti-briefcase" },
    { value: "schedule", label: t.schedules, icon: "ti ti-calendar-time" },
    { value: "backfill", label: t.backfills, icon: "ti ti-database-import" },
    { value: "ai", label: "AI", icon: "ti ti-sparkles" },
    { value: "sync", label: "Sync", icon: "ti ti-refresh" },
    { value: "notification", label: t.notifications, icon: "ti ti-bell" },
    { value: "http", label: "HTTP", icon: "ti ti-world" },
    { value: "custom", label: t.custom, icon: "ti ti-settings" },
  ] }];
  const durationOptions: FilterChipSection[] = [{
    options: jobsDurationOptions.map((option) => ({ value: option.value, label: option.value === "all" ? t.allDurations : option.label, icon: "ti ti-hourglass" })),
  }];
  const navigate = (updates: Partial<JobsFilterState>) => {
    navigateTo(buildJobsFilterUrl(baseUrl, { ...updates, page: 1, run: null }, props.filter));
  };

  const searchAction = buildJobsFilterUrl(
    baseUrl,
    {
      search: "",
      page: 1,
      run: null,
    },
    props.filter,
  );
  const clearUrl = buildJobsFilterUrl(
    baseUrl,
    {
      window: defaultJobsFilter.window,
      health: defaultJobsFilter.health,
      type: defaultJobsFilter.type,
      duration: defaultJobsFilter.duration,
      search: "",
      run: null,
      page: 1,
    },
    props.filter,
  );

  return (
    <div class="flex flex-col gap-2">
      <SearchBar action={searchAction} value={props.filter.search} placeholder={t.searchJobs} />
      <div class="flex items-center gap-2 flex-wrap">
        <FilterChip
          label={t.window}
          icon="ti ti-clock"
          options={windowOptions}
          value={[props.filter.window]}
          onValueChange={(value) => navigate({ window: (value[0] as JobsFilterState["window"]) ?? defaultJobsFilter.window })}
          isActive={props.filter.window !== defaultJobsFilter.window}
          defaultValue={[defaultJobsFilter.window]}
        />
        <FilterChip
          label={t.health}
          icon="ti ti-filter"
          options={healthOptions}
          value={[props.filter.health]}
          onValueChange={(value) => navigate({ health: (value[0] as JobsFilterState["health"]) ?? defaultJobsFilter.health })}
          isActive={props.filter.health !== defaultJobsFilter.health}
          defaultValue={[defaultJobsFilter.health]}
        />
        <FilterChip
          label={t.type}
          icon="ti ti-stack-2"
          options={typeOptions}
          value={[props.filter.type]}
          onValueChange={(value) => navigate({ type: (value[0] as JobsFilterState["type"]) ?? defaultJobsFilter.type })}
          isActive={props.filter.type !== defaultJobsFilter.type}
          defaultValue={[defaultJobsFilter.type]}
        />
        <FilterChip
          label={t.duration}
          icon="ti ti-hourglass"
          options={durationOptions}
          value={[props.filter.duration]}
          onValueChange={(value) => navigate({ duration: (value[0] as JobsFilterState["duration"]) ?? defaultJobsFilter.duration })}
          isActive={props.filter.duration !== defaultJobsFilter.duration}
          defaultValue={[defaultJobsFilter.duration]}
        />
        {hasActiveJobsFilters(props.filter) && (
          <a href={clearUrl} class="text-[10px] text-red-500 tabular-nums hidden sm:inline" aria-label={t.clearAllFilters}>
            <i class="ti ti-x" /> {t.clear}
          </a>
        )}
      </div>
    </div>
  );
}
