import * as ui from "@k2b/ui";
import {
  Button,
  Chart,
  ChartExplorer,
  type ChartFrameRequest,
  ChartSnapshotView,
  DataTable,
  type DataTableColumn,
  type DataTableSort,
  Paper,
  SelectChip,
  StatCell,
  StatGrid,
  TextInput,
} from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { JsonValue } from "./examples/types";
import { formatNumber } from "./format";
import { blockComponent, resolveDrawing, type ShowcaseRow, specSubtitle, specTitle } from "./resolve";

export type ShowcaseState = "data" | "loading" | "empty" | "error" | "stale";
export const showcaseStates: readonly { value: ShowcaseState; label: string }[] = [
  { value: "data", label: "Data" },
  { value: "loading", label: "Loading" },
  { value: "empty", label: "Empty" },
  { value: "error", label: "Error" },
  { value: "stale", label: "Stale" },
];

const requests: Record<ShowcaseState, ChartFrameRequest> = {
  data: { status: "idle" },
  loading: { status: "loading" },
  empty: { status: "idle" },
  error: { status: "error" },
  stale: { status: "error" },
};
const withRows = (state: ShowcaseState) => state === "data" || state === "stale";
const cssLength = (value: number | string) => (typeof value === "number" ? `${value}px` : value);

type JsonObject = { [key: string]: JsonValue };
const object = (value: JsonValue | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);
const text = (value: JsonValue | undefined) =>
  typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);

export type ShowcaseFrameProps = {
  spec: JsonValue;
  /** Title for descriptions without one, such as map props. */
  title: string;
  subtitle?: string;
  state: ShowcaseState;
  /** Content height: pixels, or a CSS length such as a variable the dashboard grid sets per width. */
  height: number | string;
  view?: "chart" | "table";
  onViewChange?: (view: "chart" | "table") => void;
  onRetry?: () => void;
  empty?: string;
  /** What a slot stands for, such as "Sankey". */
  intended?: string;
  headingLevel?: 2 | 3 | 4;
};

/** One framed panel (F4) for any portable description, with the same states in the same place. */
export function ShowcaseFrame(props: ShowcaseFrameProps): JSX.Element {
  const drawing = createMemo(() => resolveDrawing(props.spec));
  const title = () => specTitle(props.spec, props.title);
  const subtitle = () => specSubtitle(props.spec, props.subtitle);
  const height = () => cssLength(props.height);
  const columns = () => {
    const current = drawing();
    return current.mode === "snapshot" || current.mode === "live" ? current.columns : [];
  };
  const empty = () => props.empty ?? "Nothing to show for this period.";
  const explorer = (
    rows: ShowcaseRow[],
    chart: () => JSX.Element,
    extra: Partial<Parameters<typeof ChartExplorer<ShowcaseRow>>[0]> = {},
  ) => (
    <Paper class="ui-charts-frame">
      <ChartExplorer<ShowcaseRow>
        title={title()}
        headingLevel={props.headingLevel ?? 3}
        description={subtitle()}
        height={height()}
        inset="1rem"
        renderDetails={false}
        view={props.view}
        onViewChange={props.onViewChange}
        request={requests[props.state]}
        asOf="09:12"
        onRetry={props.onRetry}
        empty={empty()}
        data={{ rows: withRows(props.state) ? rows : [] }}
        columns={columns()}
        {...extra}
      >
        {chart()}
      </ChartExplorer>
    </Paper>
  );
  return (
    <Switch>
      <Match when={drawing().mode === "snapshot" && (drawing() as Extract<ReturnType<typeof resolveDrawing>, { mode: "snapshot" }>)}>
        {(snapshot) =>
          explorer(
            snapshot().rows,
            () => (
              <ChartSnapshotView
                snapshot={snapshot().snapshot}
                selectedKey={null}
                onSelect={() => {}}
                style={snapshot().legend.length ? undefined : { height: "100%" }}
              />
            ),
            {
              legend: snapshot().legend,
            },
          )
        }
      </Match>
      <Match when={drawing().mode === "live" && (drawing() as Extract<ReturnType<typeof resolveDrawing>, { mode: "live" }>)}>
        {(live) =>
          live().props.kind === "balanceFlow" ? (
            <Paper class="ui-charts-frame">
              <div style={{ padding: "1rem" }}>
                <Chart
                  {...live().props}
                  {...(live().props.kind === "balanceFlow"
                    ? { state: props.state, view: props.view, onViewChange: props.onViewChange, onRetry: props.onRetry }
                    : {})}
                />
              </div>
            </Paper>
          ) : (
            explorer(live().rows, () => <Chart {...live().props} style={{ height: "100%" }} />)
          )
        }
      </Match>
      <Match when={drawing().mode === "block" && (drawing() as Extract<ReturnType<typeof resolveDrawing>, { mode: "block" }>)}>
        {(block) => (
          <Switch fallback={<ComponentBlock {...props} block={block().block} spec={block().spec} title={title()} subtitle={subtitle()} />}>
            <Match when={block().block === "stats"}>
              <StatsBlock spec={block().spec} state={props.state} onRetry={props.onRetry} />
            </Match>
            <Match when={block().block === "table"}>
              <TableBlock {...props} spec={block().spec} title={title()} subtitle={subtitle()} />
            </Match>
          </Switch>
        )}
      </Match>
      <Match when={drawing().mode === "slot" && (drawing() as Extract<ReturnType<typeof resolveDrawing>, { mode: "slot" }>)}>
        {(slot) => (
          <Paper class="ui-charts-frame">
            <header class="ui-charts-frame__header">
              <div>
                <Dynamic component={`h${props.headingLevel ?? 3}`}>{title()}</Dynamic>
                <Show when={subtitle()}>
                  <p>{subtitle()}</p>
                </Show>
              </div>
            </header>
            <div class="ui-charts-slot" style={{ height: height() }}>
              <span class="ui-charts-slot__kind">{slot().kind}</span>
              <strong>{props.intended ?? `The ${slot().kind} kind`} comes here</strong>
              <p>{slot().reason} This panel fills itself once the catalog step is merged.</p>
            </div>
          </Paper>
        )}
      </Match>
    </Switch>
  );
}

/**
 * `{ block: "stats", items: [...] }`: the key figure tiles of @k2b/ui (F2). Every tile has the frame states in its own
 * place: loading placeholders, "Not loaded" with Try again, the empty dash, and a stale note under the figure.
 */
function StatsBlock(props: { spec: JsonObject; state: ShowcaseState; onRetry?: () => void }): JSX.Element {
  const items = () => list(props.spec.items).filter(object);
  const tones = new Set(["blue", "emerald", "amber", "red", "zinc"]);
  return (
    <StatGrid columns={Math.min(6, Math.max(1, items().length)) as 1 | 2 | 3 | 4 | 5 | 6} class="ui-charts-tiles">
      <For each={items()}>
        {(item) => {
          const delta = () => {
            const change = object(item.delta) ? item.delta : undefined;
            if (!change || typeof change.value !== "number") return undefined;
            return {
              value: change.value,
              ...(change.unit === "points" ? { unit: "points" as const } : {}),
              ...(change.better === "up" ? { better: "up" as const } : change.better === "down" ? { better: "down" as const } : {}),
            };
          };
          const compare = () =>
            object(item.compare) && typeof item.compare.value === "number"
              ? { label: text(item.compare.label), value: formatNumber(item.compare.value, item.format) }
              : undefined;
          return (
            <StatCell
              label={text(item.label)}
              icon={typeof item.icon === "string" ? item.icon : undefined}
              tone={typeof item.tone === "string" && tones.has(item.tone) ? (item.tone as "blue") : undefined}
              value={
                props.state === "empty" ? null : typeof item.value === "number" ? formatNumber(item.value, item.format) : text(item.value)
              }
              sub={props.state === "empty" ? "Nothing counted in this period" : compare() ? undefined : text(item.note) || undefined}
              delta={props.state === "empty" ? undefined : delta()}
              compare={props.state === "empty" ? undefined : compare()}
              trend={list(item.trend).filter((value): value is number => typeof value === "number")}
              status={props.state === "loading" ? "loading" : props.state === "error" ? "error" : undefined}
              stale={props.state === "stale" ? "As of 09:12 · not current" : undefined}
              onRetry={props.onRetry}
            />
          );
        }}
      </For>
    </StatGrid>
  );
}

/** A block's own @k2b/ui component with the description's props (flow: one amount per entry). */
function ComponentBlockContent(props: { block: string; spec: JsonObject }): JSX.Element {
  const values = () => Object.fromEntries(Object.entries(props.spec).filter(([key]) => !["block", "title", "subtitle"].includes(key)));
  return (
    <Show when={blockComponent(props.block)}>
      {(draw) => (
        <Show when={props.block === "flow"} fallback={<Dynamic component={draw()} {...values()} />}>
          <div class="ui-charts-frame__flows">
            <For each={list(props.spec.items).filter(object)}>
              {(item) => <Dynamic component={draw()} {...Object.fromEntries(Object.entries(item).filter(([key]) => key !== "type"))} />}
            </For>
          </div>
        </Show>
      )}
    </Show>
  );
}

/**
 * A block as the overview card shows it: its content without a second frame, the first key figure or the first
 * rows and columns of a table, so the card stays one surface.
 */
export function ShowcaseBlockPreview(props: { block: string; spec: JsonObject }): JSX.Element {
  const columns = () => list(props.spec.columns).filter(object).slice(0, 3);
  const rows = (): TableRow[] =>
    list(props.spec.rows)
      .filter(object)
      .slice(0, 4)
      .map((cells, index) => ({ key: String(index), cells }));
  return (
    <Switch fallback={<ComponentBlockContent block={props.block} spec={props.spec} />}>
      <Match when={props.block === "stats"}>
        <StatsBlock spec={{ ...props.spec, items: list(props.spec.items).slice(0, 1) }} state="data" />
      </Match>
      <Match when={props.block === "table"}>
        <DataTable<TableRow>
          ariaLabel={text(props.spec.title) || "Table"}
          surface="plain"
          density="compact"
          rows={rows()}
          getRowId={(row) => row.key}
          columns={tableColumnsOf(columns(), typedTables())}
        />
      </Match>
    </Switch>
  );
}

/** Content heights of the component blocks when the description names none. */
const blockHeights: Record<string, number> = { balance: 56, flow: 72, budget: 240 };

/**
 * A Cloud block drawn by its own @k2b/ui component (budget, balance, flow) inside the same frame and states as a
 * chart: title and subtitle at once, a fixed content height, loading, empty and failure in place, stale in the
 * subtitle line.
 */
function ComponentBlock(props: Omit<ShowcaseFrameProps, "spec"> & { block: string; spec: JsonObject }): JSX.Element {
  const height = () =>
    cssLength(props.block === "budget" && props.height !== 0 ? props.height : (blockHeights[props.block] ?? props.height));
  const failed = () => props.state === "error";
  return (
    <Paper class="ui-charts-frame" data-block={props.block}>
      <header class="ui-charts-frame__header">
        <div>
          <Dynamic component={`h${props.headingLevel ?? 3}`}>{props.title}</Dynamic>
          <p role="status" class={props.state === "stale" ? "ui-charts-frame__stale" : undefined}>
            {props.state === "loading" ? "Loading …" : props.state === "stale" ? "As of 09:12 · Refresh failed" : props.subtitle}
            <Show when={props.state === "stale" && props.onRetry}>
              {" · "}
              <button type="button" class="ui-charts-link" onClick={() => props.onRetry?.()}>
                Try again
              </button>
            </Show>
          </p>
        </div>
      </header>
      <div class="ui-charts-frame__block" style={{ height: height() }} aria-busy={props.state === "loading" ? "true" : undefined}>
        <Switch>
          <Match when={props.state === "loading"}>
            <div class="ui-charts-frame__skeleton" aria-hidden="true">
              <span />
              <span />
            </div>
          </Match>
          <Match when={failed() || props.state === "empty"}>
            <p class="ui-charts-frame__inline-state" role={failed() ? "alert" : undefined}>
              <i class={failed() ? "ti ti-alert-circle" : "ti ti-chart-bar-off"} aria-hidden="true" />
              {failed() ? "The data could not be loaded." : props.empty}
              <Show when={failed() && props.onRetry}>
                <button type="button" class="ui-charts-link" onClick={() => props.onRetry?.()}>
                  Try again
                </button>
              </Show>
            </p>
          </Match>
          <Match when={true}>
            <ComponentBlockContent block={props.block} spec={props.spec} />
          </Match>
        </Switch>
      </div>
    </Paper>
  );
}

type TableRow = { key: string; cells: JsonObject };

/** Column fields a typed table (@k2b/ui with `filterRows`) reads; older builds ignore them and get formatted text. */
const typedColumnKeys = ["type", "format", "states", "max", "priority", "delta", "timeZone"] as const;
const typedTables = () => typeof Reflect.get(ui, "filterRows") === "function";

/** A cell as text: a number in the column's format, a status by its label, a missing value as a dash. */
const cellText = (column: JsonObject, value: JsonValue | undefined): string => {
  if (value === null || value === undefined) return "–";
  if (typeof value === "number") return formatNumber(value, column.format);
  const state = object(column.states) ? column.states[text(value)] : undefined;
  return object(state) && typeof state.label === "string" ? state.label : text(value);
};

/** Table columns from a description: raw values for a typed table, formatted text for an older one. */
const tableColumnsOf = (columns: JsonObject[], typed: boolean): DataTableColumn<TableRow>[] =>
  columns.map((column) => {
    const base: DataTableColumn<TableRow> = {
      id: text(column.id),
      header: text(column.label),
      value: (row: TableRow) => {
        const value = row.cells[text(column.id)];
        if (typed) return value ?? null;
        return cellText(column, value);
      },
      sortable: true,
      align: ["number", "amount", "bar", "flow", "delta"].includes(text(column.type)) ? "right" : "left",
    };
    if (!typed) return base;
    // The table draws every type itself, money with its direction (flow) included.
    return Object.assign(base, Object.fromEntries(typedColumnKeys.filter((key) => key in column).map((key) => [key, column[key]])));
  });

/**
 * `{ block: "table", columns, rows, search?, groupBy? }`: search and grouping sit in the frame's head, headers sort,
 * and the table reaches the frame's edges below. The frame always holds every row whole: a hidden copy of the full
 * table keeps its height, so loading, empty, failure and a narrowing search never move anything and never cut a row.
 */
function TableBlock(props: ShowcaseFrameProps & { spec: JsonObject }): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [sort, setSort] = createSignal<DataTableSort | null>(null);
  const [group, setGroup] = createSignal("");
  const typed = typedTables();
  const columns = () => list(props.spec.columns).filter(object);
  const groups = () => (typed ? list(props.spec.groupBy).filter(object) : []);
  const cell = (column: JsonObject, row: TableRow): string => cellText(column, row.cells[text(column.id)]);
  const allRows = (): TableRow[] =>
    list(props.spec.rows)
      .filter(object)
      .map((cells, index) => ({ key: String(index), cells }));
  const rows = createMemo((): TableRow[] => {
    const needle = query().trim().toLocaleLowerCase("en");
    const found = needle
      ? allRows().filter((row) => columns().some((column) => cell(column, row).toLocaleLowerCase("en").includes(needle)))
      : allRows();
    const order = sort();
    if (!order) return found;
    const collator = new Intl.Collator("en", { numeric: true });
    return [...found].sort((a, b) => {
      const left = a.cells[order.key],
        right = b.cells[order.key];
      if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
      if (right === null || right === undefined) return -1;
      const comparison = typeof left === "number" && typeof right === "number" ? left - right : collator.compare(text(left), text(right));
      return order.direction === "asc" ? comparison : -comparison;
    });
  });
  const tableColumns = () => tableColumnsOf(columns(), typed);
  const grouping = (): Record<string, unknown> => (typed && group() ? { groupBy: group() } : {});
  const failed = () => props.state === "error";
  const showing = () => withRows(props.state) && rows().length > 0;
  return (
    <Paper class="ui-charts-frame" data-block="table">
      <header class="ui-charts-frame__header" data-search={props.spec.search === true ? "true" : undefined}>
        <div>
          <Dynamic component={`h${props.headingLevel ?? 3}`}>{props.title}</Dynamic>
          <p role="status" class={props.state === "stale" ? "ui-charts-frame__stale" : undefined}>
            {props.state === "loading" ? "Loading …" : props.state === "stale" ? "As of 09:12 · Refresh failed" : props.subtitle}
            <Show when={props.state === "stale" && props.onRetry}>
              {" · "}
              <button type="button" class="ui-charts-link" onClick={() => props.onRetry?.()}>
                Try again
              </button>
            </Show>
          </p>
        </div>
        <div class="ui-charts-frame__tools">
          <Show when={props.spec.search === true}>
            <TextInput
              class="ui-charts-frame__search"
              type="search"
              icon="ti ti-search"
              aria-label={`Search ${props.title}`}
              placeholder="Search"
              value={query()}
              onValueChange={setQuery}
              disabled={!withRows(props.state)}
            />
          </Show>
          <Show when={groups().length}>
            <SelectChip<string>
              stableWidth
              aria-label={`Group ${props.title}`}
              value={group()}
              onValueChange={setGroup}
              disabled={!withRows(props.state)}
              options={[
                { value: "", label: "Not grouped" },
                ...groups().map((entry) => ({ value: text(entry.id), label: `By ${text(entry.label).toLocaleLowerCase("en")}` })),
              ]}
            />
          </Show>
        </div>
      </header>
      <div class="ui-charts-frame__table" aria-busy={props.state === "loading" ? "true" : undefined}>
        {/* Every row, hidden: the frame's height in every state and for every search. */}
        <div class="ui-charts-frame__sizer" aria-hidden="true" inert>
          <DataTable<TableRow> ariaLabel={props.title} surface="plain" rows={allRows()} columns={tableColumns()} {...grouping()} />
        </div>
        <Show
          when={showing()}
          fallback={
            <div class="k2b-chart-explorer__state" data-state={props.state} role={failed() ? "alert" : undefined}>
              <Show when={props.state !== "loading"}>
                <span class="k2b-chart-explorer__state-icon" aria-hidden="true">
                  <i class={failed() ? "ti ti-alert-circle" : "ti ti-table-off"} />
                </span>
              </Show>
              <p>
                {failed()
                  ? "The data could not be loaded."
                  : props.state === "loading"
                    ? ""
                    : query()
                      ? `No row contains “${query()}”.`
                      : props.empty}
              </p>
              <Show when={failed() && props.onRetry}>
                <Button variant="secondary" size="sm" onClick={() => props.onRetry?.()}>
                  <i class="ti ti-refresh" aria-hidden="true" />
                  Try again
                </Button>
              </Show>
              <Show when={!failed() && query() && withRows(props.state)}>
                <Button variant="secondary" size="sm" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              </Show>
            </div>
          }
        >
          <div class="ui-charts-frame__rows">
            <DataTable<TableRow>
              ariaLabel={props.title}
              surface="plain"
              rows={rows()}
              getRowId={(row) => row.key}
              sort={sort()}
              onSortChange={setSort}
              columns={tableColumns()}
              {...grouping()}
            />
          </div>
        </Show>
      </div>
    </Paper>
  );
}
