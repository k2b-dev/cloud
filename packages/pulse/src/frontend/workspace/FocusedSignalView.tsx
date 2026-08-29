import { Button, DataTable, TextInput, type DataTableColumn } from "@k2b/ui";
import { createMemo, Show, type Accessor, type JSX, type Setter } from "solid-js";
import type { PulseCurrentState, PulseMetricSeries, PulseMetricSummary, PulseRecordedEvent } from "../../contracts";
import { usePulseMessages } from "../use-messages";
import { FocusedEventDetail, FocusedMetricSeriesDetail, FocusedStateDetail } from "./FocusedSignalDetails";
import { plural, stateRowId, type PulseDateContext } from "./helpers";
import type { WorkspaceView } from "./types";

type CellRenderer<Row> = (row: Row, col: DataTableColumn<Row>, render: (value: unknown) => JSX.Element) => JSX.Element;
type FocusedSignalKind = "metric" | "state" | "event";

export type FocusedSignalViewProps = {
  view: Accessor<WorkspaceView>;
  signalId: Accessor<string>;
  focusedMetric: Accessor<PulseMetricSummary | null>;
  metricSeries: Accessor<PulseMetricSeries[]>;
  states: Accessor<PulseCurrentState[]>;
  events: Accessor<PulseRecordedEvent[]>;
  hasMore: Accessor<boolean>;
  loadingMore: Accessor<boolean>;
  search: Accessor<string>;
  setSearch: Setter<string>;
  selectedSeries: Accessor<PulseMetricSeries | null>;
  selectedState: Accessor<PulseCurrentState | null>;
  selectedEvent: Accessor<PulseRecordedEvent | null>;
  setSelectedSeriesId: Setter<string>;
  setSelectedStateId: Setter<string>;
  setSelectedEventId: Setter<string>;
  metricSeriesColumns: DataTableColumn<PulseMetricSeries>[];
  stateColumns: DataTableColumn<PulseCurrentState>[];
  eventColumns: DataTableColumn<PulseRecordedEvent>[];
  renderMetricSeriesCell: CellRenderer<PulseMetricSeries>;
  renderStateCell: CellRenderer<PulseCurrentState>;
  renderEventCell: CellRenderer<PulseRecordedEvent>;
  loadRows: (options?: { append?: boolean }) => void | Promise<void>;
  onOpenQuery: () => void;
  sourceNameById: () => Map<string, string>;
  dateContext: Accessor<PulseDateContext>;
  openSource: (sourceId: string | null | undefined) => void;
  closeDetail: () => void;
};

const focusedSignalKind = (view: WorkspaceView): FocusedSignalKind => {
  if (view === "metric-detail") return "metric";
  if (view === "state-detail") return "state";
  return "event";
};

const focusedSignalTitle = (kind: FocusedSignalKind) => (kind === "metric" ? "Metric" : kind === "state" ? "State" : "Event");
const focusedSignalIcon = (kind: FocusedSignalKind) =>
  kind === "metric" ? "ti-stack-3" : kind === "state" ? "ti-toggle-right" : "ti-bolt";
const focusedSearchPlaceholder = (kind: FocusedSignalKind) =>
  kind === "metric" ? "Search variants..." : kind === "state" ? "Search state variants..." : "Search events...";
const focusedRowsLabel = (kind: FocusedSignalKind, props: FocusedSignalViewProps) =>
  kind === "metric"
    ? plural(props.metricSeries().length, "variant")
    : kind === "state"
      ? plural(props.states().length, "variant")
      : plural(props.events().length, "event");
const focusedSubtitle = (kind: FocusedSignalKind, props: FocusedSignalViewProps, rowsLabel: string) => {
  if (kind === "metric")
    return `${props.focusedMetric()?.type ?? "metric"}${props.focusedMetric()?.unit ? ` · ${props.focusedMetric()?.unit}` : ""} · ${rowsLabel}`;
  return `${kind} · ${rowsLabel}`;
};

const FocusedSignalHeader = (props: FocusedSignalViewProps & { kind: Accessor<FocusedSignalKind>; rowsLabel: Accessor<string> }) => {
  const t = usePulseMessages();
  const title = () => (props.kind() === "metric" ? t().metric : props.kind() === "state" ? t().state : t().event);
  return (
  <header class="flex shrink-0 flex-wrap items-center gap-3">
    <span class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 app-accent-text dark:bg-zinc-900">
      <i class={`ti ${focusedSignalIcon(props.kind())} text-base`} />
    </span>
    <div class="min-w-0 flex-1">
      <p class="text-label text-[11px]">{title()}</p>
      <h1 class="mt-0.5 truncate text-lg font-semibold leading-6 text-primary">{props.signalId()}</h1>
      <p class="mt-0.5 truncate text-xs text-dimmed">{focusedSubtitle(props.kind(), props, props.rowsLabel())}</p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={() => void props.loadRows()}>
        <i class={`ti ${props.loadingMore() ? "ti-loader-2 animate-spin" : "ti-refresh"}`} /> {t().reload}
      </Button>
      <Button type="button" variant="secondary" size="sm" onClick={props.onOpenQuery}>
        <i class="ti ti-code" /> {t().openQuery}
      </Button>
    </div>
  </header>
  );
};

const FocusedSignalSearch = (props: FocusedSignalViewProps & { kind: Accessor<FocusedSignalKind>; rowsLabel: Accessor<string> }) => {
  const t = usePulseMessages();
  const placeholder = () =>
    props.kind() === "metric" ? t().searchVariants : props.kind() === "state" ? t().searchStateVariants : t().searchEventsPlaceholder;
  return (
  <div class="flex shrink-0 flex-wrap items-center gap-2">
    <div class="min-w-64 flex-1">
      <TextInput
        type="search"
        icon="ti ti-search"
        value={props.search}
        onValueChange={(value) => props.setSearch(value)}
        placeholder={placeholder()}
        clearable
      />
    </div>
    <span class="chip">
      <i class={focusedSignalIcon(props.kind())} />
      {props.rowsLabel()}
    </span>
  </div>
  );
};

const FocusedMetricTable = (props: FocusedSignalViewProps) => {
  const t = usePulseMessages();
  return (
  <DataTable
    rows={props.metricSeries()}
    columns={props.metricSeriesColumns}
    getRowId={(item) => item.id}
    selectedRowId={props.selectedSeries()?.id ?? null}
    onRowClick={(item) => props.setSelectedSeriesId(item.id)}
    density="compact"
    fillHeight
    class="min-h-0 flex-1 overflow-auto"
    empty={t().noVariantsFound}
    hasMore={props.hasMore()}
    loadingMore={props.loadingMore()}
    onLoadMore={() => void props.loadRows({ append: true })}
    scrollPreserveKey={`pulse-focused-metric-${props.signalId()}`}
    renderCell={({ row, col, render }) => props.renderMetricSeriesCell(row, col, render)}
  />
  );
};

const FocusedStateTable = (props: FocusedSignalViewProps & { selectedStateRowId: Accessor<string | null> }) => {
  const t = usePulseMessages();
  return (
  <DataTable
    rows={props.states()}
    columns={props.stateColumns}
    getRowId={stateRowId}
    selectedRowId={props.selectedStateRowId()}
    onRowClick={(state) => props.setSelectedStateId(stateRowId(state))}
    density="compact"
    fillHeight
    class="min-h-0 flex-1 overflow-auto"
    empty={t().noStateVariantsFound}
    hasMore={props.hasMore()}
    loadingMore={props.loadingMore()}
    onLoadMore={() => void props.loadRows({ append: true })}
    scrollPreserveKey={`pulse-focused-state-${props.signalId()}`}
    renderCell={({ row, col, render }) => props.renderStateCell(row, col, render)}
  />
  );
};

const FocusedEventTable = (props: FocusedSignalViewProps) => {
  const t = usePulseMessages();
  return (
  <DataTable
    rows={props.events()}
    columns={props.eventColumns}
    getRowId={(event) => event.id}
    selectedRowId={props.selectedEvent()?.id ?? null}
    onRowClick={(event) => props.setSelectedEventId(event.id)}
    density="compact"
    fillHeight
    class="min-h-0 flex-1 overflow-auto"
    empty={t().noEventsFound}
    hasMore={props.hasMore()}
    loadingMore={props.loadingMore()}
    onLoadMore={() => void props.loadRows({ append: true })}
    scrollPreserveKey={`pulse-focused-event-${props.signalId()}`}
    renderCell={({ row, col, render }) => props.renderEventCell(row, col, render)}
  />
  );
};

const FocusedSignalTable = (
  props: FocusedSignalViewProps & { kind: Accessor<FocusedSignalKind>; selectedStateRowId: Accessor<string | null> },
) => (
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <Show when={props.kind() === "metric"}>
      <FocusedMetricTable {...props} />
    </Show>
    <Show when={props.kind() === "state"}>
      <FocusedStateTable {...props} selectedStateRowId={props.selectedStateRowId} />
    </Show>
    <Show when={props.kind() === "event"}>
      <FocusedEventTable {...props} />
    </Show>
  </div>
);

const FocusedMetricDetailPane = (props: FocusedSignalViewProps) => (
  <Show when={props.selectedSeries()} keyed>
    {(item) => (
      <FocusedMetricSeriesDetail
        item={item}
        metricName={props.signalId()}
        sourceId={item.sourceId}
        sourceNameById={props.sourceNameById}
        dateContext={props.dateContext()}
        metricUnit={props.focusedMetric()?.unit ?? null}
        openSource={props.openSource}
        openQuery={props.onOpenQuery}
        close={props.closeDetail}
      />
    )}
  </Show>
);

const FocusedStateDetailPane = (props: FocusedSignalViewProps) => (
  <Show when={props.selectedState()} keyed>
    {(state) => (
      <FocusedStateDetail
        state={state}
        sourceId={state.sourceId}
        sourceNameById={props.sourceNameById}
        dateContext={props.dateContext()}
        openSource={props.openSource}
        openQuery={props.onOpenQuery}
        close={props.closeDetail}
      />
    )}
  </Show>
);

const FocusedEventDetailPane = (props: FocusedSignalViewProps) => (
  <Show when={props.selectedEvent()} keyed>
    {(event) => (
      <FocusedEventDetail
        event={event}
        sourceId={event.sourceId}
        sourceNameById={props.sourceNameById}
        dateContext={props.dateContext()}
        openSource={props.openSource}
        openQuery={props.onOpenQuery}
        close={props.closeDetail}
      />
    )}
  </Show>
);

export function FocusedSignalDetail(props: FocusedSignalViewProps) {
  const kind = createMemo(() => focusedSignalKind(props.view()));
  return (
    <div class="h-full min-h-0 overflow-hidden">
      <Show when={kind() === "metric"}>
        <FocusedMetricDetailPane {...props} />
      </Show>
      <Show when={kind() === "state"}>
        <FocusedStateDetailPane {...props} />
      </Show>
      <Show when={kind() === "event"}>
        <FocusedEventDetailPane {...props} />
      </Show>
    </div>
  );
}

const FocusedSignalRows = (
  props: FocusedSignalViewProps & { kind: Accessor<FocusedSignalKind>; selectedStateRowId: Accessor<string | null> },
) => (
  <section class="h-[min(68vh,54rem)] min-h-[32rem] shrink-0 overflow-hidden">
    <FocusedSignalTable {...props} kind={props.kind} selectedStateRowId={props.selectedStateRowId} />
  </section>
);

export default function FocusedSignalView(props: FocusedSignalViewProps) {
  const t = usePulseMessages();
  const kind = createMemo(() => focusedSignalKind(props.view()));
  const rowsLabel = createMemo(() =>
    kind() === "event" ? t().eventCount({ count: props.events().length }) : t().variantCount({ count: kind() === "metric" ? props.metricSeries().length : props.states().length }),
  );
  const selectedStateRowId = createMemo(() => {
    const state = props.selectedState();
    return state ? stateRowId(state) : null;
  });

  return (
    <section class="flex min-h-0 flex-1 flex-col gap-2">
      <FocusedSignalHeader {...props} kind={kind} rowsLabel={rowsLabel} />
      <FocusedSignalSearch {...props} kind={kind} rowsLabel={rowsLabel} />
      <FocusedSignalRows {...props} kind={kind} selectedStateRowId={selectedStateRowId} />
    </section>
  );
}
