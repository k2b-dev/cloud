import {
  Chart,
  ChartExplorer,
  type ChartFrameRequest,
  ChartSnapshotView,
  DashboardFrame,
  type DashboardFrameState,
  type DashboardWidth,
  DataTable,
  DescriptionList,
  useLocale,
} from "@k2b/ui";
import { createMemo, For, type JSX, Match, Show, Switch } from "solid-js";
import { Dynamic } from "solid-js/web";
import { cloudAiDetailsRows, parseCloudAiView } from "../ai/view-block";
import { type DescriptionTableRow, descriptionTableColumns, StatsBlock, TableBlock } from "./description-blocks";
import type { DescriptionJson as JsonValue } from "./json";
import { descriptionMessages } from "./messages";
import { type DescriptionRow, descriptionBlockComponent, descriptionSubtitle, descriptionTitle, resolveDescription } from "./resolve";

const requests: Record<DashboardFrameState, ChartFrameRequest> = {
  ready: { status: "idle" },
  loading: { status: "loading" },
  empty: { status: "idle" },
  error: { status: "error" },
  stale: { status: "error" },
};
const withContent = (state: DashboardFrameState) => state === "ready" || state === "stale";
const cssLength = (value: number | string) => (typeof value === "number" ? `${value}px` : value);

type JsonObject = { [key: string]: JsonValue };
const object = (value: JsonValue | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);
const text = (value: JsonValue | undefined) =>
  typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);

const useMessages = () => {
  const locale = useLocale();
  return () => descriptionMessages.resolve([locale()]).t;
};

export type DescriptionPanelProps = {
  /** A portable description: a chart `{ kind, … }`, a Cloud block `{ block, … }`, or a list of flow amounts. */
  spec: JsonValue;
  /** Title for descriptions without one, such as map props. */
  title: string;
  subtitle?: string;
  /** Defaults to `ready`. */
  state?: DashboardFrameState;
  /**
   * Content height: pixels, or a CSS length such as a variable the dashboard grid sets per width. A table scrolls
   * inside it; `0` gives a table the height of its rows.
   */
  height: number | string;
  view?: "chart" | "table";
  onViewChange?: (view: "chart" | "table") => void;
  onRetry?: () => void;
  /** The empty sentence; defaults to "Nothing to show for this period." */
  empty?: string;
  /** When the shown data was read, formatted by the host ("09:12"); stale notes name it. */
  asOf?: string;
  /** What the frame shows for a description this build cannot draw; defaults to a short notice. */
  slot?: (slot: { kind: string; reason: string }) => JSX.Element;
  headingLevel?: 2 | 3 | 4;
  /** Share of a `DashboardSection`'s six columns; the panel is the grid cell itself. Key figures always span the row. */
  width?: DashboardWidth;
};

/**
 * One framed dashboard panel for a portable description: a chart `{ kind }` through `ChartExplorer`, key figures as
 * `StatGrid` tiles, a table with search and grouping in its head, or a money block, with the same states in the same
 * place. The frame, grid and states come from `@k2b/ui`; this adapter only maps Cloud's descriptions onto them.
 */
export function DescriptionPanel(props: DescriptionPanelProps): JSX.Element {
  const locale = useLocale();
  const t = useMessages();
  const drawing = createMemo(() => resolveDescription(props.spec, locale()));
  const state = () => props.state ?? "ready";
  const title = () => descriptionTitle(props.spec, props.title);
  const subtitle = () => descriptionSubtitle(props.spec, props.subtitle);
  const height = () => cssLength(props.height);
  const empty = () => props.empty ?? t().nothingToShow;
  // Rows, columns and legend are accessors: a new description of the same kind updates the table and Copy data too.
  const explorer = (
    rows: () => DescriptionRow[],
    columns: () => Parameters<typeof ChartExplorer<DescriptionRow>>[0]["columns"],
    chart: () => JSX.Element,
    legend?: () => Parameters<typeof ChartExplorer<DescriptionRow>>[0]["legend"],
  ) => (
    <DashboardFrame width={props.width}>
      <ChartExplorer<DescriptionRow>
        title={title()}
        headingLevel={props.headingLevel ?? 3}
        description={subtitle()}
        height={height()}
        inset="1rem"
        renderDetails={false}
        view={props.view}
        onViewChange={props.onViewChange}
        request={requests[state()]}
        asOf={props.asOf}
        onRetry={props.onRetry}
        empty={empty()}
        data={{ rows: withContent(state()) ? rows() : [] }}
        columns={columns()}
        legend={legend?.()}
      >
        {chart()}
      </ChartExplorer>
    </DashboardFrame>
  );
  return (
    <Switch>
      <Match when={drawing().mode === "snapshot" && (drawing() as Extract<ReturnType<typeof resolveDescription>, { mode: "snapshot" }>)}>
        {(snapshot) =>
          explorer(
            () => snapshot().rows,
            () => snapshot().columns,
            () => (
              <ChartSnapshotView
                snapshot={snapshot().snapshot}
                selectedKey={null}
                onSelect={() => {}}
                style={snapshot().legend.length ? undefined : { height: "100%" }}
              />
            ),
            () => snapshot().legend,
          )
        }
      </Match>
      <Match when={drawing().mode === "live" && (drawing() as Extract<ReturnType<typeof resolveDescription>, { mode: "live" }>)}>
        {(live) =>
          explorer(
            () => live().rows,
            () => live().columns,
            () => <Chart {...live().props} style={{ height: "100%" }} />,
          )
        }
      </Match>
      <Match when={drawing().mode === "empty" && (drawing() as Extract<ReturnType<typeof resolveDescription>, { mode: "empty" }>)}>
        {(nothing) => (
          // A chart without values: the same explorer frame, head and height as the drawn chart, with its empty sentence.
          <DashboardFrame width={props.width}>
            <ChartExplorer<DescriptionRow>
              title={title()}
              headingLevel={props.headingLevel ?? 3}
              description={subtitle()}
              height={height()}
              inset="1rem"
              renderDetails={false}
              request={requests[state()]}
              asOf={props.asOf}
              onRetry={props.onRetry}
              empty={props.empty ?? nothing().empty ?? t().nothingToShow}
              data={{ rows: [] }}
              // The explorer needs one column; without rows Copy data and the table stay unavailable.
              columns={[{ id: "value", label: title(), value: () => "" }]}
            />
          </DashboardFrame>
        )}
      </Match>
      <Match when={drawing().mode === "block" && (drawing() as Extract<ReturnType<typeof resolveDescription>, { mode: "block" }>)}>
        {(block) => (
          <Switch
            fallback={
              <ComponentBlock {...props} state={state()} block={block().block} spec={block().spec} title={title()} subtitle={subtitle()} />
            }
          >
            <Match when={block().block === "stats"}>
              <StatsBlock spec={block().spec} state={state()} asOf={props.asOf} onRetry={props.onRetry} />
            </Match>
            <Match when={block().block === "details"}>
              <DetailsBlock {...props} state={state()} spec={block().spec} title={title()} subtitle={subtitle()} />
            </Match>
            <Match when={block().block === "table"}>
              <TableBlock {...props} state={state()} spec={block().spec} title={title()} subtitle={subtitle()} />
            </Match>
          </Switch>
        )}
      </Match>
      <Match when={drawing().mode === "slot" && (drawing() as Extract<ReturnType<typeof resolveDescription>, { mode: "slot" }>)}>
        {(slot) => (
          <DashboardFrame title={title()} subtitle={subtitle()} headingLevel={props.headingLevel} width={props.width}>
            {props.slot ? (
              props.slot(slot())
            ) : (
              <div style={{ height: height() }}>
                <p>{t().cannotShow}</p>
              </div>
            )}
          </DashboardFrame>
        )}
      </Match>
    </Switch>
  );
}

/**
 * `{ block: "details", items: [{ label, type, value, format? }] }`: the fields of one record, in the form and with the
 * formatting of Chat's details view. The body keeps the panel's height in every state; more fields scroll inside it.
 * A reference shows its title; opening it is the host's.
 */
function DetailsBlock(
  props: Omit<DescriptionPanelProps, "spec" | "state"> & { state: DashboardFrameState; spec: JsonObject },
): JSX.Element {
  const locale = useLocale();
  const t = useMessages();
  const view = () => {
    const { block: _block, ...rest } = props.spec;
    const parsed = parseCloudAiView({ ...rest, view: "details" });
    return parsed?.view === "details" ? parsed : undefined;
  };
  const rows = () => {
    const current = view();
    return current ? cloudAiDetailsRows(current, locale()) : [];
  };
  return (
    <DashboardFrame
      title={props.title}
      subtitle={props.subtitle}
      headingLevel={props.headingLevel}
      width={props.width}
      state={props.state}
      asOf={props.asOf}
      onRetry={props.onRetry}
      empty={props.empty ?? t().nothingToShow}
      emptyIcon="ti ti-list-details"
      height={cssLength(props.height)}
    >
      <DescriptionList layout="rows" items={rows().map((row) => ({ term: row.label, description: row.text || "—" }))} />
    </DashboardFrame>
  );
}

/** A block's own @k2b/ui component with the description's props (flow: one amount per entry). */
function ComponentBlockContent(props: { block: string; spec: JsonObject }): JSX.Element {
  const values = () => Object.fromEntries(Object.entries(props.spec).filter(([key]) => !["block", "title", "subtitle"].includes(key)));
  return (
    <Show when={descriptionBlockComponent(props.block)}>
      {(draw) => (
        <Show when={props.block === "flow"} fallback={<Dynamic component={draw()} {...values()} />}>
          <div style={{ display: "flex", "flex-wrap": "wrap", gap: "0.5rem 1.25rem", "align-items": "center" }}>
            <For each={list(props.spec.items).filter(object)}>
              {(item) => <Dynamic component={draw()} {...Object.fromEntries(Object.entries(item).filter(([key]) => key !== "type"))} />}
            </For>
          </div>
        </Show>
      )}
    </Show>
  );
}

type TableRow = DescriptionTableRow;
const tableColumnsOf = descriptionTableColumns;

/**
 * A block as an overview card shows it: its content without a frame, the first key figure or the first rows and
 * columns of a table, so the card stays one surface.
 */
export function DescriptionBlockPreview(props: { block: string; spec: JsonObject }): JSX.Element {
  const t = useMessages();
  const columns = () => list(props.spec.columns).filter(object).slice(0, 3);
  const rows = (): TableRow[] =>
    list(props.spec.rows)
      .filter(object)
      .slice(0, 4)
      .map((cells, index) => ({ key: String(index), cells }));
  return (
    <Switch fallback={<ComponentBlockContent block={props.block} spec={props.spec} />}>
      <Match when={props.block === "stats"}>
        <StatsBlock spec={{ ...props.spec, items: list(props.spec.items).slice(0, 1) }} state="ready" />
      </Match>
      <Match when={props.block === "table"}>
        <DataTable<TableRow>
          ariaLabel={text(props.spec.title) || t().table}
          surface="plain"
          density="compact"
          rows={rows()}
          getRowId={(row) => row.key}
          columns={tableColumnsOf(columns())}
        />
      </Match>
    </Switch>
  );
}

/** Content heights of the component blocks when the description names none. */
const blockHeights: Record<string, number> = { balance: 56, flow: 72, budget: 240 };

/**
 * A Cloud block drawn by its own @k2b/ui component (budget, balance, flow) inside the same frame and states as a
 * chart: a fixed content height, loading, empty and failure as one quiet line, stale in the subtitle line.
 */
function ComponentBlock(
  props: Omit<DescriptionPanelProps, "spec" | "state"> & { state: DashboardFrameState; block: string; spec: JsonObject },
): JSX.Element {
  const height = () =>
    cssLength(props.block === "budget" && props.height !== 0 ? props.height : (blockHeights[props.block] ?? props.height));
  const t = useMessages();
  return (
    <DashboardFrame
      title={props.title}
      subtitle={props.subtitle}
      headingLevel={props.headingLevel}
      state={props.state}
      asOf={props.asOf}
      onRetry={props.onRetry}
      empty={props.empty ?? t().nothingToShow}
      height={height()}
      width={props.width}
      compact
    >
      <ComponentBlockContent block={props.block} spec={props.spec} />
    </DashboardFrame>
  );
}
