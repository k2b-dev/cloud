import {
  Button,
  createDataTableView,
  DashboardFrame,
  type DashboardFrameState,
  type DashboardWidth,
  DataTable,
  SelectChip,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createMemo, For, type JSX, Show } from "solid-js";
import {
  type DescriptionObject,
  type DescriptionTableRow,
  descriptionList,
  descriptionObject,
  descriptionTable,
  descriptionText,
} from "./description-table";
import { descriptionMessages } from "./messages";

/**
 * Tables of a portable description, without chart code: `DescriptionPanel` draws them in a dashboard, and capability
 * views draw them in the conversation, where they load on demand. Key figures live in `./description-stats`.
 */

export { StatsBlock } from "./description-stats";
export {
  type DescriptionObject,
  type DescriptionTableRow,
  descriptionList,
  descriptionObject,
  descriptionTableColumns,
  descriptionText,
} from "./description-table";
export const descriptionLength = (value: number | string) => (typeof value === "number" ? `${value}px` : value);
export const descriptionWithContent = (state: DashboardFrameState) => state === "ready" || state === "stale";

const useMessages = () => {
  const locale = useLocale();
  return () => descriptionMessages.resolve([locale()]).t;
};

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
  const table = createMemo(() => descriptionTable(props.spec));
  const groups = () => descriptionList(props.spec.groupBy).filter(descriptionObject);
  const allRows = () => table().rows;
  const tableColumns = () => table().columns;
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
