import {
  Button,
  DataTable,
  type DataTableColumn,
  DetailPanel,
  IconButton,
  isStructuredDataValue,
  StructuredDataPreview,
  type StructuredDataValue,
  Tabs,
  Tooltip,
} from "@k2b/ui";
import { type Accessor, createEffect, createMemo, createSignal, type JSX, Show } from "solid-js";
import type { PulseCurrentState, PulseRecordedEvent, PulseResourceMetric, PulseResourceSummary } from "../../contracts";
import {
  compactDateWithDelta,
  dimensionsSummary,
  formatMetricValue,
  formatSignalValue,
  formatValue,
  type PulseDateContext,
  signalSubject,
} from "./helpers";
import type { pulseMessages } from "../../messages";
import { usePulseMessages } from "../use-messages";

type Messages = ReturnType<typeof pulseMessages.resolve>["t"];

const structuredData = (value: unknown, label: string): StructuredDataValue =>
  isStructuredDataValue(value) ? value : { error: `${label} is not valid JSON.` };

export type ResourceDetailProps = {
  resource: PulseResourceSummary;
  metrics: PulseResourceMetric[];
  states: PulseCurrentState[];
  events: PulseRecordedEvent[];
  dateContext: PulseDateContext;
  sourceNameById: () => Map<string, string>;
  openSource: (sourceId: string | null | undefined) => void;
  openMetricQuery: (metric: PulseResourceMetric) => void;
  openMetricVariants: (metric: string) => void;
  openStateQuery: (state: PulseCurrentState) => void;
  openStateVariants: (key: string) => void;
  openEventQuery: (event: PulseRecordedEvent) => void;
  openEventVariants: (kind: string) => void;
};

const SourceLink = (props: {
  sourceId: string | null | undefined;
  sourceNameById: () => Map<string, string>;
  openSource: (sourceId: string | null | undefined) => void;
}) => {
  const t = usePulseMessages();
  if (!props.sourceId) return <span class="text-xs text-dimmed">-</span>;
  return (
    <button
      type="button"
      class="inline-flex max-w-full items-center gap-1 truncate text-xs font-medium text-secondary transition hover:app-accent-text"
      onClick={(event) => {
        event.stopPropagation();
        props.openSource(props.sourceId);
      }}
      title={t().openSource}
    >
      <i class="ti ti-database-share shrink-0" />
      <span class="truncate">{props.sourceNameById().get(props.sourceId) ?? t().unknownSource}</span>
    </button>
  );
};

const ResourceSourceAction = (props: {
  sourceId: string | null | undefined;
  sourceNameById: () => Map<string, string>;
  openSource: (sourceId: string | null | undefined) => void;
}) => {
  const t = usePulseMessages();
  return (
  <Show when={props.sourceId} fallback={<p class="text-xs text-dimmed">-</p>}>
    {(sourceId) => (
      <DetailPanel.Action
        type="button"
        title={props.sourceNameById().get(sourceId()) ?? t().unknownSource}
        description={t().openSource}
        leading={<i class="ti ti-database-share" aria-hidden="true" />}
        trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
        onClick={() => props.openSource(sourceId())}
      />
    )}
  </Show>
  );
};

type ResourceSignalTab = "metrics" | "states" | "events";

const metricColumns = (t: Messages): DataTableColumn<PulseResourceMetric>[] => [
  { id: "metric", header: t.metric, value: "metric", cellClass: "min-w-72" },
  { id: "current", header: t.current, cellClass: "w-28 whitespace-nowrap" },
  { id: "type", header: t.type, value: "type", cellClass: "w-24 whitespace-nowrap" },
  { id: "unit", header: t.unit, cellClass: "w-24 whitespace-nowrap" },
  { id: "source", header: t.source, cellClass: "w-40 whitespace-nowrap" },
  { id: "dimensions", header: t.dimensions, cellClass: "min-w-64" },
  { id: "lastSeen", header: t.lastSeen, cellClass: "w-44 whitespace-nowrap" },
];

const stateColumns = (t: Messages): DataTableColumn<PulseCurrentState>[] => [
  { id: "key", header: t.state, value: "key", cellClass: "min-w-72" },
  { id: "value", header: t.value, cellClass: "min-w-40" },
  { id: "source", header: t.source, cellClass: "w-40 whitespace-nowrap" },
  { id: "dimensions", header: t.dimensions, cellClass: "min-w-64" },
  { id: "updated", header: t.updated, cellClass: "w-44 whitespace-nowrap" },
];

const eventColumns = (t: Messages): DataTableColumn<PulseRecordedEvent>[] => [
  { id: "kind", header: t.event, value: "kind", cellClass: "min-w-72" },
  { id: "subject", header: t.subject, cellClass: "min-w-56" },
  { id: "source", header: t.source, cellClass: "w-40 whitespace-nowrap" },
  { id: "value", header: t.value, cellClass: "w-24 whitespace-nowrap" },
  { id: "time", header: t.time, cellClass: "w-44 whitespace-nowrap" },
];

const resourceStateId = (state: PulseCurrentState) =>
  `${state.key}:${state.sourceId ?? ""}:${state.entityId}:${JSON.stringify(state.dimensions)}`;

const metricValue = (metric: PulseResourceMetric) =>
  metric.latestValue === null ? "-" : formatMetricValue(metric.latestValue, metric.unit);

const renderDimensions = (dimensions: Record<string, string>): JSX.Element => {
  const summary = dimensionsSummary(dimensions, 8);
  return (
    <span
      class="line-clamp-2 text-xs text-secondary"
      title={Object.entries(dimensions)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}
    >
      {summary || "-"}
    </span>
  );
};

const metricLastSeen = (metric: PulseResourceMetric, dateContext: PulseDateContext): string => {
  if (metric.latestSampleAt) return compactDateWithDelta(metric.latestSampleAt, dateContext);
  return metric.lastSeenAt ? compactDateWithDelta(metric.lastSeenAt, dateContext) : "-";
};

const clearMissingSelection = <Row,>(rows: Row[], selectedId: string, rowId: (row: Row) => string, setSelectedId: (id: string) => void) => {
  if (selectedId && !rows.some((row) => rowId(row) === selectedId)) setSelectedId("");
};

const renderMetricCell = (
  row: PulseResourceMetric,
  col: DataTableColumn<PulseResourceMetric>,
  render: (value: unknown) => JSX.Element,
  props: Pick<ResourceDetailProps, "dateContext" | "sourceNameById" | "openSource">,
): JSX.Element => {
  if (col.id === "current") return <span class="text-xs font-medium text-primary">{metricValue(row)}</span>;
  if (col.id === "unit") return <span class="text-xs text-secondary">{row.unit ?? "-"}</span>;
  if (col.id === "source")
    return <SourceLink sourceId={row.sourceId} sourceNameById={props.sourceNameById} openSource={props.openSource} />;
  if (col.id === "dimensions") return renderDimensions(row.dimensions);
  if (col.id === "lastSeen") return <span class="text-xs text-secondary">{metricLastSeen(row, props.dateContext)}</span>;
  return render(row[col.id as keyof PulseResourceMetric]);
};

const renderStateCell = (
  row: PulseCurrentState,
  col: DataTableColumn<PulseCurrentState>,
  render: (value: unknown) => JSX.Element,
  props: Pick<ResourceDetailProps, "dateContext" | "sourceNameById" | "openSource">,
): JSX.Element => {
  if (col.id === "value") return <span class="line-clamp-2 text-xs text-secondary">{formatSignalValue(row.value)}</span>;
  if (col.id === "source")
    return <SourceLink sourceId={row.sourceId} sourceNameById={props.sourceNameById} openSource={props.openSource} />;
  if (col.id === "dimensions") return renderDimensions(row.dimensions);
  if (col.id === "updated") return <span class="text-xs text-secondary">{compactDateWithDelta(row.updatedAt, props.dateContext)}</span>;
  return render(row[col.id as keyof PulseCurrentState]);
};

const renderEventCell = (
  row: PulseRecordedEvent,
  col: DataTableColumn<PulseRecordedEvent>,
  render: (value: unknown) => JSX.Element,
  props: Pick<ResourceDetailProps, "dateContext" | "sourceNameById" | "openSource">,
): JSX.Element => {
  if (col.id === "subject") return <span class="truncate text-xs text-secondary">{signalSubject(row)}</span>;
  if (col.id === "source")
    return <SourceLink sourceId={row.sourceId} sourceNameById={props.sourceNameById} openSource={props.openSource} />;
  if (col.id === "value") return <span class="text-xs text-secondary">{row.value === null ? "-" : formatValue(row.value)}</span>;
  if (col.id === "time") return <span class="text-xs text-secondary">{compactDateWithDelta(row.ts, props.dateContext)}</span>;
  return render(row[col.id as keyof PulseRecordedEvent]);
};

const ResourceHeader = (props: Pick<ResourceDetailProps, "resource" | "dateContext">) => {
  const t = usePulseMessages();
  return (
  <header class="flex shrink-0 items-center gap-3">
    <span class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 app-accent-text dark:bg-zinc-900">
      <i class="ti ti-cube text-base" />
    </span>
    <div class="min-w-0">
      <p class="text-label text-[11px]">{props.resource.type ?? t().resource}</p>
      <h1 class="mt-0.5 truncate text-lg font-semibold leading-6 text-primary">{props.resource.label || props.resource.id}</h1>
      <p class="mt-0.5 truncate text-xs text-dimmed">
        {props.resource.id}
        {props.resource.lastSeenAt ? ` · ${compactDateWithDelta(props.resource.lastSeenAt, props.dateContext)}` : ""}
      </p>
    </div>
  </header>
  );
};

const ResourceDimensions = (props: Pick<ResourceDetailProps, "resource">) => {
  const t = usePulseMessages();
  return (
  <section class="detail-section shrink-0">
    <StructuredDataPreview title={t().dimensions} data={props.resource.dimensions} empty={t().noDimensions} />
  </section>
  );
};

export type ResourceDetailSelection = {
  activeTab: Accessor<ResourceSignalTab>;
  setActiveTab: (tab: ResourceSignalTab) => void;
  selectedMetric: Accessor<PulseResourceMetric | null>;
  selectedState: Accessor<PulseCurrentState | null>;
  selectedEvent: Accessor<PulseRecordedEvent | null>;
  selectMetric: (metric: PulseResourceMetric) => void;
  selectState: (state: PulseCurrentState) => void;
  selectEvent: (event: PulseRecordedEvent) => void;
  close: () => void;
  open: Accessor<boolean>;
};

export const createResourceDetailSelection = (props: {
  metrics: Accessor<PulseResourceMetric[]>;
  states: Accessor<PulseCurrentState[]>;
  events: Accessor<PulseRecordedEvent[]>;
}): ResourceDetailSelection => {
  const [activeTab, setActiveTab] = createSignal<ResourceSignalTab>("metrics");
  const [selectedMetricId, setSelectedMetricId] = createSignal("");
  const [selectedStateId, setSelectedStateId] = createSignal("");
  const [selectedEventId, setSelectedEventId] = createSignal("");

  createEffect(() => {
    clearMissingSelection(props.metrics(), selectedMetricId(), (metric) => metric.seriesId, setSelectedMetricId);
    clearMissingSelection(props.states(), selectedStateId(), resourceStateId, setSelectedStateId);
    clearMissingSelection(props.events(), selectedEventId(), (event) => event.id, setSelectedEventId);
  });

  const selectedMetric = createMemo(() => props.metrics().find((metric) => metric.seriesId === selectedMetricId()) ?? null);
  const selectedState = createMemo(() => props.states().find((state) => resourceStateId(state) === selectedStateId()) ?? null);
  const selectedEvent = createMemo(() => props.events().find((event) => event.id === selectedEventId()) ?? null);

  const close = () => {
    if (activeTab() === "metrics") setSelectedMetricId("");
    if (activeTab() === "states") setSelectedStateId("");
    if (activeTab() === "events") setSelectedEventId("");
  };

  return {
    activeTab,
    setActiveTab,
    selectedMetric,
    selectedState,
    selectedEvent,
    selectMetric: (metric) => {
      setActiveTab("metrics");
      setSelectedMetricId(metric.seriesId);
    },
    selectState: (state) => {
      setActiveTab("states");
      setSelectedStateId(resourceStateId(state));
    },
    selectEvent: (event) => {
      setActiveTab("events");
      setSelectedEventId(event.id);
    },
    close,
    open: createMemo(() => {
      if (activeTab() === "metrics") return selectedMetric() !== null;
      if (activeTab() === "states") return selectedState() !== null;
      return selectedEvent() !== null;
    }),
  };
};

type ResourceSignalPanesProps = ResourceDetailProps & {
  selection: ResourceDetailSelection;
};

const ResourceSignalTabs = (props: ResourceSignalPanesProps) => {
  const t = usePulseMessages();
  return (
  <section class="h-[min(68vh,54rem)] min-h-[32rem] shrink-0 overflow-hidden">
    <Tabs
      value={props.selection.activeTab}
      onValueChange={props.selection.setActiveTab}
      ariaLabel={t().resourceSignals}
      class="h-full min-h-0 gap-0 [&_.k2b-tabs__list]:shrink-0 [&_.k2b-tabs__panel]:min-h-0 [&_.k2b-tabs__panel]:flex-1 [&_.k2b-tabs__panel]:overflow-hidden"
    >
      <Tabs.Item value="metrics" label={`${t().metrics} ${props.metrics.length}`} icon="ti ti-chart-dots">
        <div class="flex h-full min-h-0 flex-col overflow-hidden">
          <DataTable
            rows={props.metrics}
            columns={metricColumns(t())}
            getRowId={(metric) => metric.seriesId}
            selectedRowId={props.selection.selectedMetric()?.seriesId ?? null}
            density="compact"
            fillHeight
            class="min-h-0 flex-1 overflow-auto"
            empty={t().noMetricsForResource}
            scrollPreserveKey={`pulse-resource-${props.resource.key}-metrics`}
            onRowClick={props.selection.selectMetric}
            renderCell={({ row, col, render }) => renderMetricCell(row, col, render, props)}
          />
        </div>
      </Tabs.Item>

      <Tabs.Item value="states" label={`${t().states} ${props.states.length}`} icon="ti ti-toggle-right">
        <div class="flex h-full min-h-0 flex-col overflow-hidden">
          <DataTable
            rows={props.states}
            columns={stateColumns(t())}
            getRowId={resourceStateId}
            selectedRowId={props.selection.selectedState() ? resourceStateId(props.selection.selectedState()!) : null}
            density="compact"
            fillHeight
            class="min-h-0 flex-1 overflow-auto"
            empty={t().noStatesForResource}
            scrollPreserveKey={`pulse-resource-${props.resource.key}-states`}
            onRowClick={props.selection.selectState}
            renderCell={({ row, col, render }) => renderStateCell(row, col, render, props)}
          />
        </div>
      </Tabs.Item>

      <Tabs.Item value="events" label={`${t().events} ${props.events.length}`} icon="ti ti-bolt">
        <div class="flex h-full min-h-0 flex-col overflow-hidden">
          <DataTable
            rows={props.events}
            columns={eventColumns(t())}
            getRowId={(event) => event.id}
            selectedRowId={props.selection.selectedEvent()?.id ?? null}
            density="compact"
            fillHeight
            class="min-h-0 flex-1 overflow-auto"
            empty={t().noEventsForResource}
            scrollPreserveKey={`pulse-resource-${props.resource.key}-events`}
            onRowClick={props.selection.selectEvent}
            renderCell={({ row, col, render }) => renderEventCell(row, col, render, props)}
          />
        </div>
      </Tabs.Item>
    </Tabs>
  </section>
  );
};

export const ResourceSignalDetail = (props: ResourceSignalPanesProps) => {
  const t = usePulseMessages();
  return (
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <Show when={props.selection.selectedMetric()}>
      {(metric) => (
        <div class={props.selection.activeTab() === "metrics" ? "flex h-full min-h-0 flex-col overflow-hidden" : "hidden"}>
          <DetailPanel>
            <DetailPanel.Header
              title={metric().metric}
              icon="ti ti-chart-dots"
              meta={t().metricValue}
              subtitle={`${metric().type}${metric().unit ? ` · ${metric().unit}` : ""}${
                metric().latestSampleAt ? ` · ${compactDateWithDelta(metric().latestSampleAt!, props.dateContext)}` : ""
              }`}
              actions={
                <Tooltip.Anchor content={t().closeDetails}>
                  <IconButton label={t().closeMetricDetails} variant="ghost" size="sm" onClick={props.selection.close}>
                    <i class="ti ti-x" />
                  </IconButton>
                </Tooltip.Anchor>
              }
              primaryActions={
                <div class="flex flex-wrap items-center gap-2" role="group" aria-label={t().actionsFor({ name: metric().metric })}>
                  <Button type="button" variant="secondary" size="sm" onClick={() => props.openMetricQuery(metric())}>
                    <i class="ti ti-code" /> {t().openQuery}
                  </Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => props.openMetricVariants(metric().metric)}>
                    <i class="ti ti-stack-2" /> {t().allVariants}
                  </Button>
                </div>
              }
            />
            <DetailPanel.Body>
              <DetailPanel.Summary title={t().value}>
                <p class="text-3xl font-semibold text-primary">{metricValue(metric())}</p>
              </DetailPanel.Summary>
              <DetailPanel.Group label={t().signalContext}>
                <DetailPanel.Section title={t().source} icon="ti ti-database-share" tone="accent">
                  <ResourceSourceAction sourceId={metric().sourceId} sourceNameById={props.sourceNameById} openSource={props.openSource} />
                </DetailPanel.Section>
                <DetailPanel.Section title={t().metricDimensions} icon="ti ti-tags" tone="neutral">
                  <StructuredDataPreview data={metric().dimensions} empty={t().noDimensions} />
                </DetailPanel.Section>
              </DetailPanel.Group>
            </DetailPanel.Body>
          </DetailPanel>
        </div>
      )}
    </Show>

    <Show when={props.selection.selectedState()}>
      {(state) => (
        <div class={props.selection.activeTab() === "states" ? "flex h-full min-h-0 flex-col overflow-hidden" : "hidden"}>
          <DetailPanel>
            <DetailPanel.Header
              title={state().key}
              icon="ti ti-toggle-right"
              meta={t().stateValue}
              subtitle={compactDateWithDelta(state().updatedAt, props.dateContext)}
              actions={
                <Tooltip.Anchor content={t().closeDetails}>
                  <IconButton label={t().closeStateDetails} variant="ghost" size="sm" onClick={props.selection.close}>
                    <i class="ti ti-x" />
                  </IconButton>
                </Tooltip.Anchor>
              }
              primaryActions={
                <div class="flex flex-wrap items-center gap-2" role="group" aria-label={t().actionsFor({ name: state().key })}>
                  <Button type="button" variant="secondary" size="sm" onClick={() => props.openStateQuery(state())}>
                    <i class="ti ti-code" /> {t().openQuery}
                  </Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => props.openStateVariants(state().key)}>
                    <i class="ti ti-stack-2" /> {t().allVariants}
                  </Button>
                </div>
              }
            />
            <DetailPanel.Body>
              <DetailPanel.Summary title={t().value}>
                <p class="break-words text-2xl font-semibold text-primary">{formatSignalValue(state().value)}</p>
              </DetailPanel.Summary>
              <DetailPanel.Group label={t().signalContext}>
                <DetailPanel.Section title={t().source} icon="ti ti-database-share" tone="accent">
                  <ResourceSourceAction sourceId={state().sourceId} sourceNameById={props.sourceNameById} openSource={props.openSource} />
                </DetailPanel.Section>
                <DetailPanel.Section title={t().stateDimensions} icon="ti ti-tags" tone="neutral">
                  <StructuredDataPreview data={state().dimensions} empty={t().noDimensions} />
                </DetailPanel.Section>
              </DetailPanel.Group>
            </DetailPanel.Body>
          </DetailPanel>
        </div>
      )}
    </Show>

    <Show when={props.selection.selectedEvent()}>
      {(event) => (
        <div class={props.selection.activeTab() === "events" ? "flex h-full min-h-0 flex-col overflow-hidden" : "hidden"}>
          <DetailPanel>
            <DetailPanel.Header
              title={event().kind}
              icon="ti ti-bolt"
              meta={t().eventRow}
              subtitle={`${signalSubject(event())} · ${compactDateWithDelta(event().ts, props.dateContext)}`}
              actions={
                <Tooltip.Anchor content={t().closeDetails}>
                  <IconButton label={t().closeEventDetails} variant="ghost" size="sm" onClick={props.selection.close}>
                    <i class="ti ti-x" />
                  </IconButton>
                </Tooltip.Anchor>
              }
              primaryActions={
                <div class="flex flex-wrap items-center gap-2" role="group" aria-label={t().actionsFor({ name: event().kind })}>
                  <Button type="button" variant="secondary" size="sm" onClick={() => props.openEventQuery(event())}>
                    <i class="ti ti-code" /> {t().openQuery}
                  </Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => props.openEventVariants(event().kind)}>
                    <i class="ti ti-stack-2" /> {t().allVariants}
                  </Button>
                </div>
              }
            />
            <DetailPanel.Body>
              <DetailPanel.Summary title={t().value}>
                <p class="text-2xl font-semibold text-primary">{event().value === null ? "-" : formatValue(event().value)}</p>
              </DetailPanel.Summary>
              <DetailPanel.Group label={t().signalContext}>
                <DetailPanel.Section title={t().source} icon="ti ti-database-share" tone="accent">
                  <ResourceSourceAction sourceId={event().sourceId} sourceNameById={props.sourceNameById} openSource={props.openSource} />
                </DetailPanel.Section>
                <DetailPanel.Section title={t().eventDimensions} icon="ti ti-tags" tone="neutral">
                  <StructuredDataPreview data={event().dimensions} empty={t().noDimensions} />
                </DetailPanel.Section>
                <DetailPanel.Section title={t().eventPayload} icon="ti ti-braces" tone="neutral">
                  <StructuredDataPreview data={structuredData(event().payload, t().eventPayload)} empty={t().noPayload} />
                </DetailPanel.Section>
              </DetailPanel.Group>
            </DetailPanel.Body>
          </DetailPanel>
        </div>
      )}
    </Show>
  </div>
  );
};

export default function ResourceDetailView(props: ResourceDetailProps & { selection: ResourceDetailSelection }) {
  return (
    <section class="flex min-h-0 flex-1 flex-col gap-2">
      <ResourceHeader resource={props.resource} dateContext={props.dateContext} />
      <ResourceDimensions resource={props.resource} />
      <ResourceSignalTabs {...props} />
    </section>
  );
}
