import type { DateContext } from "@k2b/stdlib";
import { Button, DataTable, type DataTableColumn, IconButton, Placeholder, Tooltip, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import type { PublicField as Field } from "../../../api/public-dto";
import type { AggregationSpec, GroupBySpec } from "../../../contracts";
import { FieldValue } from "./FieldValue";
import { formatAggregationValue, formatGroupValue } from "./group-value-format";
import { tableMessages } from "./messages";

/**
 * Server-rendered shape of a group bucket. Mirrors the API contract
 * in `contracts.GroupBucketSchema`. Keys are parallel to the
 * groupBy spec used to produce them; values is keyed by `${fid}__${agg}`
 * (or `*__count` for COUNT(*)).
 */
export type GroupBucket = {
  keys: unknown[];
  values: Record<string, unknown>;
};

type GroupTableColumn =
  | { kind: "group"; id: string; spec: GroupByCol; index: number }
  | { kind: "agg"; id: string; spec: AggCol; index: number };
type GroupDataTableColumn = DataTableColumn<GroupBucket> & { meta: GroupTableColumn };

type GroupByCol = GroupBySpec;
type AggCol = AggregationSpec;

type Props = {
  /** Base id (UUID or slug — same value the parent page uses) so the
   *  relation-group-key links can navigate to `/app/grids/<base>?table=…&record=…`,
   *  matching the row-mode relation cell behavior. */
  baseId: string;
  fields: Field[];
  groupBy: GroupByCol[];
  aggregations: AggCol[];
  buckets: GroupBucket[];
  /** Server flag: at least one groupBy dimension is a relation, so a
   *  record with N links contributes to N buckets and `*__count` counts
   *  pair occurrences, not unique records. UI surfaces a hint when set. */
  explode?: boolean;
  /** UUID → presentable label for relation-typed group keys. Same map
   *  the row-mode grid uses to render relation cells; the API endpoint
   *  resolves it server-side for grouped responses so the keys column
   *  doesn't show raw UUIDs. */
  relationLabels?: Record<string, string>;
  selectedBucketKey?: string | null;
  onBucketClick?: (bucket: GroupBucket) => void;
  adminMode?: boolean;
  columnOrder?: string[];
  hiddenColumnIds?: string[];
  scrollPreserveKey?: string;
  onColumnSettings?: (columnId: string) => void;
  onColumnMove?: (columnId: string, direction: -1 | 1) => void;
  dateConfig?: DateContext;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
};

export const groupedGroupColumnId = (spec: GroupByCol, index: number): string => `group:${index}:${spec.fieldId}:${spec.granularity ?? ""}`;

export const groupedAggregationColumnId = (spec: AggCol, index: number): string => `agg:${index}:${spec.fieldId}:${spec.agg}`;

/**
 * Renders a "summary view": one row per bucket, columns are
 *   [<group key 1>, <group key 2>, …, <agg 1>, <agg 2>, …]
 *
 * Records aren't shown (classic GROUP BY semantics — switch the view
 * back to no-grouping for the row-level list). The default `*__count`
 * column is always emitted by the server, even when the user didn't
 * configure aggregations explicitly.
 */
export default function GroupedTable(props: Props) {
  const locale = useLocale();
  const t = () => tableMessages.resolve([locale()]).t;
  const fieldsById = new Map(props.fields.map((f) => [f.id, f]));

  const groupHeader = (g: GroupByCol): string => {
    if (g.label?.trim()) return g.label.trim();
    const f = fieldsById.get(g.fieldId);
    if (!f) return t().missingField;
    return g.granularity ? `${f.name} (${g.granularity})` : f.name;
  };
  const aggHeader = (a: AggCol): string => {
    if (a.label) return a.label;
    if (a.fieldId === "*") return a.agg === "count" ? t().recordCount : a.agg;
    const f = fieldsById.get(a.fieldId);
    const name = f ? f.name : t().missingField;
    return `${a.agg} ${name}`;
  };

  // Always include the implicit `*__count` column even if the user
  // didn't configure it — the server adds it for every group query
  // because "how many records in this bucket" is universally useful.
  const aggColsWithCount = (): AggCol[] => {
    const explicit = props.aggregations;
    const hasStarCount = explicit.some((a) => a.fieldId === "*" && a.agg === "count");
    return hasStarCount ? explicit : [{ fieldId: "*", agg: "count" }, ...explicit];
  };
  const aggKeyOf = (a: AggCol): string => `${a.fieldId}__${a.agg}`;

  const bucketKey = (bucket: GroupBucket): string => JSON.stringify(bucket.keys);

  const columns = (): GroupDataTableColumn[] => {
    const hidden = new Set(props.hiddenColumnIds ?? []);
    const baseColumns: GroupDataTableColumn[] = [
      ...props.groupBy.map((g, index) => ({
        id: groupedGroupColumnId(g, index),
        header: groupHeader(g),
        subtitle: t().groupedRecords,
        value: () => undefined,
        meta: { kind: "group", id: groupedGroupColumnId(g, index), spec: g, index } as GroupTableColumn,
      })),
      ...aggColsWithCount().map((a, index) => ({
        id: groupedAggregationColumnId(a, index),
        header: aggHeader(a),
        subtitle: t().summary,
        value: (bucket: GroupBucket) => bucket.values[aggKeyOf(a)],
        cellClass: "tabular-nums",
        meta: { kind: "agg", id: groupedAggregationColumnId(a, index), spec: a, index } as GroupTableColumn,
      })),
    ].filter((column) => !hidden.has(column.id));
    const orderedIds = props.columnOrder ?? [];
    if (orderedIds.length === 0) return baseColumns;
    const byId = new Map(baseColumns.map((column) => [column.id, column]));
    const orderedColumns = orderedIds.map((id) => byId.get(id)).filter((column): column is GroupDataTableColumn => !!column);
    const orderedSet = new Set(orderedColumns.map((column) => column.id));
    return [...orderedColumns, ...baseColumns.filter((column) => !orderedSet.has(column.id))];
  };

  const columnMeta = (col: DataTableColumn<GroupBucket>): GroupTableColumn => (col as GroupDataTableColumn).meta;

  return (
    <Show when={props.buckets.length > 0} fallback={<Placeholder surface="paper" description={<>{t().noGroups}</>} />}>
      <Show when={props.explode}>
        <div class="text-[11px] text-dimmed flex items-center gap-1.5 px-1">
          <i class="ti ti-info-circle" />
          {t().overlappingGroups}
        </div>
      </Show>
      <DataTable
        ariaLabel={t().groupedRecords}
        rows={props.buckets}
        columns={columns()}
        scrollPreserveKey={props.scrollPreserveKey}
        selectedRowId={props.selectedBucketKey}
        getRowId={bucketKey}
        onRowClick={props.onBucketClick}
        renderHeader={({ col, render }) => {
          const meta = columnMeta(col);
          if (!props.adminMode) return render();
          const renderedColumns = columns();
          const index = renderedColumns.findIndex((column) => column.id === col.id);
          const count = renderedColumns.length;
          const settings = props.onColumnSettings;
          const move = props.onColumnMove;
          if (!settings && !move) return render();
          return (
            <div class="flex min-w-0 items-start gap-2">
              <div class="min-w-0 flex-1">{render()}</div>
              <div class="flex shrink-0 items-center gap-0">
                <Tooltip.Anchor content={t().moveColumnLeft}>
                  <IconButton
                    label={t().moveColumnLeft}
                    size="xs"
                    class="app-accent-text h-6 w-6 shrink-0 hover:opacity-75"
                    onClick={(event) => {
                      event.stopPropagation();
                      move?.(meta.id, -1);
                    }}
                    disabled={!move || index === 0}
                  >
                    <i class="ti ti-chevron-left text-xs" />
                  </IconButton>
                </Tooltip.Anchor>
                <Tooltip.Anchor content={t().moveColumnRight}>
                  <IconButton
                    label={t().moveColumnRight}
                    size="xs"
                    class="app-accent-text h-6 w-6 shrink-0 hover:opacity-75"
                    onClick={(event) => {
                      event.stopPropagation();
                      move?.(meta.id, 1);
                    }}
                    disabled={!move || index >= count - 1}
                  >
                    <i class="ti ti-chevron-right text-xs" />
                  </IconButton>
                </Tooltip.Anchor>
                <Tooltip.Anchor content={t().columnSettings}>
                  <IconButton
                    label={t().columnSettings}
                    size="xs"
                    class="app-accent-text h-6 w-6 shrink-0 hover:opacity-75"
                    onClick={(event) => {
                      event.stopPropagation();
                      settings?.(meta.id);
                    }}
                    disabled={!settings}
                  >
                    <i class="ti ti-settings text-xs" />
                  </IconButton>
                </Tooltip.Anchor>
              </div>
            </div>
          );
        }}
        renderCell={({ row, col }) => {
          const meta = columnMeta(col);
          if (meta.kind === "agg") {
            return formatAggregationValue({
              value: row.values[aggKeyOf(meta.spec)],
              spec: meta.spec,
              field: meta.spec.fieldId === "*" ? undefined : fieldsById.get(meta.spec.fieldId),
              dateConfig: props.dateConfig,
              locale: locale(),
            });
          }
          const f = fieldsById.get(meta.spec.fieldId);
          const val = row.keys[meta.index];
          if (f && f.type === "relation" && typeof val === "string") {
            return <FieldValue field={f} value={val} baseId={props.baseId} relationLabels={props.relationLabels} mode="table" empty="—" />;
          }
          return formatGroupValue({ value: val, spec: meta.spec, field: f, dateConfig: props.dateConfig, locale: locale() });
        }}
      />
      <Show when={props.hasMore}>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          class="mt-2 self-center"
          onClick={props.onLoadMore}
          disabled={props.loadingMore}
        >
          {props.loadingMore ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-chevron-down" />}
          {t().loadMoreGroups}
        </Button>
      </Show>
    </Show>
  );
}
