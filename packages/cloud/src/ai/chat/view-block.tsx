import {
  CopyButton,
  DataTable,
  type DataTableSort,
  DescriptionList,
  markdownReferenceIcon,
  StatCell,
  type StatCellAccent,
  StatGrid,
  type StatGridColumns,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, createUniqueId, Index, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { CloudAiChartRow } from "../chart-block";
import {
  CLOUD_AI_VIEW_MAX_BYTES,
  type CloudAiDetailsView,
  type CloudAiStatsView,
  type CloudAiTableView,
  type CloudAiView,
  type CloudAiViewReference,
  type CloudAiViewSummary,
  cloudAiDetailsRows,
  cloudAiStatsTiles,
  cloudAiTableTsv,
  cloudAiViewSummary,
  cloudAiViewTable,
  isAiViewFile,
  parseCloudAiView,
  sortCloudAiViewRows,
} from "../view-block";
import { CloudChartGroupView, CloudChartView } from "./chart-block";
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

/** A view's title and subtitle: the loaded file's once it is there, its summary's before. */
function ViewHeading(props: { id: string; title: string; subtitle?: string; actions?: JSX.Element }) {
  return (
    <header class="flex flex-wrap items-center justify-between gap-2">
      <div class="min-w-0">
        <h3 id={props.id} class="m-0 text-base font-semibold">
          {props.title}
        </h3>
        <Show when={props.subtitle}>{(subtitle) => <span class="text-sm text-secondary">{subtitle()}</span>}</Show>
      </div>
      {props.actions}
    </header>
  );
}

/**
 * A Cloud object a view names. It carries no URL: the host resolves it on click with the viewer's access and confirms
 * before it opens. It looks like a reference to Cloud content in Markdown, a calm pill, and stays text without a host.
 */
function ReferenceText(props: { text: string; reference: CloudAiViewReference }) {
  const actions = useAiChatActions();
  return (
    <Show when={actions.onOpenReference} fallback={props.text}>
      {(open) => (
        <button
          type="button"
          // The pill's fill reaches past the text without making a compact table row taller than the one reserved.
          class="k2b-reference -my-[0.125em] cursor-pointer text-left"
          data-reference="page"
          onClick={() => open()(props.text, { type: props.reference.type, id: props.reference.id })}
        >
          <i class={`k2b-reference__icon ti ${markdownReferenceIcon("page")}`} aria-hidden="true" />
          {props.text}
        </button>
      )}
    </Show>
  );
}

type TableSummary = Extract<CloudAiViewSummary, { view: "table" }>;
type ChartSummary = Extract<CloudAiViewSummary, { view: "chart" }>;
type GroupSummary = Extract<CloudAiViewSummary, { view: "group" }>;

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
  const refColumns = createMemo(() => new Set(props.input?.columns.flatMap((column) => (column.type === "ref" ? [column.id] : []))));
  return (
    <section class="grid min-w-0 gap-3" aria-labelledby={id}>
      <ViewHeading
        id={id}
        title={props.input?.title ?? props.summary.title}
        subtitle={props.input ? props.input.subtitle : props.summary.subtitle}
        actions={<CopyButton text={copyText()} label={t().viewCopyData} iconOnly size="sm" variant="ghost" disabled={!table()} />}
      />
      <div class="min-w-0" style={{ height: tableHeight(props.summary) }}>
        <Show
          when={table()}
          fallback={
            <div role="status" class="flex h-full items-center justify-center text-center text-xs text-dimmed">
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
                // A wrapped label would make the header taller than the reserved row; the table scrolls sideways instead.
                headerClass: "whitespace-nowrap",
                value: (row) => row.cells[column.id] ?? "",
                align: column.numeric ? "right" : "left",
                sortable: true,
              }))}
              renderCell={({ row, col, value: text, render }) => {
                // Row keys are row indexes, so a reference cell finds its object in the loaded view.
                const cell = refColumns().has(col.id) ? props.input?.rows[Number(row.key)]?.[col.id] : undefined;
                return cell && typeof cell === "object" ? <ReferenceText text={String(text)} reference={cell} /> : render(text);
              }}
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

type StatsSummary = Extract<CloudAiViewSummary, { view: "stats" }>;
type DetailsSummary = Extract<CloudAiViewSummary, { view: "details" }>;

const DELTA_TONES = { better: "emerald", worse: "red", neutral: "zinc" } as const;
const DELTA_ICONS = { up: "ti ti-trending-up", down: "ti ti-trending-down", flat: "ti ti-minus" } as const;
/** One column per tile, up to the grid's six; its ladder narrows them on phones. */
const STATS_COLUMNS: readonly StatGridColumns[] = [1, 2, 3, 4, 5, 6];

/** The host picks the change's color from whether it is better; the model never chooses tones. */
const deltaAccent = (delta: ReturnType<typeof cloudAiStatsTiles>[number]["delta"]): StatCellAccent | undefined =>
  delta && { tone: DELTA_TONES[delta.tone], icon: DELTA_ICONS[delta.direction], text: delta.text };

/** The loading or unavailable message, centered over the room the view reserved. */
function ViewStatus(props: { loading: boolean }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  return (
    <div role="status" class="flex h-full items-center justify-center text-center text-xs text-dimmed">
      {props.loading ? t().viewLoading : t().viewUnavailable}
    </div>
  );
}

/**
 * Key figures as stat tiles. The grid's column ladder decides the layout; every tile's height follows from whether it
 * has a sparkline and a support line, which the summary records, so a hidden copy of the same grid reserves the exact
 * room while the file loads or when it is unavailable.
 */
function CloudStatsView(props: { summary: StatsSummary; input: CloudAiStatsView | null | undefined }) {
  const locale = useLocale();
  const id = `cloud-view-${createUniqueId()}`;
  const tiles = createMemo(() => (props.input ? cloudAiStatsTiles(props.input, locale()) : null));
  const columns = () => STATS_COLUMNS[props.summary.items.length - 1];
  return (
    <section class="grid min-w-0 gap-3" aria-labelledby={id}>
      <ViewHeading
        id={id}
        title={props.input?.title ?? props.summary.title}
        subtitle={props.input ? props.input.subtitle : props.summary.subtitle}
      />
      <Show
        when={tiles()}
        fallback={
          <div class="relative min-w-0">
            <div class="invisible" aria-hidden="true">
              <StatGrid columns={columns()}>
                <Index each={props.summary.items}>
                  {(item) => (
                    <StatCell
                      label={item().label}
                      value="0"
                      trend={item().sparkline ? [0, 1] : undefined}
                      sub={item().sub ? "\u00a0" : undefined}
                      accent={item().delta ? { tone: "zinc", icon: DELTA_ICONS.flat, text: "0" } : undefined}
                    />
                  )}
                </Index>
              </StatGrid>
            </div>
            <div class="absolute inset-0">
              <ViewStatus loading={props.input === undefined} />
            </div>
          </div>
        }
      >
        {(value) => (
          <StatGrid columns={columns()}>
            <Index each={value()}>
              {(tile) => (
                <StatCell
                  label={tile().label}
                  value={tile().value}
                  title={tile().value}
                  trend={tile().sparkline}
                  sub={tile().sub}
                  accent={deltaAccent(tile().delta)}
                />
              )}
            </Index>
          </StatGrid>
        )}
      </Show>
    </section>
  );
}

/** Fields a record shows before its viewport scrolls; it reserves their height from the first frame. */
const DETAILS_VIEWPORT_ITEMS = 12;
/** One description row: its minimum height in the `rows` layout. */
const DETAILS_ROW_REM = 2.25;

/**
 * One record as label and value rows. The viewport takes the height of its field count, up to twelve rows, from the
 * summary; more fields, or values that wrap, scroll inside it instead of moving the chat.
 */
function CloudDetailsView(props: { summary: DetailsSummary; input: CloudAiDetailsView | null | undefined }) {
  const locale = useLocale();
  const id = `cloud-view-${createUniqueId()}`;
  const rows = createMemo(() => (props.input ? cloudAiDetailsRows(props.input, locale()) : null));
  return (
    <section class="grid min-w-0 gap-3" aria-labelledby={id}>
      <ViewHeading
        id={id}
        title={props.input?.title ?? props.summary.title}
        subtitle={props.input ? props.input.subtitle : props.summary.subtitle}
      />
      <div
        class="min-w-0 overflow-y-auto"
        style={{ height: `${Math.min(props.summary.items, DETAILS_VIEWPORT_ITEMS) * DETAILS_ROW_REM}rem` }}
      >
        <Show when={rows()} fallback={<ViewStatus loading={props.input === undefined} />}>
          {(value) => (
            <DescriptionList
              layout="rows"
              items={value().map((row) => ({
                term: row.label,
                description: row.ref ? (
                  <ReferenceText text={row.text} reference={row.ref} />
                ) : (
                  row.text || <span class="text-dimmed">—</span>
                ),
              }))}
            />
          )}
        </Show>
      </div>
    </section>
  );
}

type Heading = { title: string; subtitle?: string };
const sameHeading = (a: Heading, b: Heading | undefined) => a.title === b?.title && a.subtitle === b.subtitle;

/**
 * Whether a loaded file still has everything its summary reserved: kinds, headings, layout and the linked cursor. A
 * changed file shows unavailable instead of moving or linking charts its summary did not.
 */
const matches = (view: CloudAiView, summary: CloudAiViewSummary) => {
  if (view.view === "table") return summary.view === "table";
  if (view.view === "details") return summary.view === "details" && view.items.length === summary.items;
  const loaded = cloudAiViewSummary(view);
  // A stats file must keep every tile's label and parts, which set the tile heights its summary reserved.
  if (loaded.view === "stats") return summary.view === "stats" && JSON.stringify(loaded.items) === JSON.stringify(summary.items);
  if (loaded.view === "chart") return summary.view === "chart" && loaded.kind === summary.kind && sameHeading(loaded, summary);
  return (
    loaded.view === "group" &&
    summary.view === "group" &&
    sameHeading(loaded, summary) &&
    loaded.linkX === summary.linkX &&
    loaded.layout === summary.layout &&
    loaded.charts.length === summary.charts.length &&
    loaded.charts.every((chart, index) => chart.kind === summary.charts[index]?.kind && sameHeading(chart, summary.charts[index]))
  );
};

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
      if (!abort.signal.aborted) setView(loaded && matches(loaded, props.summary) ? loaded : null);
    });
  });
  const chartSummary = (): ChartSummary | undefined => (props.summary.view === "chart" ? props.summary : undefined);
  const tableSummary = (): TableSummary | undefined => (props.summary.view === "table" ? props.summary : undefined);
  const groupSummary = (): GroupSummary | undefined => (props.summary.view === "group" ? props.summary : undefined);
  const statsSummary = (): StatsSummary | undefined => (props.summary.view === "stats" ? props.summary : undefined);
  const detailsSummary = (): DetailsSummary | undefined => (props.summary.view === "details" ? props.summary : undefined);
  function loaded(kind: "chart"): Extract<CloudAiView, { view: "chart" }> | null | undefined;
  function loaded(kind: "table"): CloudAiTableView | null | undefined;
  function loaded(kind: "group"): Extract<CloudAiView, { view: "group" }> | null | undefined;
  function loaded(kind: "stats"): CloudAiStatsView | null | undefined;
  function loaded(kind: "details"): CloudAiDetailsView | null | undefined;
  function loaded(kind: CloudAiView["view"]) {
    const value = view();
    return value && value.view !== kind ? null : value;
  }
  return (
    <div data-view-path={props.path} class="min-w-0">
      <Switch>
        <Match when={chartSummary()}>{(summary) => <CloudChartView summary={summary()} input={loaded("chart")} />}</Match>
        <Match when={tableSummary()}>{(summary) => <CloudTableView summary={summary()} input={loaded("table")} />}</Match>
        <Match when={groupSummary()}>{(summary) => <CloudChartGroupView summary={summary()} group={loaded("group")} />}</Match>
        <Match when={statsSummary()}>{(summary) => <CloudStatsView summary={summary()} input={loaded("stats")} />}</Match>
        <Match when={detailsSummary()}>{(summary) => <CloudDetailsView summary={summary()} input={loaded("details")} />}</Match>
      </Switch>
    </div>
  );
}
