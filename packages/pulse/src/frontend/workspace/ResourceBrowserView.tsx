import { Button, DataTable, FilterChip, TextInput, type DataTableColumn, type FilterChipSection, useLocale } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import type { PulseInventory, PulseResourceSummary } from "../../contracts";
import { compactDateWithDelta, dimensionsSummary, type PulseDateContext } from "./helpers";
import { usePulseMessages } from "../use-messages";

type Props = {
  search: () => string;
  setSearch: (value: string) => void;
  sourceFilter: () => string;
  setSourceFilter: (value: string[]) => void;
  typeFilter: () => string;
  setTypeFilter: (value: string[]) => void;
  clearFilters: () => void;
  inventory: () => PulseInventory;
  filteredResources: () => PulseResourceSummary[];
  selectedResource: () => PulseResourceSummary | null;
  dateContext: PulseDateContext;
  openResource: (key: string) => void;
  resourceSourceLabel: (resource: PulseResourceSummary) => string;
  sourceNameById: () => Map<string, string>;
};

const resourceIcon = (type: string | null) => {
  if (type === "container") return "ti ti-box";
  if (type === "host") return "ti ti-server";
  if (type === "service") return "ti ti-route";
  if (type === "project") return "ti ti-layout-grid";
  if (type === "filesystem") return "ti ti-folder";
  if (type === "network") return "ti ti-network";
  if (type === "source") return "ti ti-database-share";
  return "ti ti-cube";
};

export default function ResourceBrowserView(props: Props) {
  const t = usePulseMessages();
  const locale = useLocale();
  const resourceColumns: DataTableColumn<PulseResourceSummary>[] = [
    { id: "resource", header: t().resource, value: "label", cellClass: "min-w-72" },
    { id: "type", header: t().type, value: "type", cellClass: "w-32 whitespace-nowrap" },
    { id: "source", header: t().source, cellClass: "min-w-40" },
    { id: "signals", header: t().signals, cellClass: "w-40 whitespace-nowrap" },
    { id: "lastSeen", header: t().lastSeen, value: "lastSeenAt", cellClass: "w-44 whitespace-nowrap" },
  ];
  const typeCounts = createMemo(() => {
    const counts = new Map<string, number>();
    for (const resource of props.inventory().resources) {
      const type = resource.type ?? "resource";
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  });
  const sourceLabel = (sourceId: string) => props.sourceNameById().get(sourceId) ?? t().unknownSource;
  const sourceCounts = createMemo(() => {
    const counts = new Map<string, number>();
    for (const resource of props.inventory().resources) {
      for (const sourceId of resource.sourceIds) counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || sourceLabel(left[0]).localeCompare(sourceLabel(right[0])));
  });
  const sourceCount = createMemo(() => new Set(props.inventory().resources.flatMap((resource) => resource.sourceIds)).size);
  const selectedSourceLabel = createMemo(() => (props.sourceFilter() ? sourceLabel(props.sourceFilter()) : ""));
  const selectedTypeLabel = createMemo(() => props.typeFilter());
  const hasFilters = createMemo(() => Boolean(props.sourceFilter() || props.typeFilter()));
  const typeFilterOptions = createMemo<FilterChipSection[]>(() => [
    {
      options: typeCounts().map(([type, count]) => ({
        value: type,
        label: `${type} (${count})`,
        icon: resourceIcon(type),
      })),
    },
  ]);
  const sourceFilterOptions = createMemo<FilterChipSection[]>(() => [
    {
      options: sourceCounts().map(([sourceId, count]) => ({
        value: sourceId,
        label: `${sourceLabel(sourceId)} (${count})`,
        icon: "ti ti-database-share",
      })),
    },
  ]);

  const renderResourceCell = (resource: PulseResourceSummary, col: DataTableColumn<PulseResourceSummary>) => {
    if (col.id === "resource") {
      return (
        <div class="flex min-w-0 items-center gap-2">
          <span class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
            <i class={`${resourceIcon(resource.type)} text-sm`} />
          </span>
          <div class="min-w-0">
            <p class="truncate text-sm font-medium text-primary">{resource.label || resource.id}</p>
            <p class="mt-0.5 truncate text-[11px] text-dimmed">{dimensionsSummary(resource.dimensions, 3) || resource.id}</p>
          </div>
        </div>
      );
    }
    if (col.id === "type") return <span class="text-xs text-secondary">{resource.type ?? "resource"}</span>;
    if (col.id === "source") return <span class="text-xs text-secondary">{props.resourceSourceLabel(resource)}</span>;
    if (col.id === "signals") {
      const count = resource.metricCount + resource.stateCount + resource.eventCount;
      return (
        <span class="text-xs text-secondary">
          {t().signalCount({ count })}{" "}
          <span class="text-dimmed">
            ({resource.metricCount}m/{resource.stateCount}s/{resource.eventCount}e)
          </span>
        </span>
      );
    }
    if (col.id === "lastSeen")
      return (
        <span class="text-xs text-secondary">
          {resource.lastSeenAt ? compactDateWithDelta(resource.lastSeenAt, props.dateContext) : "-"}
        </span>
      );
    return resource[col.id as keyof PulseResourceSummary] as string;
  };

  return (
    <section class="flex min-h-0 flex-1 flex-col gap-3">
      <div class="flex shrink-0 flex-wrap items-center gap-2">
        <div class="min-w-64 flex-1">
          <TextInput
            type="search"
            icon="ti ti-search"
            value={props.search}
            onValueChange={props.setSearch}
            placeholder={t().searchResourcesPlaceholder}
            clearable
          />
        </div>
        <FilterChip
          label={t().source}
          icon="ti ti-database-share"
          options={sourceFilterOptions()}
          value={props.sourceFilter() ? [props.sourceFilter()] : []}
          onValueChange={props.setSourceFilter}
          isActive={Boolean(props.sourceFilter())}
          defaultValue={[]}
        />
        <FilterChip
          label={t().type}
          icon="ti ti-filter"
          options={typeFilterOptions()}
          value={props.typeFilter() ? [props.typeFilter()] : []}
          onValueChange={props.setTypeFilter}
          isActive={Boolean(props.typeFilter())}
          defaultValue={[]}
        />
      </div>

      <div class="flex shrink-0 flex-wrap items-center gap-2 px-1 text-xs text-dimmed">
        <span>
          {props.filteredResources().length === props.inventory().resources.length
            ? `${t().resourceCount({ count: props.filteredResources().length })} · ${t().sourceCount({ count: sourceCount() })}`
            : t().filteredResourceSummary({
                visible: t().resourceCount({ count: props.filteredResources().length }),
                total: props.inventory().resources.length.toLocaleString(locale()),
                sources: t().sourceCount({ count: sourceCount() }),
              })}
        </span>
        <Show when={props.sourceFilter()}>
          <Button type="button" variant="subtle" size="xs" onClick={() => props.setSourceFilter([])}>
            <i class="ti ti-database-share" />
            {selectedSourceLabel()}
            <i class="ti ti-x text-[10px]" />
          </Button>
        </Show>
        <Show when={props.typeFilter()}>
          <Button type="button" variant="subtle" size="xs" onClick={() => props.setTypeFilter([])}>
            <i class={resourceIcon(props.typeFilter())} />
            {selectedTypeLabel()}
            <i class="ti ti-x text-[10px]" />
          </Button>
        </Show>
        <Show when={hasFilters()}>
          <Button type="button" variant="ghost" size="xs" onClick={props.clearFilters}>
            <i class="ti ti-filter-off" />
            {t().clearFilters}
          </Button>
        </Show>
      </div>

      <DataTable
        rows={props.filteredResources()}
        columns={resourceColumns}
        getRowId={(resource) => resource.key}
        selectedRowId={props.selectedResource()?.key ?? null}
        onRowClick={(resource) => props.openResource(resource.key)}
        density="compact"
        fillHeight
        class="paper flex-1 min-h-0 overflow-auto"
        empty={t().noResourcesDetected}
        scrollPreserveKey="pulse-resources-table"
        renderCell={({ row, col }) => renderResourceCell(row, col)}
      />
    </section>
  );
}
