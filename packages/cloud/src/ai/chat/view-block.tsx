import { CopyButton, DataTable, type DataTableSort, useLocale } from "@k2b/ui";
import { createMemo, createSignal, createUniqueId, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { CloudAiChartRow } from "../chart-block";
import {
  CLOUD_AI_VIEW_MAX_BYTES,
  type CloudAiTableView,
  type CloudAiView,
  type CloudAiViewSummary,
  cloudAiTableTsv,
  cloudAiViewTable,
  isAiViewFile,
  sortCloudAiViewRows,
  parseCloudAiView,
} from "../view-block";
import { CloudChartView } from "./chart-block";
import { useAiChatActions } from "./message-actions";
import { aiChatMessages } from "./messages";

/** Rows a table shows inline, as capability tables do; sorting and Copy data use all of them. */
const VISIBLE_ROWS = 100;
/** Rows the viewport shows before it scrolls; it reserves their height from the first frame. */
const VIEWPORT_ROWS = 8;
/** A compact row: 12px text on a 16px line, 6px padding above and below, a 1px line. */
const ROW_REM = 1.8125;

/** Loads a view file with the viewer's access and validates it again: a file is untrusted whoever wrote it. */
async function loadView(url: string, path: string, signal: AbortSignal): Promise<CloudAiView | null> {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok || !isAiViewFile({ path, origin: response.headers.get("X-Cloud-Ai-File-Origin") ?? "" })) return null;
    const blob = await response.blob();
    if (blob.size > CLOUD_AI_VIEW_MAX_BYTES) return null;
    return parseCloudAiView(JSON.parse(await blob.text())) ?? null;
  } catch {
    return null;
  }
}

type TableSummary = Extract<CloudAiViewSummary, { view: "table" }>;
type ChartSummary = Extract<CloudAiViewSummary, { view: "chart" }>;

/** The header row, the rows up to the viewport's, and the totals row when there is one. */
const tableHeight = (summary: TableSummary) =>
  `${(Math.max(1, Math.min(summary.rows, VIEWPORT_ROWS)) + 1 + Number(summary.footer)) * ROW_REM}rem`;

/**
 * A table view: title, Copy data and a sortable table in a viewport whose height follows the row count of its
 * `present` summary, so loading, the table and the unavailable state take the same room.
 */
function CloudTableView(props: { summary: TableSummary; input: CloudAiTableView | null | undefined }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const id = `cloud-view-${createUniqueId()}`;
  const table = createMemo(() => (props.input ? cloudAiViewTable(props.input, locale()) : null));
  // The view's own order applies until the reader picks one.
  const [picked, setSort] = createSignal<DataTableSort>();
  const sort = (): DataTableSort | null => {
    const own = props.input?.sort;
    return picked() ?? (own ? { key: own.column, direction: own.direction } : null);
  };
  // cloudAiViewTable returns the view's own order; a picked one sorts again.
  const rows = createMemo(() => {
    const value = table();
    const order = picked();
    return !value ? [] : order ? sortCloudAiViewRows(value.rows, order, locale()) : value.rows;
  });
  const copyText = createMemo(() => {
    const value = table();
    return value ? cloudAiTableTsv({ ...value, rows: rows() }) : "";
  });
  const number = () => new Intl.NumberFormat(locale());
  return (
    <section class="grid min-w-0 gap-3" aria-labelledby={id}>
      <header class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <h3 id={id} class="m-0 text-base font-semibold">
            {props.input?.title ?? props.summary.title}
          </h3>
          <Show when={props.input ? props.input.subtitle : props.summary.subtitle}>
            {(subtitle) => <span class="text-sm text-secondary">{subtitle()}</span>}
          </Show>
        </div>
        <CopyButton text={copyText()} label={t().viewCopyData} iconOnly size="sm" variant="ghost" disabled={!table()} />
      </header>
      <div class="min-w-0" style={{ height: tableHeight(props.summary) }}>
        <Show
          when={table()}
          fallback={
            <div role="status" class="flex h-full items-center justify-center text-xs text-dimmed">
              {props.input === undefined ? t().viewLoading : t().viewUnavailable}
            </div>
          }
        >
          {(value) => (
            <DataTable<CloudAiChartRow>
              rows={rows().slice(0, VISIBLE_ROWS)}
              columns={value().columns.map((column) => ({
                id: column.id,
                header: column.label,
                value: (row) => row.cells[column.id] ?? "",
                align: column.numeric ? "right" : "left",
                sortable: true,
              }))}
              getRowId={(row) => row.key}
              sort={sort()}
              onSortChange={setSort}
              footer={
                value().footer
                  ? { values: value().footer?.cells, renderCell: ({ value }) => (typeof value === "string" ? value : "") }
                  : undefined
              }
              ariaLabelledBy={id}
              density="compact"
              surface="paper"
              stickyHeader
              class="h-full"
              empty={<span>{t().tableEmpty}</span>}
            />
          )}
        </Show>
      </div>
      <Show when={props.summary.rows > VISIBLE_ROWS}>
        <p class="text-sm text-secondary">
          {t().viewRowsCapped({ shown: number().format(VISIBLE_ROWS), total: number().format(props.summary.rows) })}
        </p>
      </Show>
    </section>
  );
}

/**
 * A presented view file. It takes its full size from the `present` summary in the first frame, then loads the file
 * with the viewer's access; a missing file or one that no longer matches its summary shows the unavailable state in
 * the same frame.
 */
export function CloudViewBlock(props: { path: string; summary: CloudAiViewSummary }) {
  const actions = useAiChatActions();
  // undefined while loading, null when unavailable.
  const [view, setView] = createSignal<CloudAiView | null | undefined>(undefined);
  onMount(() => {
    const url = actions.fileUrl?.(props.path);
    if (!url) return setView(null);
    const abort = new AbortController();
    onCleanup(() => abort.abort());
    void loadView(url, props.path, abort.signal).then((loaded) => {
      if (!abort.signal.aborted)
        setView(
          loaded?.view === props.summary.view &&
            !(loaded.view === "chart" && props.summary.view === "chart" && loaded.kind !== props.summary.kind)
            ? loaded
            : null,
        );
    });
  });
  const chartSummary = (): ChartSummary | undefined => (props.summary.view === "chart" ? props.summary : undefined);
  const tableSummary = (): TableSummary | undefined => (props.summary.view === "table" ? props.summary : undefined);
  function loaded(kind: "chart"): Extract<CloudAiView, { view: "chart" }> | null | undefined;
  function loaded(kind: "table"): CloudAiTableView | null | undefined;
  function loaded(kind: CloudAiView["view"]) {
    const value = view();
    return value && value.view !== kind ? null : value;
  }
  return (
    <div data-view-path={props.path} class="min-w-0">
      <Switch>
        <Match when={chartSummary()}>{(summary) => <CloudChartView summary={summary()} input={loaded("chart")} />}</Match>
        <Match when={tableSummary()}>{(summary) => <CloudTableView summary={summary()} input={loaded("table")} />}</Match>
      </Switch>
    </div>
  );
}
