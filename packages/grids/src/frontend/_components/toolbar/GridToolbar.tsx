import { refreshCurrentPath } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, ButtonLink, prompts, Tooltip, useLocale } from "@k2b/ui";
import { createEffect, createSignal, on, Show, untrack } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicField as Field, PublicForm as Form, PublicGridRecord, PublicView } from "../../../api/public-dto";
import type { ColumnSpec, RecordQuery } from "../../../contracts";
import { simpleQueryToGqlSource } from "../../../query-dsl/record-query-source";
import type { CardSize } from "../records-view/query-url";
import { errorMessage } from "../utils/api-helpers";
import { type AggregationRow, isAggregationRowComplete } from "./AggregationsPanel";
import { CardSizeDropdown } from "./CardSizeDropdown";
import FilterPanel, { blankLeaf, type FilterLeaf, isFilterLeafComplete } from "./FilterPanel";
import { filterableFields } from "./filter-ops";
import { GridCreateActions } from "./GridCreateActions";
import { type GroupByRow, isGroupByRowComplete } from "./GroupByPanel";
import { toolbarMessages } from "./messages";
import SortPanel, { blankSortRow, isSortRowComplete, type SortRow } from "./SortPanel";

type Props = {
  baseId: string;
  tableId: string;
  tableName: string;
  disableDirectInsert: boolean;
  fields: Field[];
  initialFilter: FilterLeaf[];
  initialSort: SortRow[];
  initialGroupBy: GroupByRow[];
  initialAggregations: AggregationRow[];
  recordMeta?: RecordQuery["recordMeta"];
  columns?: ColumnSpec[];
  queryHref?: string;
  onOpenQuery?: () => void;
  onAddComputedColumn?: () => void;
  onClearColumns?: () => void;
  currentSearch: { q: string; fieldIds: string[] };
  forms?: Form[];
  canWrite: boolean;
  canDirectWrite: boolean;
  canSubmitForms: boolean;
  /**
   * Emit the toolbar's current filter / sort / group / aggregations
   * shape to the parent (RecordsView). The parent owns the canonical
   * RecordQuery + URL sync; the toolbar is a pure controlled component
   * here. Patch keys are `undefined` when their panel is empty so the
   * parent can drop them from the URL representation.
   */
  onCommit: (patch: {
    filter?: RecordQuery["filter"];
    sort?: RecordQuery["sort"];
    groupBy?: RecordQuery["groupBy"];
    aggregations?: RecordQuery["aggregations"];
  }) => void;
  /**
   * Emitted after a successful manual row create. The parent
   * (RecordsView) opens the detail panel for the new record and
   * refetches the table.
   */
  onRecordCreated?: (record: PublicGridRecord) => void;
  /** Emitted after form submit where there is no single record-open
   *  intent; the parent just refetches the records resource. */
  onRecordsChanged?: () => void;
  dateConfig?: DateContext;
  showCardSize?: boolean;
  cardSize?: CardSize;
  onCardSizeChange?: (size: CardSize) => void;
};

/**
 * Compact toolbar over the records table. Shared button variants keep its
 * actions aligned with the other portable toolbar and dropdown controls.
 *
 * Filter and sort rows live up here so the panels below appear iff
 * `rows.length > 0`. Clicking Filter / Sort directly appends a blank
 * row — no separate "Add filter" click needed.
 */
export default function GridToolbar(props: Props) {
  const locale = useLocale();
  const t = () => toolbarMessages.resolve([locale()]).t;
  const [filterRows, setFilterRows] = createSignal<FilterLeaf[]>(props.initialFilter);
  const [sortRows, setSortRows] = createSignal<SortRow[]>(props.initialSort);
  const [groupByRows, setGroupByRows] = createSignal<GroupByRow[]>(props.initialGroupBy);
  const [aggRows, setAggRows] = createSignal<AggregationRow[]>(props.initialAggregations);
  let skipNextFilterDraftCommit = false;

  const hasFilter = () => filterRows().length > 0;
  const hasSort = () => sortRows().length > 0;
  const hasGroupBy = () => groupByRows().length > 0;
  const hasAgg = () => aggRows().length > 0;
  const hasCustomColumns = () => (props.columns ?? []).some((column) => "kind" in column && column.kind === "computed");
  const hasFilterableFields = () => filterableFields(props.fields).length > 0;
  const hasToolbarQuery = () => hasFilter() || hasSort() || hasGroupBy() || hasAgg() || hasCustomColumns();
  const hasSaveableQuery = () => hasToolbarQuery() || props.currentSearch.q.trim().length > 0;
  const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const completeFilterRows = (rows: FilterLeaf[]) => rows.filter((l) => isFilterLeafComplete(l, props.fields));

  createEffect(() => {
    const nextFilter = props.initialFilter;
    const nextSort = props.initialSort;
    const nextGroupBy = props.initialGroupBy;
    const nextAgg = props.initialAggregations;
    const currentFilter = untrack(filterRows);
    const currentCompleteFilter = completeFilterRows(currentFilter);
    const hasFilterDraft = currentFilter.length > currentCompleteFilter.length;
    if (!sameJson(currentFilter, nextFilter) && !(hasFilterDraft && sameJson(currentCompleteFilter, nextFilter))) {
      setFilterRows(nextFilter);
    }
    if (!sameJson(untrack(sortRows), nextSort)) setSortRows(nextSort);
    if (!sameJson(untrack(groupByRows), nextGroupBy)) setGroupByRows(nextGroupBy);
    if (!sameJson(untrack(aggRows), nextAgg)) setAggRows(nextAgg);
  });

  // Validators trim incomplete rows before emitting upstream — same
  // contract as before, just propagated through onCommit instead of
  // navigateTo.
  const validFilter = () => completeFilterRows(filterRows());
  const validSort = () => sortRows().filter((r) => isSortRowComplete(r, props.fields));
  const validGroupBy = () => groupByRows().filter((r) => isGroupByRowComplete(r, props.fields));
  const validAgg = () => aggRows().filter(isAggregationRowComplete);

  // Auto-emit: every panel-signal change reports the toolbar's current
  // shape to the parent. The parent decides whether the resulting query
  // is a no-op vs a real change (it owns the canonical state + URL).
  // `defer: true` skips the initial run from props-derived signal init.
  createEffect(
    on(
      [filterRows, sortRows, groupByRows, aggRows],
      () => {
        const f = validFilter();
        const s = validSort();
        const g = validGroupBy();
        const a = validAgg();
        if (skipNextFilterDraftCommit && filterRows().length > f.length) {
          skipNextFilterDraftCommit = false;
          return;
        }
        skipNextFilterDraftCommit = false;
        props.onCommit({
          filter: f.length > 0 ? { op: "AND" as const, filters: f } : undefined,
          sort: s.length > 0 ? s : undefined,
          groupBy: g.length > 0 ? g : undefined,
          aggregations: a.length > 0 ? a : undefined,
        });
      },
      { defer: true },
    ),
  );

  // ---- Filter / Sort one-click toggles ----------------------------------
  // Click Filter when empty → append a blank row. Panel appears
  // automatically because we render iff filterRows().length > 0.
  // Click Filter when non-empty → append another row (matches the user's
  // Interaction rule: "Filter button = add a filter").
  const onFilterClick = () => {
    const blank = blankLeaf(props.fields);
    if (!blank) {
      prompts.error(t().noFilterableFields);
      return;
    }
    skipNextFilterDraftCommit = true;
    setFilterRows([...filterRows(), blank]);
  };
  const onSortClick = () => {
    const blank = blankSortRow(props.fields);
    if (blank) setSortRows([...sortRows(), blank]);
  };
  // ---- Save as view ------------------------------------------------------
  // Reads signal state rather than URL state so unapplied changes are
  // captured when the user saves the current view.
  const saveViewMut = mutations.create<PublicView, { name: string; shared: boolean }>({
    mutation: async (input) => {
      const f = validFilter();
      const s = validSort();
      const g = validGroupBy();
      const a = validAgg();
      const query = {
        filter: f.length > 0 ? { op: "AND" as const, filters: f } : undefined,
        search: props.currentSearch.q.trim()
          ? {
              q: props.currentSearch.q.trim(),
              fieldIds: props.currentSearch.fieldIds,
            }
          : undefined,
        recordMeta: props.recordMeta,
        sort: s.length > 0 ? s : undefined,
        groupBy: g.length > 0 ? g : undefined,
        aggregations: a.length > 0 ? a : undefined,
        columns: hasCustomColumns() ? props.columns : undefined,
      } satisfies RecordQuery;
      const source = simpleQueryToGqlSource({ tableId: props.tableId, query });
      if (!source.ok) throw new Error(source.reason);
      const res = await apiClient.views["by-table"][":tableId"].$post({
        param: { tableId: props.tableId },
        json: { name: input.name, source: source.source, ui: { columns: query.columns }, shared: input.shared },
      });
      if (!res.ok) throw new Error(await errorMessage(res, t().saveViewFailed));
      return res.json();
    },
    onSuccess: () => refreshCurrentPath(),
    onError: (e) => prompts.error(e.message),
  });

  const handleSaveView = async () => {
    const result = await prompts.form({
      title: t().saveView,
      icon: "ti ti-bookmark-plus",
      fields: {
        name: {
          type: "text",
          label: t().name,
          required: true,
          placeholder: t().openTasksExample,
        },
        shared: {
          type: "boolean",
          label: props.canWrite ? t().shareView : t().shareRequiresWrite,
          default: false,
        },
      },
      confirmText: t().save,
    });
    if (!result) return;
    if (result.shared && !props.canWrite) {
      prompts.error(t().shareViewDenied);
      return;
    }
    saveViewMut.mutate({
      name: String(result.name).trim(),
      shared: Boolean(result.shared),
    });
  };

  // ---- Clear filter and/or sort (smart label) ---------------------------
  // Builds a label that names exactly what's currently active so the user
  // sees "Clear filter", "Clear sort", or "Clear filter & sort" depending
  // on which URL params are set.
  const clearLabel = () => {
    const parts: string[] = [];
    if (hasFilter()) parts.push(t().filterItem);
    if (hasSort()) parts.push(t().sortItem);
    if (hasGroupBy()) parts.push(t().groupItem);
    if (hasAgg()) parts.push(t().aggregationsItem);
    if (hasCustomColumns()) parts.push(t().columnsItem);
    if (parts.length === 0) return t().clear;
    if (parts.length === 1) return t().clearItems({ items: parts[0]! });
    return t().clearMany({ items: parts.slice(0, -1).join(", "), last: parts[parts.length - 1]! });
  };
  const clearAll = () => {
    // Each setter triggers the auto-emit createEffect above, which calls
    // onCommit with the now-empty patch. The parent (RecordsView) handles
    // URL sync — this is just toolbar-local state.
    setFilterRows([]);
    setSortRows([]);
    setGroupByRows([]);
    setAggRows([]);
    props.onClearColumns?.();
  };

  // GridToolbar is only rendered in live + non-view mode (RecordsView
  // wraps it in `<Show when={!viewMode && !trashMode}>`). So this whole
  // file no longer needs to handle trash mode or view mode — direct insert,
  // every panel, every action button is unconditionally meaningful here.
  return (
    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <GridCreateActions
          baseId={props.baseId}
          tableId={props.tableId}
          tableName={props.tableName}
          disableDirectInsert={props.disableDirectInsert}
          fields={props.fields}
          forms={props.forms}
          canWrite={props.canWrite}
          canDirectWrite={props.canDirectWrite}
          canSubmitForms={props.canSubmitForms}
          onRecordCreated={props.onRecordCreated}
          onRecordsChanged={props.onRecordsChanged}
          dateConfig={props.dateConfig}
        />

        <Show when={props.onOpenQuery || props.queryHref}>
          {(queryTarget) => (
            <Show
              when={props.onOpenQuery}
              fallback={
                <ButtonLink href={queryTarget() as string} variant="secondary" size="sm" aria-pressed={hasGroupBy() || hasAgg()}>
                  <i class="ti ti-code" />
                  {t().query}
                </ButtonLink>
              }
            >
              {(openQuery) => (
                <Button variant="secondary" size="sm" aria-pressed={hasGroupBy() || hasAgg()} onClick={openQuery()}>
                  <i class="ti ti-code" />
                  {t().query}
                </Button>
              )}
            </Show>
          )}
        </Show>

        {/* Filter — clicking adds a blank row; the panel below renders iff rows > 0. */}
        <Tooltip.Anchor content={hasFilterableFields() ? "" : t().noFilterableFields} disabled={hasFilterableFields()}>
          <span class="inline-flex">
            <Button variant="secondary" size="sm" aria-pressed={hasFilter()} onClick={onFilterClick} disabled={!hasFilterableFields()}>
              <i class="ti ti-filter" />
              {t().filter}
            </Button>
          </span>
        </Tooltip.Anchor>

        {/* Sort */}
        <Button variant="secondary" size="sm" aria-pressed={hasSort()} onClick={onSortClick}>
          <i class="ti ti-arrows-sort" />
          {t().sort}
        </Button>

        <Show when={props.onAddComputedColumn}>
          <Button variant="secondary" size="sm" aria-pressed={hasCustomColumns()} onClick={props.onAddComputedColumn}>
            <i class="ti ti-calculator" />
            {t().computed}
          </Button>
        </Show>

        <Show when={props.showCardSize && props.onCardSizeChange}>
          <CardSizeDropdown value={props.cardSize ?? "medium"} onChange={(size) => props.onCardSizeChange?.(size)} />
        </Show>

        {/* Smart Clear — appears when any query dimension is active.
            Label names exactly what goes away. */}
        <Show when={hasToolbarQuery()}>
          <Button variant="secondary" size="sm" type="button" class="text-red-500" onClick={clearAll}>
            <i class="ti ti-filter-off" />
            {clearLabel()}
          </Button>
        </Show>

        {/* Save as view — captures the current query into a frozen
            preset. The view settings modal handles renaming / sharing; the query
            becomes read-only after save. */}
        <Show when={hasSaveableQuery()}>
          <Button variant="secondary" size="sm" type="button" class="ml-auto" onClick={handleSaveView} disabled={saveViewMut.loading()}>
            <i class={`ti ${saveViewMut.loading() ? "ti-loader-2 animate-spin" : "ti-bookmark-plus"}`} />
            {saveViewMut.loading() ? t().saving : t().saveAsView}
          </Button>
        </Show>
      </div>

      {/* Filter panel — render iff there's at least one filter row */}
      <Show when={hasFilter()}>
        <div class="paper p-2.5">
          <FilterPanel fields={props.fields} rows={filterRows} onRowsChange={setFilterRows} dateConfig={props.dateConfig} />
        </div>
      </Show>

      {/* Sort panel */}
      <Show when={hasSort()}>
        <div class="paper p-2.5">
          <SortPanel fields={props.fields} rows={sortRows} onRowsChange={setSortRows} />
        </div>
      </Show>

      {/* No Apply / Cancel chips — auto-commit on every signal change
          (debounced 300ms) handles it. URL stays the source of truth so
          reload / copy-paste / save-as-view all work. */}
    </div>
  );
}
