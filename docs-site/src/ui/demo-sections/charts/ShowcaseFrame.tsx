import { Chart, ChartExplorer, type ChartFrameRequest, ChartSnapshotView, DataTable, Paper, StatCell, StatGrid } from "@k2b/ui";
import { createMemo, For, type JSX, Match, Show, Switch } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { JsonValue } from "./examples/types";
import { formatNumber } from "./format";
import { resolveDrawing, type ShowcaseRow, specSubtitle, specTitle } from "./resolve";

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
  /** Content height in pixels. */
  height: number;
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
  const height = () => `${props.height}px`;
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
        {(live) => explorer(live().rows, () => <Chart {...live().props} style={{ height: "100%" }} />)}
      </Match>
      <Match when={drawing().mode === "block" && (drawing() as Extract<ReturnType<typeof resolveDrawing>, { mode: "block" }>)}>
        {(block) => (
          <Show
            when={block().block === "stats"}
            fallback={<TableBlock {...props} spec={block().spec} title={title()} subtitle={subtitle()} />}
          >
            <StatsBlock spec={block().spec} state={props.state} onRetry={props.onRetry} />
          </Show>
        )}
      </Match>
      <Match when={drawing().mode === "slot" && (drawing() as Extract<ReturnType<typeof resolveDrawing>, { mode: "slot" }>)}>
        {(slot) => (
          <Paper class="ui-charts-frame">
            <header class="ui-charts-frame__header">
              <Dynamic component={`h${props.headingLevel ?? 3}`}>{title()}</Dynamic>
              <Show when={subtitle()}>
                <p>{subtitle()}</p>
              </Show>
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

/** `{ block: "stats", items: [...] }`: one framed tile per key figure (F2), with the frame states in each tile. */
function StatsBlock(props: { spec: JsonObject; state: ShowcaseState; onRetry?: () => void }): JSX.Element {
  const items = () => list(props.spec.items).filter(object);
  return (
    <div class="ui-charts-tiles" data-count={items().length}>
      <For each={items()}>
        {(item) => {
          const delta = () => (object(item.delta) ? item.delta : undefined);
          const deltaText = () => {
            const change = delta();
            if (!change || typeof change.value !== "number") return undefined;
            const points = change.unit === "points";
            const sign = change.value > 0 ? "+" : change.value < 0 ? "−" : "±";
            const magnitude = Math.abs(change.value) * 100;
            return `${sign}${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(magnitude)}${points ? " pts" : " %"}`;
          };
          const tone = () => {
            const change = delta();
            if (!change || typeof change.value !== "number" || !change.better || change.value === 0) return "zinc" as const;
            return change.value > 0 === (change.better === "up") ? ("emerald" as const) : ("red" as const);
          };
          const compare = () =>
            object(item.compare) && typeof item.compare.value === "number"
              ? `${text(item.compare.label)} ${formatNumber(item.compare.value, item.format)}`
              : text(item.note) || undefined;
          return (
            <StatGrid columns={1} class="ui-charts-tile">
              <Switch>
                <Match when={props.state === "loading"}>
                  <div class="ui-charts-tile__state" role="status" aria-label={`${text(item.label)}: loading`}>
                    <span class="ui-charts-tile__label">{text(item.label)}</span>
                    <span class="ui-charts-tile__skeleton" />
                    <span class="ui-charts-tile__skeleton" data-size="sm" />
                  </div>
                </Match>
                <Match when={props.state === "error"}>
                  <div class="ui-charts-tile__state" role="alert">
                    <span class="ui-charts-tile__label">{text(item.label)}</span>
                    <span class="ui-charts-tile__error">
                      <i class="ti ti-alert-circle" aria-hidden="true" /> Not loaded
                    </span>
                    <button type="button" class="ui-charts-link" onClick={() => props.onRetry?.()}>
                      Try again
                    </button>
                  </div>
                </Match>
                <Match when={props.state === "empty"}>
                  <StatCell label={text(item.label)} value="–" sub="Nothing counted in this period" />
                </Match>
                <Match when={true}>
                  <StatCell
                    label={text(item.label)}
                    value={typeof item.value === "number" ? formatNumber(item.value, item.format) : text(item.value)}
                    sub={props.state === "stale" ? "As of 09:12 · not current" : compare()}
                    trend={list(item.trend).filter((value): value is number => typeof value === "number")}
                    accent={
                      deltaText()
                        ? {
                            tone: tone(),
                            icon: (delta()?.value as number) >= 0 ? "ti ti-trending-up" : "ti ti-trending-down",
                            text: deltaText(),
                          }
                        : undefined
                    }
                  />
                </Match>
              </Switch>
            </StatGrid>
          );
        }}
      </For>
    </div>
  );
}

type TableRow = { key: string; cells: JsonObject };

/** `{ block: "table", columns, rows }`: the table reaches the frame's edges below its header. */
function TableBlock(props: ShowcaseFrameProps & { spec: JsonObject }): JSX.Element {
  const columns = () => list(props.spec.columns).filter(object);
  const rows = (): TableRow[] =>
    list(props.spec.rows)
      .filter(object)
      .map((cells, index) => ({ key: String(index), cells }));
  const cell = (column: JsonObject, row: TableRow): string => {
    const value = row.cells[text(column.id)];
    if (value === null || value === undefined) return "–";
    if (typeof value === "number") return formatNumber(value, column.format);
    return text(value);
  };
  return (
    <Paper class="ui-charts-frame" data-block="table">
      <header class="ui-charts-frame__header">
        <Dynamic component={`h${props.headingLevel ?? 3}`}>{props.title}</Dynamic>
        <Show when={props.subtitle}>
          <p>{props.state === "stale" ? "As of 09:12 · Refresh failed" : props.subtitle}</p>
        </Show>
      </header>
      <div class="ui-charts-frame__table" style={{ height: `${props.height}px` }}>
        <Show
          when={withRows(props.state)}
          fallback={
            <div class="k2b-chart-explorer__state" data-state={props.state}>
              <Show
                when={props.state === "loading"}
                fallback={<p>{props.state === "error" ? "The data could not be loaded." : props.empty}</p>}
              >
                <p>Loading …</p>
              </Show>
            </div>
          }
        >
          <DataTable<TableRow>
            ariaLabel={props.title}
            surface="plain"
            fillHeight
            rows={rows()}
            getRowId={(row) => row.key}
            columns={columns().map((column) => ({
              id: text(column.id),
              header: text(column.label),
              value: (row: TableRow) => cell(column, row),
              align: column.type === "number" || column.type === "amount" ? "right" : "left",
            }))}
          />
        </Show>
      </div>
    </Paper>
  );
}
