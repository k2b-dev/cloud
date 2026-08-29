import { type DateContext, dates } from "@k2b/stdlib";
import { mutation, timed } from "@k2b/stdlib/solid";
import { IconButton, Placeholder, TextInput, Tooltip, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { PublicField as Field, PublicGridRecord as GridRecord, PublicTableQueryResult } from "../../../api/public-dto";
import type { AggregationSpec, FilterTree, GroupBySpec, RecordQuery } from "../../../contracts";
import { fetchTableQuery } from "../records-view/fetcher";
import { formatFieldValueText } from "./field-value-format";
import type { GroupBucket } from "./GroupedTable";
import { formatAggregationValue, formatGroupValue } from "./group-value-format";
import { tableMessages } from "./messages";

const PAGE_SIZE = 30;

type Props = {
  tableId: string;
  fields: Field[];
  query: RecordQuery;
  groupBy: GroupBySpec[];
  aggregations: AggregationSpec[];
  bucket: GroupBucket;
  relationLabels: Record<string, string>;
  onClose: () => void;
  onOpenRecord: (record: GridRecord) => void;
  dateConfig?: DateContext;
};

type FetchVars = {
  reset: boolean;
  cursor: string | null;
  q: string;
};
type FilterLeaf = {
  fieldId: string;
  op: string;
  value?: unknown;
};

export default function GroupDetailPanel(props: Props) {
  const locale = useLocale();
  const t = () => tableMessages.resolve([locale()]).t;
  const [q, setQ] = createSignal("");
  const [items, setItems] = createSignal<GridRecord[]>([]);
  const [nextCursor, setNextCursor] = createSignal<string | null>(null);
  let sentinel: HTMLDivElement | undefined;

  const fieldsById = () => new Map(props.fields.map((f) => [f.id, f]));
  const presentableFields = () => {
    const presentable = props.fields.filter((f) => !f.deletedAt && f.presentable).sort((a, b) => a.position - b.position);
    if (presentable.length > 0) return presentable;
    return props.fields
      .filter((f) => !f.deletedAt && !f.hideInTable)
      .sort((a, b) => a.position - b.position)
      .slice(0, 3);
  };

  const bucketKey = createMemo(() => JSON.stringify(props.bucket.keys));

  const fetchMut = mutation.create<PublicTableQueryResult, FetchVars, { reset: boolean }>({
    onBefore: (vars) => ({ reset: vars.reset }),
    mutation: async (vars, { abortSignal }) => {
      const query = buildMemberQuery({
        baseQuery: props.query,
        fields: props.fields,
        groupBy: props.groupBy,
        keys: props.bucket.keys,
        q: vars.q,
        dateConfig: props.dateConfig,
      });
      return fetchTableQuery({ tableId: props.tableId, query, cursor: vars.cursor }, { signal: abortSignal });
    },
    onSuccess: (data, ctx) => {
      const nextItems = data.items ?? [];
      setItems((prev) => (ctx?.reset ? nextItems : [...prev, ...nextItems]));
      setNextCursor(data.nextCursor ?? null);
    },
  });

  const loadFirst = (nextQ = q()) => {
    fetchMut.abort();
    setNextCursor(null);
    void fetchMut.mutate({ reset: true, cursor: null, q: nextQ.trim() });
  };
  const loadMore = () => {
    if (fetchMut.loading() || !nextCursor()) return;
    void fetchMut.mutate({ reset: false, cursor: nextCursor(), q: q().trim() });
  };

  const searchDebounce = timed.debounce((next: string) => loadFirst(next), 250);

  createEffect(() => {
    bucketKey();
    setQ("");
    setItems([]);
    loadFirst("");
  });

  createEffect(() => {
    if (!sentinel || !nextCursor()) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    });
    observer.observe(sentinel);
    onCleanup(() => observer.disconnect());
  });

  const aggSpecsWithCount = () => {
    const explicit = props.aggregations;
    const hasStarCount = explicit.some((a) => a.fieldId === "*" && a.agg === "count");
    return hasStarCount ? explicit : [{ fieldId: "*", agg: "count" } as AggregationSpec, ...explicit];
  };

  const aggLabel = (agg: AggregationSpec) => {
    if (agg.label?.trim()) return agg.label;
    const fallback =
      {
        count: t().records,
        countEmpty: t().empty,
        countUnique: t().unique,
        sum: t().sum,
        avg: t().average,
        min: t().minimum,
        max: t().maximum,
        median: t().median,
        earliest: t().earliest,
        latest: t().latest,
      }[agg.agg] ?? agg.agg;
    if (agg.fieldId === "*") return fallback;
    const field = fieldsById().get(agg.fieldId);
    return `${fallback} ${field?.name ?? t().missingField}`;
  };

  const groupLabel = (spec: GroupBySpec, index: number) => {
    const field = fieldsById().get(spec.fieldId);
    const name = field ? field.name : t().missingField;
    return spec.granularity ? `${name} (${spec.granularity})` : name;
  };
  const groupIcon = (spec: GroupBySpec) => {
    const field = fieldsById().get(spec.fieldId);
    return field?.type === "relation" ? "ti ti-hierarchy" : "ti ti-list-tree";
  };
  const groupValue = (spec: GroupBySpec, index: number) => {
    const field = fieldsById().get(spec.fieldId);
    const raw = props.bucket.keys[index];
    return formatGroupValue({
      value: raw,
      spec,
      field,
      relationLabels: props.relationLabels,
      dateConfig: props.dateConfig,
      locale: locale(),
    });
  };
  const groupTitle = () => props.groupBy.map((spec, index) => groupValue(spec, index)).join(" · ") || t().ungroupedRecords;

  const renderRecordLine = (record: GridRecord) => {
    const fields = presentableFields();
    if (fields.length === 0) return t().untitledRecord;
    return (
      fields
        .map((field) => renderRecordValue(record, field))
        .filter((part) => part.length > 0)
        .join(" · ") || t().untitledRecord
    );
  };

  onCleanup(() => {
    searchDebounce.cancel();
    fetchMut.abort();
  });

  return (
    <div class="flex h-full min-h-0 flex-col">
      <header class="detail-header">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-semibold text-secondary">{t().groupDetails}</span>
          <Tooltip.Anchor content={t().closeDetails}>
            <IconButton variant="ghost" size="sm" type="button" label={t().closeGroupPanel} onClick={() => props.onClose()}>
              <i class="ti ti-x" />
            </IconButton>
          </Tooltip.Anchor>
        </div>

        <div class="mt-4 flex flex-col items-center text-center">
          <span class="app-accent-text flex h-12 w-12 items-center justify-center rounded-[var(--ui-radius-surface)] bg-[var(--ui-selected)]">
            <i class="ti ti-folders text-xl" />
          </span>
          <h2 class="mt-2 line-clamp-2 max-w-full break-words text-lg font-semibold leading-tight text-primary" title={groupTitle()}>
            {groupTitle()}
          </h2>
          <div class="mt-2 flex flex-wrap justify-center gap-1.5">
            <For each={props.groupBy}>
              {(spec, index) => (
                <span class="inline-flex min-w-0 items-center gap-1 rounded-md bg-[var(--ui-surface-subtle)] px-2 py-1 text-xs text-secondary">
                  <i class={`${groupIcon(spec)} shrink-0`} />
                  <span class="font-medium">{groupLabel(spec, index())}</span>
                  <span class="min-w-0 truncate">{groupValue(spec, index())}</span>
                </span>
              )}
            </For>
          </div>
        </div>
      </header>

      <div class="detail-stack" data-scroll-preserve={`grids-group-detail-${props.tableId}-${bucketKey()}`}>
        <section class="detail-section">
          <h3 class="detail-section-label">{t().summary}</h3>
          <div class="grid grid-cols-2 gap-x-4 gap-y-3">
            <For each={aggSpecsWithCount()}>
              {(agg) => (
                <div class="min-w-0">
                  <div class="flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-dimmed">
                    <i class="ti ti-math-function shrink-0" />
                    <span class="truncate">{aggLabel(agg)}</span>
                  </div>
                  <div class="mt-1 min-w-0 break-words text-right text-base font-semibold leading-5 tabular-nums text-primary">
                    {formatAggregationValue({
                      value: props.bucket.values[`${agg.fieldId}__${agg.agg}`],
                      spec: agg,
                      field: agg.fieldId === "*" ? undefined : fieldsById().get(agg.fieldId),
                      dateConfig: props.dateConfig,
                      locale: locale(),
                    })}
                  </div>
                </div>
              )}
            </For>
          </div>
        </section>

        <section class="detail-section flex min-h-[18rem] flex-col gap-3">
          <h3 class="detail-section-label mb-0">{t().records}</h3>
          <TextInput
            aria-label={t().searchGroupRecords}
            icon="ti ti-search"
            placeholder={t().searchGroupPlaceholder}
            value={q}
            onValueChange={(next) => {
              setQ(next);
              searchDebounce.debouncedFn(next);
            }}
            clearable
            onClear={() => {
              setQ("");
              loadFirst("");
            }}
          />

          <div class="flex min-h-0 flex-1 flex-col gap-1">
            <Show
              when={items().length > 0}
              fallback={
                <Placeholder
                  state={fetchMut.error() ? "error" : fetchMut.loading() ? "loading" : "empty"}
                  align="left"
                  class="py-3"
                  title={fetchMut.error() ? t().loadRecordsFailed : fetchMut.loading() ? t().loadingRecords : t().noRecordsGroup}
                  description={fetchMut.error()?.message}
                />
              }
            >
              <For each={items()}>
                {(record) => (
                  <button
                    type="button"
                    class="group flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-[var(--ui-hover)]"
                    onClick={() => props.onOpenRecord(record)}
                  >
                    <i class="ti ti-row-insert-bottom shrink-0 text-dimmed" />
                    <span class="min-w-0 flex-1 truncate text-primary">{renderRecordLine(record)}</span>
                    <i class="ti ti-chevron-right shrink-0 text-dimmed transition-colors group-hover:text-primary" />
                  </button>
                )}
              </For>
            </Show>
            <div ref={sentinel} class="h-1" />
            <Show when={fetchMut.loading() && items().length > 0}>
              <div class="py-2 text-center text-xs text-dimmed">{t().loadingMore}</div>
            </Show>
          </div>
        </section>
      </div>
    </div>
  );

  function renderRecordValue(record: GridRecord, field: Field): string {
    const value = record.data[field.id];
    return formatFieldValueText({
      field,
      value,
      record,
      relationLabels: props.relationLabels,
      dateConfig: props.dateConfig,
      locale: locale(),
    });
  }
}

const buildMemberQuery = (params: {
  baseQuery: RecordQuery;
  fields: Field[];
  groupBy: GroupBySpec[];
  keys: unknown[];
  q: string;
  dateConfig?: DateContext;
}): RecordQuery => {
  const leaves = params.groupBy
    .map((spec, index) => groupFilterLeaf(spec, params.keys[index], params.fields, params.dateConfig))
    .filter((leaf): leaf is FilterLeaf => !!leaf);
  const filter = mergeFilters(params.baseQuery.filter, leaves);
  const q = params.q.trim();
  return {
    filter,
    search: q ? { q, fieldIds: [] } : params.baseQuery.search,
    sort: params.baseQuery.sort,
    includeDeleted: params.baseQuery.includeDeleted,
    deletedOnly: params.baseQuery.deletedOnly,
    limit: PAGE_SIZE,
  };
};

const mergeFilters = (base: FilterTree | undefined, leaves: FilterTree[]): FilterTree | undefined => {
  if (!base && leaves.length === 0) return undefined;
  if (!base && leaves.length === 1) return leaves[0];
  return { op: "AND", filters: [base, ...leaves].filter(Boolean) as FilterTree[] };
};

const groupFilterLeaf = (spec: GroupBySpec, key: unknown, fields: Field[], dateConfig?: DateContext): FilterLeaf | null => {
  const field = fields.find((f) => f.id === spec.fieldId);
  if (!field) return null;
  if (key === null || key === undefined || key === "") {
    return { fieldId: field.id, op: "isEmpty" };
  }
  switch (field.type) {
    case "relation":
      return { fieldId: field.id, op: "containsAny", value: [String(key)] };
    case "select":
      return { fieldId: field.id, op: "is", value: String(key) };
    case "boolean":
      return {
        fieldId: field.id,
        op: "=",
        value: typeof key === "boolean" ? key : String(key).toLowerCase() === "true",
      };
    case "number":
    case "percent":
    case "duration":
      return Number.isFinite(Number(key)) ? { fieldId: field.id, op: "=", value: Number(key) } : null;
    case "date":
      return dateGroupFilter(field.id, key, spec.granularity, Boolean((field.config as { includeTime?: boolean }).includeTime), dateConfig);
    default:
      return { fieldId: field.id, op: "equals", value: String(key) };
  }
};

const zonedBoundary = (localDateTime: string, dateConfig?: DateContext): string => {
  const utcFallback = () => new Date(`${localDateTime}Z`).toISOString();
  if (!dateConfig?.timeZone) return utcFallback();
  try {
    return dates.zonedDateTimeToInstant(localDateTime, dateConfig.timeZone, { disambiguation: "compatible" });
  } catch {
    return utcFallback();
  }
};

const dateGroupFilter = (
  fieldId: string,
  key: unknown,
  granularity?: GroupBySpec["granularity"],
  includeTime = false,
  dateConfig?: DateContext,
): FilterLeaf => {
  const startDate = String(key).slice(0, 10);
  const [y, m, d] = startDate.split("-").map(Number);
  if (!y || !m || !d) return { fieldId, op: "=", value: startDate };
  if (!granularity) return { fieldId, op: "=", value: includeTime ? String(key) : startDate };

  const end = new Date(Date.UTC(y, m - 1, d));
  if (granularity === "day") end.setUTCDate(end.getUTCDate() + 1);
  if (granularity === "week") end.setUTCDate(end.getUTCDate() + 7);
  if (granularity === "month") end.setUTCMonth(end.getUTCMonth() + 1);
  if (granularity === "quarter") end.setUTCMonth(end.getUTCMonth() + 3);
  if (granularity === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
  end.setUTCDate(end.getUTCDate() - 1);
  const endDate = end.toISOString().slice(0, 10);
  return {
    fieldId,
    op: "between",
    value: includeTime
      ? [zonedBoundary(`${startDate}T00:00`, dateConfig), zonedBoundary(`${endDate}T23:59:59.999`, dateConfig)]
      : [startDate, endDate],
  };
};
