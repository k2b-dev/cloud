import { Button, CopyButton, DataTable, TextInput, type DataTableColumn } from "@k2b/ui";
import { createMemo, createSignal, For } from "solid-js";
import type {
  PulseCurrentState,
  PulseMetricSeries,
  PulseMetricSummary,
  PulseRecordedEvent,
  PulseSignalField,
  PulseSource,
} from "../contracts";
import {
  buildReferenceEntityChips,
  buildReferenceEventQuery,
  buildReferenceEventRows,
  buildReferenceMetricQuery,
  buildReferenceMetricRows,
  buildReferenceSourceChips,
  buildReferenceStateQuery,
  buildReferenceStateRows,
  type ReferenceEventRow,
  type ReferenceMetricRow,
  type ReferenceScopeChip,
  type ReferenceStateRow,
} from "./query-reference-inventory";
import { usePulseMessages } from "./use-messages";

type Props = {
  metrics: PulseMetricSummary[];
  events: PulseRecordedEvent[];
  states: PulseCurrentState[];
  sources: PulseSource[];
  series: PulseMetricSeries[];
  fields: PulseSignalField[];
};

const copyCell = (value: string) => <CopyButton text={value} class="h-8 w-8 text-dimmed hover:text-primary" />;

const ScopeChipRow = (props: {
  label: string;
  allLabel: string;
  selected: string;
  items: ReferenceScopeChip[];
  onSelect: (id: string) => void;
}) => (
  <div class="flex flex-col gap-2">
    <p class="text-xs font-semibold text-dimmed">{props.label}</p>
    <div class="flex flex-wrap gap-2">
      <Button type="button" variant={!props.selected ? "subtle" : "ghost"} size="xs" onClick={() => props.onSelect("")}>
        <i class="ti ti-asterisk" />
        <span>{props.allLabel}</span>
      </Button>
      <For each={props.items}>
        {(item) => (
          <Button
            type="button"
            variant={props.selected === item.id ? "subtle" : "ghost"}
            size="xs"
            class="max-w-full"
            title={`${item.hint} · ${item.count}`}
            onClick={() => props.onSelect(item.id)}
          >
            <i class={item.icon} />
            <span class="truncate">{item.label}</span>
            <span class="text-dimmed">· {item.count}</span>
          </Button>
        )}
      </For>
    </div>
  </div>
);

export function PulseQueryReferenceInventory(props: Props) {
  const t = usePulseMessages();
  const [metricQuery, setMetricQuery] = createSignal("");
  const [eventQuery, setEventQuery] = createSignal("");
  const [stateQuery, setStateQuery] = createSignal("");
  const [fieldQuery, setFieldQuery] = createSignal("");
  const [selectedSourceId, setSelectedSourceId] = createSignal("");
  const [selectedEntityId, setSelectedEntityId] = createSignal("");

  const sourcesById = createMemo(() => new Map(props.sources.map((source) => [source.id, source])));
  const filters = createMemo(() => ({ sourceId: selectedSourceId(), entityId: selectedEntityId() }));
  const sourceChips = createMemo(() => buildReferenceSourceChips(props));
  const entityChips = createMemo(() => buildReferenceEntityChips(props));
  const selectedEntityType = createMemo(() => {
    const entity = entityChips().find((item) => item.id === selectedEntityId());
    return entity?.hint && entity.hint !== "entity" ? entity.hint : null;
  });

  const metricRows = createMemo(() =>
    buildReferenceMetricRows({
      metrics: props.metrics,
      series: props.series,
      sourcesById: sourcesById(),
      filters: filters(),
      query: metricQuery(),
    }),
  );

  const eventRows = createMemo(() =>
    buildReferenceEventRows({ events: props.events, sourcesById: sourcesById(), filters: filters(), query: eventQuery() }),
  );

  const stateRows = createMemo(() =>
    buildReferenceStateRows({ states: props.states, sourcesById: sourcesById(), filters: filters(), query: stateQuery() }),
  );

  const fieldRows = createMemo(() => {
    const q = fieldQuery().trim().toLowerCase();
    return props.fields.filter((field) => {
      if (selectedSourceId() && field.sourceId !== selectedSourceId()) return false;
      return !q || `${field.signalName} ${field.key} ${field.scope} ${field.role} ${field.valueType}`.toLowerCase().includes(q);
    });
  });

  const metricColumns: DataTableColumn<ReferenceMetricRow>[] = [
    { id: "name", header: t().metric, value: "name" },
    { id: "type", header: t().type, value: "type", headerClass: "w-28", cellClass: "w-28 whitespace-nowrap" },
    {
      id: "series",
      header: t().series,
      value: (row) => (selectedSourceId() || selectedEntityId() ? row.visibleSeriesCount : row.seriesCount),
      headerClass: "w-24",
      cellClass: "w-24 whitespace-nowrap",
    },
    { id: "copy", header: "", value: (row) => buildReferenceMetricQuery(row, filters()), headerClass: "w-12", cellClass: "w-12" },
  ];

  const eventColumns: DataTableColumn<ReferenceEventRow>[] = [
    { id: "kind", header: t().event, value: "kind" },
    { id: "count", header: t().recent, value: "count", headerClass: "w-24", cellClass: "w-24 whitespace-nowrap" },
    {
      id: "copy",
      header: "",
      value: (row) => buildReferenceEventQuery(row, filters(), selectedEntityType()),
      headerClass: "w-12",
      cellClass: "w-12",
    },
  ];

  const stateColumns: DataTableColumn<ReferenceStateRow>[] = [
    { id: "key", header: t().state, value: "key" },
    { id: "count", header: t().entities, value: "count", headerClass: "w-24", cellClass: "w-24 whitespace-nowrap" },
    {
      id: "copy",
      header: "",
      value: (row) => buildReferenceStateQuery(row, filters(), selectedEntityType()),
      headerClass: "w-12",
      cellClass: "w-12",
    },
  ];

  const fieldColumns: DataTableColumn<PulseSignalField>[] = [
    { id: "scope", header: t().scope, value: "scope", headerClass: "w-24", cellClass: "w-24 whitespace-nowrap" },
    { id: "signal", header: t().signal, value: "signalName" },
    { id: "role", header: t().role, value: "role", headerClass: "w-28", cellClass: "w-28 whitespace-nowrap" },
    { id: "field", header: t().field, value: "key" },
    { id: "type", header: t().type, value: "valueType", headerClass: "w-24", cellClass: "w-24 whitespace-nowrap" },
    {
      id: "source",
      header: t().source,
      value: (row) => sourcesById().get(row.sourceId)?.name ?? row.sourceId.slice(0, 8),
      headerClass: "w-36",
      cellClass: "w-36 whitespace-nowrap",
    },
    {
      id: "observed",
      header: t().observed,
      value: "observedCount",
      headerClass: "w-28",
      cellClass: "w-28 whitespace-nowrap",
    },
  ];

  return (
    <>
      <section class="paper flex flex-col gap-4 p-4">
        <div>
          <h2 class="text-base font-semibold text-primary">{t().inventory}</h2>
          <p class="text-sm text-dimmed">{t().inventoryDescription}</p>
        </div>
      </section>
      <section class="paper flex flex-col gap-4 p-4">
        <ScopeChipRow
          label={t().sources}
          allLabel={t().allSources}
          selected={selectedSourceId()}
          items={sourceChips()}
          onSelect={setSelectedSourceId}
        />
        <ScopeChipRow
          label={t().entities}
          allLabel={t().allEntities}
          selected={selectedEntityId()}
          items={entityChips()}
          onSelect={setSelectedEntityId}
        />
      </section>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section class="flex min-h-0 flex-col gap-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 class="flex items-center gap-2 text-sm font-semibold text-secondary">
              <i class="ti ti-chart-dots" /> {t().metrics} <span class="text-dimmed">{metricRows().length}</span>
            </h2>
            <div class="w-full sm:w-64">
              <TextInput value={metricQuery} onValueChange={setMetricQuery} icon="ti ti-search" placeholder={t().searchMetricsPlaceholder} clearable />
            </div>
          </div>
          <DataTable
            rows={metricRows()}
            columns={metricColumns}
            getRowId={(row) => row.name}
            class="paper max-h-[420px] min-h-64 overflow-auto"
            empty={t().noMatchingMetrics}
            renderCell={({ row, col, value }) => {
              if (col.id === "name") return <code class="font-mono text-secondary">{row.name}</code>;
              if (col.id === "copy") return copyCell(String(value));
              return <span class="text-dimmed">{String(value ?? "-")}</span>;
            }}
          />
        </section>

        <section class="flex min-h-0 flex-col gap-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 class="flex items-center gap-2 text-sm font-semibold text-secondary">
              <i class="ti ti-bolt" /> {t().events} <span class="text-dimmed">{eventRows().length}</span>
            </h2>
            <div class="w-full sm:w-64">
              <TextInput value={eventQuery} onValueChange={setEventQuery} icon="ti ti-search" placeholder={t().searchEventsPlaceholder} clearable />
            </div>
          </div>
          <DataTable
            rows={eventRows()}
            columns={eventColumns}
            getRowId={(row) => row.kind}
            class="paper max-h-[420px] min-h-64 overflow-auto"
            empty={t().noMatchingEvents}
            renderCell={({ row, col, value }) => {
              if (col.id === "kind") return <code class="font-mono text-secondary">{row.kind}</code>;
              if (col.id === "copy") return copyCell(String(value));
              return <span class="text-dimmed">{String(value ?? "-")}</span>;
            }}
          />
        </section>

        <section class="flex min-h-0 flex-col gap-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 class="flex items-center gap-2 text-sm font-semibold text-secondary">
              <i class="ti ti-toggle-right" /> {t().states} <span class="text-dimmed">{stateRows().length}</span>
            </h2>
            <div class="w-full sm:w-64">
              <TextInput value={stateQuery} onValueChange={setStateQuery} icon="ti ti-search" placeholder={t().searchStatesPlaceholder} clearable />
            </div>
          </div>
          <DataTable
            rows={stateRows()}
            columns={stateColumns}
            getRowId={(row) => row.key}
            class="paper max-h-[420px] min-h-64 overflow-auto"
            empty={t().noMatchingStates}
            renderCell={({ row, col, value }) => {
              if (col.id === "key") return <code class="font-mono text-secondary">{row.key}</code>;
              if (col.id === "copy") return copyCell(String(value));
              return <span class="text-dimmed">{String(value ?? "-")}</span>;
            }}
          />
        </section>
      </div>

      <section class="flex min-h-0 flex-col gap-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="flex items-center gap-2 text-sm font-semibold text-secondary">
              <i class="ti ti-list-details" /> {t().fields} <span class="text-dimmed">{fieldRows().length}</span>
            </h2>
            <p class="mt-1 text-xs text-dimmed">
              {t().fieldsDescription}
            </p>
          </div>
          <div class="w-full sm:w-72">
            <TextInput value={fieldQuery} onValueChange={setFieldQuery} icon="ti ti-search" placeholder={t().searchFieldsPlaceholder} clearable />
          </div>
        </div>
        <DataTable
          rows={fieldRows()}
          columns={fieldColumns}
          getRowId={(row) => `${row.sourceId}:${row.scope}:${row.signalName}:${row.role}:${row.key}`}
          class="paper max-h-[420px] min-h-64 overflow-auto"
          empty={t().noMatchingFields}
          renderCell={({ col, value }) => {
            if (col.id === "signal" || col.id === "field") return <code class="font-mono text-secondary">{String(value)}</code>;
            return <span class="text-dimmed">{String(value ?? "-")}</span>;
          }}
        />
      </section>
    </>
  );
}
