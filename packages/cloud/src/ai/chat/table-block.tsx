import { CopyButton, DataTable, type DataTableSort, DataTableTools, filterRows, useLocale } from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import { BlockActions, BlockFoot, useBlockFrame } from "../../blocks/block-actions";
import { blockFileName, saveBlob, tableCopy, tableCsv } from "../../blocks/block-copy";
import { blockWords } from "../../blocks/messages";
import { SearchToggle } from "../../blocks/search-toggle";
import type { CloudAiChartRow } from "../chart-block";
import { type CloudTableDescription, cloudAiTableTsv, cloudAiViewTable, sortCloudAiViewRows } from "../view-block";
import { aiChatMessages } from "./messages";
import { ReferenceText } from "./reference-text";
import { type TableSummary, tableHeight } from "./table-placeholder";
import { ViewHeading } from "./view-heading";

const VISIBLE_ROWS = 100;

/**
 * A table view: title, Copy data and a sortable table in a viewport whose height follows the row count of its
 * `present` summary, so loading, the table and the unavailable state take the same room.
 */
export function CloudTableView(props: {
  id: string;
  summary: TableSummary;
  input: CloudTableDescription | null | undefined;
  /** `plain` inside an island, which is the table's frame; `paper` on its own. */
  surface?: "paper" | "plain";
}) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const frame = useBlockFrame();
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
  const [query, setQuery] = createSignal("");
  // In a chat answer a searchable table names what its search finds, and on a phone its search folds into a sign.
  // In an answer every table's head has its search (Feinschliff v3 §5: "search, tables only"); elsewhere the view's own
  // `search` decides.
  const searchable = () => frame !== undefined || props.summary.search === true;
  const counted = () => frame !== undefined;
  const [searching, setSearching] = createSignal(false);
  const [groupBy, setGroupBy] = createSignal<string | null>(null);
  // Search matches the cells as they are shown; Copy data keeps every row of the view.
  const shown = createMemo(() => {
    const value = table();
    return value
      ? filterRows(
          rows(),
          value.columns.map((column) => ({ id: column.id, value: (row: CloudAiChartRow) => row.cells[column.id] ?? "" })),
          query(),
          locale(),
        )
      : [];
  });
  const copyText = createMemo(() => {
    const value = table();
    return value ? cloudAiTableTsv({ ...value, rows: rows() }) : "";
  });
  const groups = () =>
    props.input?.groupBy?.map((group) => ({
      id: group.id,
      label: group.label ?? props.input?.columns.find((column) => column.id === group.id)?.label ?? group.id,
    }));
  let tools: HTMLDivElement | undefined;
  const number = () => new Intl.NumberFormat(locale());
  const refColumns = createMemo(() => new Set(props.input?.columns.flatMap((column) => (column.type === "ref" ? [column.id] : []))));
  return (
    <section
      class={
        counted()
          ? `cloud-table-frame grid min-w-0 gap-3${searching() || query() !== "" ? " cloud-table-frame--searching" : ""}`
          : "grid min-w-0 gap-3"
      }
      aria-labelledby={props.id}
    >
      <ViewHeading
        id={props.id}
        title={props.input?.title ?? props.summary.title}
        subtitle={props.input ? props.input.subtitle : props.summary.subtitle}
        actions={
          <div class="cloud-table-tools flex min-w-0 flex-wrap items-center gap-2">
            {/* The summary reserves the tools from the first frame; they wait, disabled, for the rows. */}
            <Show when={counted()}>
              <SearchToggle
                label={blockWords(locale()).searchTable}
                describedBy={props.id}
                disabled={!table()}
                onOpen={() => setSearching(true)}
              />
            </Show>
            <Show when={searchable() || props.summary.grouped}>
              <div ref={tools} class="cloud-table-search-host contents" onFocusOut={() => setSearching(false)}>
                <DataTableTools
                  // A fixed word, never the view's title: the heading names the table for the field too.
                  label={blockWords(locale()).table}
                  describedBy={props.id}
                  query={query()}
                  onQueryChange={searchable() ? setQuery : undefined}
                  groups={props.summary.grouped ? (groups() ?? []) : undefined}
                  groupBy={groupBy()}
                  onGroupByChange={props.summary.grouped ? setGroupBy : undefined}
                  disabled={!table()}
                />
              </div>
            </Show>
            {/* In a chat answer Copy (text with tabs and an HTML table) and Maximize come from the frame. */}
            <Show
              when={frame}
              fallback={<CopyButton text={copyText()} label={t().viewCopyData} iconOnly size="sm" variant="ghost" disabled={!table()} />}
            >
              <BlockActions
                kind="table"
                name={props.input?.title ?? props.summary.title}
                copy={() => {
                  const value = table();
                  if (!value) throw new Error("No rows");
                  const rows = [...value.rows, ...(value.footer ? [value.footer] : [])];
                  return tableCopy(
                    value.columns.map((column) => column.label),
                    rows.map((row) => value.columns.map((column) => row.cells[column.id] ?? "")),
                  );
                }}
                download={() => {
                  const value = table();
                  if (!value) return;
                  saveBlob(
                    tableCsv(
                      value.columns.map((column) => column.label),
                      value.rows.map((row) => value.columns.map((column) => row.cells[column.id] ?? "")),
                    ),
                    blockFileName(props.input?.title ?? props.summary.title, "csv"),
                  );
                }}
                content={() => <CloudTableView {...props} />}
              />
            </Show>
          </div>
        }
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
              rows={shown().slice(0, VISIBLE_ROWS)}
              columns={value().columns.map((column) => ({
                id: column.id,
                header: column.label,
                priority: props.input?.columns.find((entry) => entry.id === column.id)?.priority,
                // A wrapped label would make the header taller than the reserved row; the table scrolls sideways instead.
                headerClass: "whitespace-nowrap",
                value: (row) => row.cells[column.id] ?? "",
                align: column.numeric ? "right" : "left",
                sortable: true,
              }))}
              renderCell={({ row, col, value: text, render }) => {
                // Row keys are row indexes, so a reference cell finds its object in the loaded view.
                const cells = props.input?.rows[Number(row.key)];
                const cell = refColumns().has(col.id) && cells && Object.hasOwn(cells, col.id) ? cells[col.id] : undefined;
                return cell && typeof cell === "object" && cell.title?.trim() ? (
                  <ReferenceText text={String(text)} reference={cell} />
                ) : (
                  render(text)
                );
              }}
              getRowId={(row) => row.key}
              sort={sort()}
              onSortChange={setSort}
              footer={
                value().footer
                  ? {
                      values: value().footer?.cells,
                      renderCell: ({ col, value }) => {
                        const text = typeof value === "string" ? value : "";
                        const cells = props.input?.footer;
                        const cell = refColumns().has(col.id) && cells && Object.hasOwn(cells, col.id) ? cells[col.id] : undefined;
                        return cell && typeof cell === "object" && cell.title?.trim() ? (
                          <ReferenceText text={text} reference={cell} />
                        ) : (
                          text
                        );
                      },
                    }
                  : undefined
              }
              ariaLabelledBy={props.id}
              groupBy={groupBy() ?? undefined}
              query={query()}
              onClearQuery={() => {
                setQuery("");
                tools?.querySelector("input")?.focus();
              }}
              density="compact"
              surface={props.surface ?? "paper"}
              stickyHeader
              class="h-full"
              empty={<span>{t().tableEmpty}</span>}
            />
          )}
        </Show>
      </div>
      <Show
        when={counted()}
        fallback={
          <Show when={props.summary.rows > VISIBLE_ROWS}>
            <p class="text-sm text-secondary">
              {t().viewRowsCapped({ shown: number().format(VISIBLE_ROWS), total: number().format(props.summary.rows) })}
            </p>
          </Show>
        }
      >
        <BlockFoot
          query={query()}
          shown={shown().length}
          total={props.summary.rows}
          idle={
            props.summary.rows > VISIBLE_ROWS
              ? t().viewRowsCapped({ shown: number().format(VISIBLE_ROWS), total: number().format(props.summary.rows) })
              : undefined
          }
        />
      </Show>
    </section>
  );
}
