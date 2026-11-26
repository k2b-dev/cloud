import type { DateContext } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Button, Canvas, Dialog, Section } from "@k2b/ui/v2";
import { createEffect, createSignal, on, untrack } from "solid-js";
import type { PublicField as Field } from "../../../api/public-dto";
import type { RecordQuery } from "../../../contracts";
import FilterPanel, { blankLeaf, type FilterLeaf, isFilterLeafComplete } from "../toolbar/FilterPanel";
import SortPanel, { isSortRowComplete, type SortRow } from "../toolbar/SortPanel";
import { recordsScreenMessages } from "./screen-messages";
import type { ToolbarQueryPatch } from "./toolbar-query";

export type RecordsQueryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fields: Field[];
  filter: FilterLeaf[];
  sort: SortRow[];
  /** The rest of the query the dialog keeps as it is. */
  groupBy: RecordQuery["groupBy"];
  aggregations: RecordQuery["aggregations"];
  relationLabels: Record<string, string>;
  dateConfig?: DateContext;
  /** Each complete change applies at once, as before; the records page writes the address. */
  onCommit: (patch: ToolbarQueryPatch) => void;
  onClear: () => void;
};

/**
 * The filters and the sort of a table on v2: rows of field, operator and value, and rows of field and direction.
 * Complete rows apply at once; a row still missing its value waits.
 */
export default function RecordsQueryDialog(props: RecordsQueryDialogProps) {
  const locale = useLocale();
  const t = () => recordsScreenMessages.resolve([locale()]).t;
  const [filter, setFilter] = createSignal<FilterLeaf[]>(props.filter);
  const [sort, setSort] = createSignal<SortRow[]>(props.sort);
  // Opening starts from the page's query; a blank row invites the first filter.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        const rows = untrack(() => props.filter);
        const blank = rows.length === 0 ? blankLeaf(props.fields) : null;
        setFilter(blank ? [blank] : rows);
        setSort(untrack(() => props.sort));
      },
    ),
  );
  const commit = () => {
    const leaves = filter().filter((leaf) => isFilterLeafComplete(leaf, props.fields));
    const order = sort().filter((row) => isSortRowComplete(row, props.fields));
    props.onCommit({
      filter: leaves.length > 0 ? { op: "AND", filters: leaves } : undefined,
      sort: order.length > 0 ? order : undefined,
      groupBy: props.groupBy,
      aggregations: props.aggregations,
    });
  };
  const changeFilter = (next: FilterLeaf[]) => {
    const before = filter().filter((leaf) => isFilterLeafComplete(leaf, props.fields));
    setFilter(next);
    const after = next.filter((leaf) => isFilterLeafComplete(leaf, props.fields));
    if (JSON.stringify(before) !== JSON.stringify(after)) commit();
  };
  const changeSort = (next: SortRow[]) => {
    setSort(next);
    commit();
  };
  return (
    <Dialog
      title={t().queryTitle}
      open={props.open}
      onOpenChange={props.onOpenChange}
      foot={
        <>
          <Button
            onClick={() => {
              setFilter([]);
              setSort([]);
              props.onClear();
            }}
          >
            {t().clearQuery}
          </Button>
          <Button variant="primary" onClick={() => props.onOpenChange(false)}>
            {t().apply}
          </Button>
        </>
      }
    >
      <Section icon="filter" title={t().filter}>
        {/* k2b-ui gap: v2 has no multi-select, date range, date-time or person picker yet (lane Y); the filter rows keep
            their v1 editors here so every operator and value kind stays usable. */}
        <Canvas label={t().filter}>
          <FilterPanel
            fields={props.fields}
            rows={filter}
            onRowsChange={changeFilter}
            relationLabels={props.relationLabels}
            dateConfig={props.dateConfig}
          />
        </Canvas>
      </Section>
      <Section icon="arrows-sort" title={t().sortAndGroup}>
        <Canvas label={t().sortAndGroup}>
          <SortPanel fields={props.fields} rows={sort} onRowsChange={changeSort} />
        </Canvas>
      </Section>
    </Dialog>
  );
}
