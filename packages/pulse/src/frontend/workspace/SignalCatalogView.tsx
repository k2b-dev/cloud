import { DataTable, IconButton, Tooltip, type DataTableColumn } from "@k2b/ui";
import { type Accessor, type JSX } from "solid-js";
import type { PulseMetricSummary } from "../../contracts";
import { usePulseMessages } from "../use-messages";
import { compactDateWithDelta, formatSignalValue, formatValue, type PulseDateContext } from "./helpers";
import { SignalCatalogTabs, SignalCatalogToolbar, type SignalCatalogKind, type SignalCatalogTab } from "./SignalCatalogChrome";
import type { ActivityEventGroup, ActivityStateGroup } from "./types";

type MetricScope = {
  sources: Set<string>;
  resources: Set<string>;
};

type SignalCatalogViewProps = {
  kind: SignalCatalogKind;
  tabs: SignalCatalogTab[];
  search: Accessor<string>;
  metricTypeFilter: Accessor<string>;
  onSearch: (value: string) => void;
  onMetricTypeFilter: (value: string[]) => void;
  eventGroups: Accessor<ActivityEventGroup[]>;
  stateGroups: Accessor<ActivityStateGroup[]>;
  metrics: Accessor<PulseMetricSummary[]>;
  eventColumns: DataTableColumn<ActivityEventGroup>[];
  stateColumns: DataTableColumn<ActivityStateGroup>[];
  metricColumns: DataTableColumn<PulseMetricSummary>[];
  metricScopeByName: Accessor<Map<string, MetricScope>>;
  sourceNameById: Accessor<Map<string, string>>;
  dateContext: Accessor<PulseDateContext>;
  openEventDetail: (event: string) => void;
  openStateDetail: (state: string) => void;
  openMetricDetail: (metric: string) => void;
  openSource: (sourceId: string) => void;
};

const SignalInfoButton = (props: { label: string; onClick: () => void }) => (
  <Tooltip.Anchor content={props.label}>
    <IconButton
      label={props.label}
      variant="ghost"
      size="xs"
      class="h-6 w-6 shrink-0"
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
    >
      <i class="ti ti-info-circle" />
    </IconButton>
  </Tooltip.Anchor>
);

const renderSignalNameCell = (label: string, value: string, onClick: () => void): JSX.Element => (
  <span class="flex min-w-0 items-center gap-1.5">
    <SignalInfoButton label={label} onClick={onClick} />
    <span class="truncate">{value}</span>
  </span>
);

const metricScopeCount = (metric: PulseMetricSummary, metricScopeByName: Map<string, MetricScope>, scope: keyof MetricScope): number =>
  metricScopeByName.get(metric.name)?.[scope].size ?? 0;

const renderMetricScopeCountCell = (
  metric: PulseMetricSummary,
  metricScopeByName: Map<string, MetricScope>,
  scope: keyof MetricScope,
): JSX.Element => <span class="text-xs text-secondary">{metricScopeCount(metric, metricScopeByName, scope) || "-"}</span>;

const renderMetricLastSeenCell = (metric: PulseMetricSummary, dateContext: PulseDateContext): JSX.Element => (
  <span class="text-xs text-secondary">{metric.lastSeenAt ? compactDateWithDelta(metric.lastSeenAt, dateContext) : "-"}</span>
);

export default function SignalCatalogView(props: SignalCatalogViewProps) {
  const t = usePulseMessages();
  const renderSourceLink = (sourceId: string | null | undefined) => {
    if (!sourceId) return <span class="text-xs text-dimmed">-</span>;
    return (
      <button
        type="button"
        class="inline-flex max-w-full items-center gap-1 truncate text-xs font-medium text-secondary transition hover:app-accent-text"
        onClick={(event) => {
          event.stopPropagation();
          props.openSource(sourceId);
        }}
        title={t().openSource}
      >
        <i class="ti ti-database-share shrink-0" />
        <span class="truncate">{props.sourceNameById().get(sourceId) ?? t().unknownSource}</span>
      </button>
    );
  };

  const renderEventGroupCell = (
    group: ActivityEventGroup,
    col: DataTableColumn<ActivityEventGroup>,
    render: (value: unknown) => JSX.Element,
  ) => {
    if (col.id === "kind") {
      return renderSignalNameCell(t().openEvent, group.kind, () => props.openEventDetail(group.kind));
    }
    if (col.id === "source") return renderSourceLink(group.sourceId);
    if (col.id === "value")
      return <span class="text-xs text-secondary">{group.latest.value === null ? "-" : formatValue(group.latest.value)}</span>;
    if (col.id === "count") return <span class="text-xs text-secondary">{group.rows.length}</span>;
    if (col.id === "time") return <span class="text-xs text-secondary">{compactDateWithDelta(group.latest.ts, props.dateContext())}</span>;
    return render(group[col.id as keyof ActivityEventGroup]);
  };

  const renderStateGroupCell = (
    group: ActivityStateGroup,
    col: DataTableColumn<ActivityStateGroup>,
    render: (value: unknown) => JSX.Element,
  ) => {
    if (col.id === "key") {
      return renderSignalNameCell(t().openState, group.key, () => props.openStateDetail(group.key));
    }
    if (col.id === "source") return renderSourceLink(group.sourceId);
    if (col.id === "value") {
      if (group.rows.length > 1) return <span class="text-xs text-dimmed">{t().variantCount({ count: group.rows.length })}</span>;
      return (
        <span class="line-clamp-2 text-xs text-secondary" title={formatSignalValue(group.latest.value)}>
          {formatSignalValue(group.latest.value)}
        </span>
      );
    }
    if (col.id === "updated")
      return <span class="text-xs text-secondary">{compactDateWithDelta(group.latest.updatedAt, props.dateContext())}</span>;
    return render(group[col.id as keyof ActivityStateGroup]);
  };

  const renderMetricCell = (
    metric: PulseMetricSummary,
    col: DataTableColumn<PulseMetricSummary>,
    render: (value: unknown) => JSX.Element,
  ) => {
    if (col.id === "name") {
      return renderSignalNameCell(t().openMetric, metric.name, () => props.openMetricDetail(metric.name));
    }
    if (col.id === "unit") return <span class="text-xs text-secondary">{metric.unit ?? "-"}</span>;
    if (col.id === "sources") return renderMetricScopeCountCell(metric, props.metricScopeByName(), "sources");
    if (col.id === "resources") return renderMetricScopeCountCell(metric, props.metricScopeByName(), "resources");
    if (col.id === "series") return <span class="text-xs text-secondary">{metric.seriesCount}</span>;
    if (col.id === "lastSeen") return renderMetricLastSeenCell(metric, props.dateContext());
    return render(metric[col.id as keyof PulseMetricSummary]);
  };

  const renderTable = () => {
    if (props.kind === "events") {
      return (
        <DataTable
          rows={props.eventGroups()}
          columns={props.eventColumns}
          getRowId={(group) => group.id}
          selectedRowId={null}
          onRowClick={(group) => props.openEventDetail(group.kind)}
          density="compact"
          fillHeight
          class="paper flex-1 min-h-0 overflow-auto"
          empty={t().noEventsIngested}
          scrollPreserveKey="pulse-signals-events"
          renderCell={({ row, col, render }) => renderEventGroupCell(row, col, render)}
        />
      );
    }
    if (props.kind === "states") {
      return (
        <DataTable
          rows={props.stateGroups()}
          columns={props.stateColumns}
          getRowId={(group) => group.id}
          selectedRowId={null}
          onRowClick={(group) => props.openStateDetail(group.key)}
          density="compact"
          fillHeight
          class="paper flex-1 min-h-0 overflow-auto"
          empty={t().noStatesIngested}
          scrollPreserveKey="pulse-signals-states"
          renderCell={({ row, col, render }) => renderStateGroupCell(row, col, render)}
        />
      );
    }
    return (
      <DataTable
        rows={props.metrics()}
        columns={props.metricColumns}
        getRowId={(metric) => metric.name}
        selectedRowId={null}
        onRowClick={(metric) => props.openMetricDetail(metric.name)}
        density="compact"
        fillHeight
        class="paper flex-1 min-h-0 overflow-auto"
        empty={t().noMetricsIngested}
        scrollPreserveKey="pulse-signals-metrics"
        renderCell={({ row, col, render }) => renderMetricCell(row, col, render)}
      />
    );
  };

  return (
    <section class="flex min-h-0 flex-1 flex-col gap-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <SignalCatalogTabs kind={props.kind} tabs={props.tabs} />
        <SignalCatalogToolbar
          kind={props.kind}
          search={props.search}
          metricTypeFilter={props.metricTypeFilter}
          onSearch={props.onSearch}
          onMetricTypeFilter={props.onMetricTypeFilter}
        />
      </div>
      {renderTable()}
    </section>
  );
}
