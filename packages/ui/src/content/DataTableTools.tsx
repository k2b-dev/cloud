import { type Accessor, createMemo, createSignal, type JSX, Show } from "solid-js";
import Select from "../inputs/Select";
import TextInput from "../inputs/TextInput";
import { useLocale } from "../intl/locale";
import type { DataTableColumn, DataTableSort } from "./DataTable";
import { filterRows, sortRows } from "./data-table-columns";
import { useDataTableMessages } from "./data-table-messages";

export type DataTableViewOptions<T> = {
  rows: Accessor<readonly T[]>;
  columns: Accessor<readonly DataTableColumn<T>[]>;
  sort?: DataTableSort | null;
  groupBy?: string | null;
};

export type DataTableView<T> = {
  query: Accessor<string>;
  setQuery: (query: string) => void;
  sort: Accessor<DataTableSort | null>;
  setSort: (sort: DataTableSort | null) => void;
  groupBy: Accessor<string | null>;
  setGroupBy: (id: string | null) => void;
  /** The rows that match the query, in the chosen order. */
  rows: Accessor<T[]>;
};

/**
 * The state of a table a reader searches, sorts and groups in the browser: pass `rows()` and the state to `DataTable`
 * and the setters to `DataTableTools` and `onSortChange`. Search and order read the shown text of typed columns.
 */
export function createDataTableView<T>(options: DataTableViewOptions<T>): DataTableView<T> {
  const locale = useLocale();
  const [query, setQuery] = createSignal("");
  const [sort, setSort] = createSignal<DataTableSort | null>(options.sort ?? null);
  const [groupBy, setGroupBy] = createSignal<string | null>(options.groupBy ?? null);
  const rows = createMemo(() =>
    sortRows(filterRows(options.rows(), options.columns(), query(), locale()), options.columns(), sort(), locale()),
  );
  return { query, setQuery, sort, setSort, groupBy, setGroupBy, rows };
}

export type DataTableToolsProps = {
  /** The table's name, for the search field's accessible name ("Search Campaigns"). */
  label: string;
  query?: string;
  onQueryChange?: (query: string) => void;
  /** Columns the reader may group by; without them no group choice shows. */
  groups?: readonly { id: string; label: string }[];
  groupBy?: string | null;
  onGroupByChange?: (id: string | null) => void;
  /** While the table has no rows to work on, such as during loading or after a failure. */
  disabled?: boolean;
  class?: string;
};

/**
 * Search and group choice for the head of the frame that holds a table, never inside the table. Below a frame width
 * of 560 px the tools take their own line under the title and the search field fills it.
 */
export function DataTableTools(props: DataTableToolsProps): JSX.Element {
  const t = useDataTableMessages();
  return (
    <div class={props.class ? `k2b-data-table-tools ${props.class}` : "k2b-data-table-tools"}>
      <Show when={props.onQueryChange}>
        <TextInput
          class="k2b-data-table-tools__search"
          type="search"
          variant="compact"
          icon="ti ti-search"
          placeholder={t().search}
          aria-label={t().searchTable({ label: props.label })}
          value={props.query ?? ""}
          onValueChange={(value) => props.onQueryChange?.(value)}
          clearable
          clearLabel={t().clearSearch}
          disabled={props.disabled}
        />
      </Show>
      <Show when={props.groups?.length && props.onGroupByChange}>
        <Select
          class="k2b-data-table-tools__group"
          aria-label={t().groupRows}
          value={props.groupBy ?? ""}
          onValueChange={(value) => props.onGroupByChange?.(value || null)}
          options={[
            { id: "", label: t().notGrouped },
            ...(props.groups ?? []).map((group) => ({ id: group.id, label: t().groupedBy({ label: group.label }) })),
          ]}
          disabled={props.disabled}
        />
      </Show>
    </div>
  );
}
