import { dates } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { DataTable, type DataTableColumn, Dropdown, Placeholder, Skeleton } from "@k2b/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import type { BaseSchemaRead, SchemaField } from "../../schema-contracts";
import { jsonFetch } from "../http";
import { usePulseMessages } from "../use-messages";
import type { PulseDateContext } from "./helpers";
import { absoluteTime, ago } from "./SourcesTab";

type Kind = { group: "events" | "metrics" | "states"; name: string };
type FieldRow = { key: string; type: string; example: string; filled: string };
type SampleRow = { id: string; cells: string[] };

const text = (value: unknown): string =>
  value === undefined || value === null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);

/** Every kind of the overview in list order: events, metrics, states. */
export const schemaKinds = (schema: BaseSchemaRead): Kind[] => [
  ...schema.events.items.map((item) => ({ group: "events" as const, name: item.kind })),
  ...schema.metrics.items.map((item) => ({ group: "metrics" as const, name: item.name })),
  ...schema.states.items.map((item) => ({ group: "states" as const, name: item.key })),
];

/**
 * The Data tab: the kinds of a base in a docked list and, beside it, the fields of one kind with type, example and
 * fill rate plus its newest entries. Pulse never reads confidential event data here, so no field of it shows.
 */
export default function DataTab(props: {
  baseId: string;
  initialKind?: string;
  dateContext: PulseDateContext;
  href: (kind: string) => string;
}) {
  const t = usePulseMessages();
  const overview = query.create({
    source: () => props.baseId,
    load: (baseId, { abortSignal }) => jsonFetch<BaseSchemaRead>(`/api/pulse/bases/${baseId}/schema`, { signal: abortSignal }),
  });
  const [picked, setPicked] = createSignal(props.initialKind ?? "");
  const kinds = () => (overview.data() ? schemaKinds(overview.data()!) : []);
  const selected = (): Kind | undefined => kinds().find((kind) => kind.name === picked()) ?? kinds()[0];
  const detail = query.create({
    enabled: () => Boolean(selected()),
    source: () => ({ baseId: props.baseId, kind: selected()?.name ?? "" }),
    isSameSource: (a, b) => a.baseId === b.baseId && a.kind === b.kind,
    load: ({ baseId, kind }, { abortSignal }) =>
      jsonFetch<BaseSchemaRead>(`/api/pulse/bases/${baseId}/schema?kind=${encodeURIComponent(kind)}`, { signal: abortSignal }),
  });
  /** Entries are seconds apart: the sample shows the time with seconds, in the base's zone. */
  const sampleTime = (value: string) => dates.instantToZonedInput(value, props.dateContext.timeZone ?? "UTC").slice(11, 19);
  const choose = (name: string) => {
    setPicked(name);
    // The open kind lives in the URL, so reload and back return to it; the list keeps its place.
    history.replaceState(history.state, "", props.href(name));
  };
  const typeLabel = (type: string) =>
    ({
      string: t().dataTypeString,
      number: t().dataTypeNumber,
      boolean: t().dataTypeBoolean,
      object: t().dataTypeObject,
      array: t().dataTypeArray,
      null: t().dataTypeNull,
      gauge: t().dataTypeGauge,
      counter: t().dataTypeCounter,
    })[type] ?? type;
  const kindMeta = (kind: Kind, schema: BaseSchemaRead): string => {
    if (kind.group === "events") {
      const item = schema.events.items.find((event) => event.kind === kind.name);
      return [t().dataKindEvent, item ? t().dataLastSeen({ ago: ago(item.lastSeenAt, props.dateContext) }) : null]
        .filter(Boolean)
        .join(" · ");
    }
    if (kind.group === "metrics") {
      const item = schema.metrics.items.find((metric) => metric.name === kind.name);
      return [
        t().dataKindMetric,
        item ? typeLabel(item.type) : null,
        item ? t().dataSeries({ count: item.seriesCount }) : null,
        item?.lastSampleAt ? t().dataLastSeen({ ago: ago(item.lastSampleAt, props.dateContext) }) : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    const item = schema.states.items.find((state) => state.key === kind.name);
    return [t().dataKindState, item ? t().dataVariants({ count: item.variantCount }) : null].filter(Boolean).join(" · ");
  };
  const trailing = (kind: Kind, schema: BaseSchemaRead): string => {
    if (kind.group === "metrics") return typeLabel(schema.metrics.items.find((metric) => metric.name === kind.name)?.type ?? "");
    if (kind.group === "states") return String(schema.states.items.find((state) => state.key === kind.name)?.variantCount ?? "");
    const event = schema.events.items.find((item) => item.kind === kind.name);
    return event ? ago(event.lastSeenAt, props.dateContext) : "";
  };
  /** Fields and newest entries of the open kind; the detail read carries the samples, the overview the fields. */
  const content = (): { fields: FieldRow[]; columns: string[]; samples: SampleRow[] | null } | null => {
    const kind = selected();
    const schema = overview.data();
    if (!kind || !schema) return null;
    const read = detail.data()?.kind === kind.name ? detail.data() : undefined;
    if (kind.group === "events") {
      const item =
        read?.events.items.find((event) => event.kind === kind.name) ?? schema.events.items.find((event) => event.kind === kind.name);
      const fields: SchemaField[] = item?.fields ?? [];
      const samples = item?.samples ?? null;
      const shown = fields.slice(0, 3).map((field) => field.key);
      return {
        fields: fields.map((field) => ({
          key: field.key,
          type: typeLabel(field.type),
          example: text(samples?.find((sample) => sample.attributes?.[field.key] !== undefined)?.attributes?.[field.key]),
          filled: `${Math.round(field.fillRate * 100)} %`,
        })),
        columns: ["ts", ...shown],
        samples:
          samples?.map((sample) => ({
            id: sample.id,
            cells: [sampleTime(sample.ts), ...shown.map((key) => text(sample.attributes?.[key]))],
          })) ?? null,
      };
    }
    if (kind.group === "metrics") {
      const item =
        read?.metrics.items.find((metric) => metric.name === kind.name) ?? schema.metrics.items.find((metric) => metric.name === kind.name);
      const samples = item?.samples ?? null;
      const shown = (item?.dimensions ?? []).slice(0, 2).map((dimension) => dimension.key);
      return {
        fields: [
          { key: "value", type: typeLabel("number"), example: text(samples?.[0]?.value), filled: "100 %" },
          ...(item?.dimensions ?? []).map((dimension) => ({
            key: dimension.key,
            type: t().dataDimension,
            example: text(samples?.find((sample) => sample.dimensions?.[dimension.key] !== undefined)?.dimensions?.[dimension.key]),
            filled: t().dataValues({ count: dimension.values }),
          })),
        ],
        columns: ["ts", "value", ...shown],
        samples:
          samples?.map((sample, index) => ({
            id: `${sample.ts}-${index}`,
            cells: [sampleTime(sample.ts), text(sample.value), ...shown.map((key) => text(sample.dimensions?.[key]))],
          })) ?? null,
      };
    }
    const item =
      read?.states.items.find((state) => state.key === kind.name) ?? schema.states.items.find((state) => state.key === kind.name);
    const samples = item?.samples ?? null;
    return {
      fields: [
        {
          key: "value",
          type: typeLabel(typeof samples?.[0]?.value === "number" ? "number" : "string"),
          example: text(samples?.[0]?.value),
          filled: "100 %",
        },
      ],
      columns: ["variant", "value", "ts"],
      samples:
        samples?.map((sample) => ({
          id: sample.variantKey,
          cells: [sample.variantKey || "—", text(sample.value), absoluteTime(sample.updatedAt, props.dateContext)],
        })) ?? null,
    };
  };
  const fieldColumns = (): DataTableColumn<FieldRow>[] => [
    { id: "key", header: t().dataField, value: "key", primary: true, list: "title", cellClass: "pulse-mono" },
    { id: "type", header: t().dataType, value: "type", list: "end", nowrap: true },
    { id: "example", header: t().dataExample, value: "example", list: "meta", cellClass: "pulse-mono", priority: 2 },
    { id: "filled", header: t().dataFilled, value: "filled", align: "right", nowrap: true, priority: 3 },
  ];
  const sampleColumns = (names: string[]): DataTableColumn<SampleRow>[] =>
    names.map((name, index) => ({
      id: String(index),
      header: <span class="pulse-mono">{name}</span>,
      value: (row: SampleRow) => row.cells[index],
      align: "left",
      nowrap: true,
      cellClass: "pulse-mono",
      priority: index > 2 ? 3 : 1,
    }));
  const group = (name: Kind["group"], title: string, schema: BaseSchemaRead): JSX.Element => {
    const items = () => kinds().filter((kind) => kind.group === name);
    return (
      <div class="pulse-kinds__group">
        <h3 class="pulse-kinds__title">{title}</h3>
        <Show when={items().length} fallback={<p class="pulse-kinds__none">{t().dataNone}</p>}>
          <ul class="pulse-kinds__list">
            <For each={items()}>
              {(kind) => (
                <li>
                  <button
                    type="button"
                    class="pulse-kinds__item"
                    aria-current={selected()?.name === kind.name ? "true" : undefined}
                    onClick={() => choose(kind.name)}
                  >
                    <span class="pulse-kinds__name">{kind.name}</span>
                    <span class="pulse-kinds__trailing">{trailing(kind, schema)}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    );
  };
  return (
    <section class="pulse-tab pulse-tab--data" aria-label={t().tabData}>
      <Show
        when={!overview.error()}
        fallback={
          <Placeholder
            state="error"
            title={t().dataLoadFailed}
            description={overview.error()?.message}
            onRetry={() => void overview.refresh()}
          />
        }
      >
        <Show
          when={overview.data()}
          fallback={
            <div class="pulse-data k2b-divided-inline" aria-busy="true">
              <div class="pulse-kinds">
                <Skeleton class="pulse-skeleton-line" />
                <Skeleton class="pulse-skeleton-line" />
                <Skeleton class="pulse-skeleton-line" />
              </div>
              <div class="pulse-kind">
                <DataTable rows={[]} columns={fieldColumns()} loading loadingRows={5} getRowId={(row) => row.key} ariaLabel={t().tabData} />
              </div>
              <span class="sr-only" role="status">
                {t().overviewLoading}
              </span>
            </div>
          }
        >
          {(schema) => (
            <Show
              when={kinds().length}
              fallback={<Placeholder icon="ti ti-database" title={t().dataEmptyTitle} description={t().dataEmptyDetail} />}
            >
              <div class="pulse-data k2b-divided-inline">
                <nav class="pulse-kinds" aria-label={t().dataChooseKind}>
                  {group("events", t().dataEvents, schema())}
                  {group("metrics", t().dataMetrics, schema())}
                  {group("states", t().dataStates, schema())}
                  <Show when={schema().truncated}>
                    <p class="pulse-kinds__none">{t().dataTruncated}</p>
                  </Show>
                </nav>
                <div class="pulse-kind">
                  <div class="pulse-kind__phone-pick">
                    <Dropdown.Root
                      label={t().dataChooseKind}
                      phone="sheet"
                      items={kinds().map((kind) => ({
                        label: kind.name,
                        description: kindMeta(kind, schema()),
                        action: () => choose(kind.name),
                      }))}
                    >
                      <Dropdown.Trigger variant="secondary" class="pulse-kind__phone-trigger">
                        <span class="pulse-mono">{selected()?.name}</span>
                        <i class="ti ti-chevron-down" aria-hidden="true" />
                      </Dropdown.Trigger>
                    </Dropdown.Root>
                  </div>
                  <Show when={selected()}>
                    {(kind) => (
                      <>
                        <h2 class="pulse-kind__head">
                          <span class="pulse-kind__name">{kind().name}</span>
                          <span class="pulse-kind__meta">{kindMeta(kind(), schema())}</span>
                        </h2>
                        <Show when={content()}>
                          {(value) => (
                            <>
                              <DataTable
                                rows={value().fields}
                                columns={fieldColumns()}
                                getRowId={(row) => row.key}
                                ariaLabel={t().dataField}
                                empty={t().dataNoFields}
                              />
                              <h3 class="pulse-kind__sub">
                                {t().dataSample}
                                <span class="pulse-kind__meta"> · {t().dataSampleMeta}</span>
                              </h3>
                              <Show
                                when={!detail.error()}
                                fallback={
                                  <Placeholder
                                    state="error"
                                    title={t().dataLoadFailed}
                                    description={detail.error()?.message}
                                    onRetry={() => void detail.refresh()}
                                  />
                                }
                              >
                                <DataTable
                                  rows={value().samples ?? []}
                                  loading={value().samples === null && detail.loading()}
                                  loadingRows={5}
                                  columns={sampleColumns(value().columns)}
                                  getRowId={(row) => row.id}
                                  ariaLabel={t().dataSample}
                                  empty={t().dataSampleEmpty}
                                />
                              </Show>
                            </>
                          )}
                        </Show>
                      </>
                    )}
                  </Show>
                </div>
              </div>
            </Show>
          )}
        </Show>
      </Show>
    </section>
  );
}
