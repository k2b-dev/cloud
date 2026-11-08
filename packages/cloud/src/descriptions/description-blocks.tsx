import {
  Button,
  createDataTableView,
  DashboardFrame,
  type DashboardFrameState,
  type DashboardWidth,
  DataTable,
  type DataTableColumn,
  SelectChip,
  StatCell,
  StatGrid,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createMemo, For, type JSX, Show } from "solid-js";
import { formatDescriptionNumber } from "./format";
import type { DescriptionJson as JsonValue } from "./json";
import { descriptionMessages } from "./messages";

/**
 * Key figures and tables of a portable description, without chart code: `DescriptionPanel` draws them in a dashboard,
 * and capability views draw them in the conversation, so a table looks the same in both and a view that shows no chart
 * loads no chart library.
 */

export type DescriptionObject = { [key: string]: JsonValue };
export const descriptionObject = (value: JsonValue | undefined): value is DescriptionObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const descriptionList = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);
export const descriptionText = (value: JsonValue | undefined) =>
  typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
export const descriptionLength = (value: number | string) => (typeof value === "number" ? `${value}px` : value);
export const descriptionWithContent = (state: DashboardFrameState) => state === "ready" || state === "stale";

const useMessages = () => {
  const locale = useLocale();
  return () => descriptionMessages.resolve([locale()]).t;
};

/**
 * `{ block: "stats", items: [...] }`: single key-figure tiles. Every tile has the states in its own place: loading
 * placeholders, "Not loaded" with Try again, the empty dash, and a stale note under the figure.
 */
export function StatsBlock(props: {
  spec: DescriptionObject;
  state: DashboardFrameState;
  asOf?: string;
  onRetry?: () => void;
}): JSX.Element {
  const locale = useLocale();
  const t = useMessages();
  const items = () => descriptionList(props.spec.items).filter(descriptionObject);
  // The icon tones of a key figure, and the money tones `in` and `out` of `FlowAmount`.
  const tones = ["blue", "emerald", "amber", "red", "zinc", "in", "out"] as const;
  const tone = (value: JsonValue | undefined) => tones.find((entry) => entry === value);
  return (
    <StatGrid columns={Math.min(6, Math.max(1, items().length)) as 1 | 2 | 3 | 4 | 5 | 6}>
      <For each={items()}>
        {(item) => {
          const format = (value: number) => formatDescriptionNumber(value, item.format, locale());
          const delta = () => {
            const change = descriptionObject(item.delta) ? item.delta : undefined;
            if (!change || typeof change.value !== "number") return undefined;
            return {
              value: change.value,
              ...(change.unit === "points" ? { unit: "points" as const } : {}),
              ...(change.better === "up" ? { better: "up" as const } : change.better === "down" ? { better: "down" as const } : {}),
            };
          };
          const compare = () =>
            descriptionObject(item.compare) && typeof item.compare.value === "number"
              ? { label: descriptionText(item.compare.label), value: format(item.compare.value) }
              : undefined;
          const empty = () => props.state === "empty";
          return (
            <StatCell
              label={descriptionText(item.label)}
              icon={typeof item.icon === "string" ? item.icon : undefined}
              tone={tone(item.tone)}
              value={empty() ? null : typeof item.value === "number" ? format(item.value) : descriptionText(item.value)}
              sub={empty() ? t().nothingCounted : compare() ? undefined : descriptionText(item.note) || undefined}
              delta={empty() ? undefined : delta()}
              compare={empty() ? undefined : compare()}
              trend={descriptionList(item.trend).filter((value): value is number => typeof value === "number")}
              status={props.state === "loading" ? "loading" : props.state === "error" ? "error" : undefined}
              stale={props.state === "stale" ? (props.asOf ? t().asOfNotCurrent({ asOf: props.asOf }) : t().notCurrent) : undefined}
              onRetry={props.onRetry}
            />
          );
        }}
      </For>
    </StatGrid>
  );
}

export type DescriptionTableRow = { key: string; cells: DescriptionObject };

/** Table columns from a description: types, formats, states and priorities pass as they are to the typed table. */
export const descriptionTableColumns = (columns: DescriptionObject[]): DataTableColumn<DescriptionTableRow>[] =>
  columns.map((column) =>
    Object.assign(
      {
        id: descriptionText(column.id),
        header: descriptionText(column.label),
        value: (row: DescriptionTableRow) => row.cells[descriptionText(column.id)] ?? null,
        sortable: true,
        align: ["number", "amount", "bar", "flow", "delta"].includes(descriptionText(column.type)) ? ("right" as const) : ("left" as const),
      },
      Object.fromEntries(typedColumnKeys.filter((key) => key in column).map((key) => [key, column[key]])),
    ),
  );
/** Column fields the typed table reads. */
const typedColumnKeys = ["type", "format", "states", "max", "priority", "delta", "timeZone"] as const;

export type TableBlockProps = {
  spec: DescriptionObject;
  state: DashboardFrameState;
  title: string;
  subtitle?: string;
  /** Content height: pixels or a CSS length; `0` gives the table the height of its rows. */
  height: number | string;
  headingLevel?: 2 | 3 | 4;
  width?: DashboardWidth;
  asOf?: string;
  onRetry?: () => void;
  empty?: string;
};

/**
 * `{ block: "table", columns, rows, search?, groupBy? }`: search and grouping sit in the frame's head, headers sort,
 * and the table reaches the frame's edges below. Search and order read what a typed column shows: a date by its time
 * and its shown text, a status by its label. A hidden copy of the full table keeps the frame's height, so loading,
 * empty, failure and a narrowing search never move anything and never cut a row; with a `height` the table scrolls
 * inside it instead.
 */
export function TableBlock(props: TableBlockProps): JSX.Element {
  const locale = useLocale();
  const t = useMessages();
  const columns = () => descriptionList(props.spec.columns).filter(descriptionObject);
  const groups = () => descriptionList(props.spec.groupBy).filter(descriptionObject);
  const allRows = (): DescriptionTableRow[] =>
    descriptionList(props.spec.rows)
      .filter(descriptionObject)
      .map((cells, index) => ({ key: String(index), cells }));
  const tableColumns = createMemo(() => descriptionTableColumns(columns()));
  const view = createDataTableView<DescriptionTableRow>({ rows: allRows, columns: tableColumns });
  const query = view.query,
    setQuery = view.setQuery,
    rows = view.rows;
  const group = () => view.groupBy() ?? "";
  const grouping = (): { groupBy?: string } => (group() ? { groupBy: group() } : {});
  // A search without a match is the empty state with its own sentence and a way back.
  const noMatch = () => descriptionWithContent(props.state) && query() !== "" && rows().length === 0;
  // The read's state stays in the head (a stale note keeps its Try again); a table without rows to show says why below.
  const nothing = () => noMatch() || (descriptionWithContent(props.state) && !allRows().length);
  return (
    <DashboardFrame
      title={props.title}
      subtitle={props.subtitle}
      headingLevel={props.headingLevel}
      width={props.width}
      state={props.state}
      emptyContent={nothing()}
      asOf={props.asOf}
      onRetry={props.onRetry}
      empty={noMatch() ? t().noRowContains({ query: query() }) : (props.empty ?? t().nothingToShow)}
      emptyIcon="ti ti-table-off"
      height={props.height === 0 ? undefined : descriptionLength(props.height)}
      emptyAction={
        <Show when={noMatch()}>
          <Button variant="secondary" size="sm" onClick={() => setQuery("")}>
            {t().clearSearch}
          </Button>
        </Show>
      }
      tools={
        <>
          <Show when={props.spec.search === true}>
            <TextInput
              type="search"
              icon="ti ti-search"
              aria-label={t().searchIn({ title: props.title })}
              placeholder={t().search}
              value={query()}
              onValueChange={setQuery}
              disabled={!descriptionWithContent(props.state)}
            />
          </Show>
          <Show when={groups().length}>
            <SelectChip<string>
              stableWidth
              aria-label={t().groupIn({ title: props.title })}
              value={group()}
              onValueChange={(id) => view.setGroupBy(id || null)}
              disabled={!descriptionWithContent(props.state)}
              options={[
                { value: "", label: t().notGrouped },
                ...groups().map((entry) => ({
                  value: descriptionText(entry.id),
                  label: t().groupBy({ label: descriptionText(entry.label).toLocaleLowerCase(locale()) }),
                })),
              ]}
            />
          </Show>
        </>
      }
      reserve={
        <DataTable<DescriptionTableRow> ariaLabel={props.title} surface="plain" rows={allRows()} columns={tableColumns()} {...grouping()} />
      }
    >
      <DataTable<DescriptionTableRow>
        ariaLabel={props.title}
        surface="plain"
        rows={rows()}
        getRowId={(row) => row.key}
        sort={view.sort()}
        onSortChange={view.setSort}
        columns={tableColumns()}
        {...grouping()}
      />
    </DashboardFrame>
  );
}
