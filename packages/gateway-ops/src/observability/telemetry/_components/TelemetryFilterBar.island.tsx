import { navigateTo } from "@k2b/ssr/nav";
import { ButtonLink, FilterChip, type FilterChipSection, useLocale } from "@k2b/ui";
import {
  DEFAULT_TELEMETRY_ROUTE_SORT,
  TELEMETRY_RANGES,
  TELEMETRY_ROUTE_SORTS,
  TELEMETRY_SORT_LABELS,
  type TelemetryRange,
  type TelemetryRouteSort,
} from "../contracts";
import { buildTelemetryFilterUrl, clearTelemetryFiltersUrl, hasActiveTelemetryFilters, selectAppUrl, type TelemetryFilter } from "./types";
import { gatewayOpsMessages, type GatewayOpsMessages } from "../../../messages";

export type TelemetryAppFilterOption = {
  id: string;
  label: string;
  icon: string;
};

type Props = {
  filter: TelemetryFilter;
  apps: TelemetryAppFilterOption[];
};

const rangeLabels = (t: GatewayOpsMessages): Record<TelemetryRange, string> => ({
  "1h": t.lastHour,
  "6h": t.lastHours({ count: 6 }),
  "24h": t.lastHours({ count: 24 }),
  "7d": t.lastDays({ count: 7 }),
  "30d": t.lastDays({ count: 30 }),
});

const SORT_ICONS: Record<TelemetryRouteSort, string> = {
  errorRate: "ti ti-percentage",
  errors: "ti ti-alert-circle",
  requests: "ti ti-flame",
  slow: "ti ti-clock-exclamation",
  duration: "ti ti-hourglass",
};

const translatedSortLabel = (sort: TelemetryRouteSort, t: GatewayOpsMessages): string => {
  if (sort === "errorRate") return t.errorRate;
  if (sort === "errors") return t.errors;
  if (sort === "requests") return t.requests;
  if (sort === "slow") return t.slow;
  return t.duration;
};

/**
 * Navigation only — the server owns every value shown here. This is an island
 * purely because `FilterChip` needs click handlers.
 */
export default function TelemetryFilterBar(props: Props) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const labels = rangeLabels(t);
  const rangeOptions: FilterChipSection[] = [{
    options: (Object.keys(TELEMETRY_RANGES) as TelemetryRange[]).map((value) => ({ value, label: labels[value], icon: "ti ti-clock" })),
  }];
  const sortOptions: FilterChipSection[] = [{
    options: TELEMETRY_ROUTE_SORTS.map((value) => ({ value, label: translatedSortLabel(value, t), icon: SORT_ICONS[value] })),
  }];
  const scopeOptions: FilterChipSection[] = [{
    options: [
      { value: "errors", label: t.withErrors, icon: "ti ti-alert-circle" },
      { value: "slow", label: t.withSlowRequests, icon: "ti ti-clock-exclamation" },
    ],
    multiple: true,
  }];
  const appOptions = (): FilterChipSection[] => [
    {
      options: [
        { value: "", label: t.allApps, icon: "ti ti-apps" },
        ...props.apps.map((app) => ({ value: app.id, label: app.label, icon: app.icon })),
      ],
    },
  ];

  const activeScope = () => [props.filter.errorsOnly ? "errors" : "", props.filter.slowOnly ? "slow" : ""].filter(Boolean);

  return (
    <div class="flex flex-wrap items-center gap-2">
      <FilterChip
        label={labels[props.filter.range]}
        icon="ti ti-clock"
        options={rangeOptions}
        value={[props.filter.range]}
        onValueChange={(value) => {
          const range = value[0] as TelemetryRange | undefined;
          if (range) navigateTo(buildTelemetryFilterUrl(props.filter, { range }));
        }}
        isActive
        defaultValue={[props.filter.range]}
      />
      <FilterChip
        label={t.app}
        icon="ti ti-apps"
        options={appOptions()}
        value={props.filter.appId ? [props.filter.appId] : []}
        onValueChange={(value) => navigateTo(selectAppUrl(props.filter, value[0] ?? ""))}
        isActive={props.filter.appId.length > 0}
        defaultValue={[]}
      />
      <FilterChip
        label={t.sortLabel({ label: translatedSortLabel(props.filter.sort, t) })}
        icon="ti ti-arrows-sort"
        options={sortOptions}
        value={[props.filter.sort]}
        onValueChange={(value) => {
          const sort = (value[0] ?? DEFAULT_TELEMETRY_ROUTE_SORT) as TelemetryRouteSort;
          navigateTo(buildTelemetryFilterUrl(props.filter, { sort }));
        }}
        isActive={props.filter.sort !== DEFAULT_TELEMETRY_ROUTE_SORT}
        defaultValue={[DEFAULT_TELEMETRY_ROUTE_SORT]}
      />
      <FilterChip
        label={t.showOnly}
        icon="ti ti-filter"
        options={scopeOptions}
        value={activeScope()}
        onValueChange={(value) =>
          navigateTo(
            buildTelemetryFilterUrl(props.filter, {
              errorsOnly: value.includes("errors"),
              slowOnly: value.includes("slow"),
            }),
          )
        }
        isActive={props.filter.errorsOnly || props.filter.slowOnly}
        defaultValue={[]}
      />
      {hasActiveTelemetryFilters(props.filter) ? (
        <ButtonLink href={clearTelemetryFiltersUrl(props.filter)} variant="secondary" size="sm">
          <i class="ti ti-x" aria-hidden="true" /> {t.clear}
        </ButtonLink>
      ) : null}
    </div>
  );
}
