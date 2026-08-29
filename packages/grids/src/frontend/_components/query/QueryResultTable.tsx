import { Button, DataTable, type DataTableColumn, useLocale } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import type { PublicDslQueryPreviewResponse } from "../../../api/gql-public";
import type { PublicField as Field } from "../../../api/public-dto";
import { FieldValue } from "../table/FieldValue";
import { queryMessages } from "./messages";

type QueryResult = Extract<PublicDslQueryPreviewResponse, { ok: true }>;
type QueryResultRow = QueryResult["rows"][number] & { __rowKey: string };
type QueryResultColumn = QueryResult["columns"][number];

const displayValue = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(displayValue).join(", ");
  return JSON.stringify(value, null, 2);
};

export default function QueryResultTable(props: {
  result: QueryResult;
  baseId: string;
  fieldsByTable: Record<string, Field[]>;
  scrollPreserveKey: string;
  surface?: "paper" | "flat";
  loading?: boolean;
  canGoBack?: boolean;
  backLabel?: "Previous" | "First page";
  onPrevious?: () => void;
  onNext?: (cursor: string) => void;
}) {
  const { t } = queryMessages.resolve([useLocale()()]);
  const rows = createMemo<QueryResultRow[]>(() =>
    props.result.rows.map((row, index) => ({ ...row, __rowKey: row.recordId ? `${row.recordId}:${index}` : `row-${index}` })),
  );
  const columns = createMemo<DataTableColumn<QueryResultRow>[]>(() =>
    props.result.columns.map((column) => ({
      id: column.key,
      header: column.label,
      subtitle: column.joinAlias ? `${column.joinAlias} · ${column.aggregate ?? column.type}` : (column.aggregate ?? column.type),
      value: (row) => row.values[column.key],
    })),
  );
  const fieldForColumn = (column: QueryResultColumn): Field | null => {
    if (column.type === "aggregate" || !column.tableId || !column.fieldId) return null;
    return props.fieldsByTable[column.tableId]?.find((field) => field.id === column.fieldId && !field.deletedAt) ?? null;
  };

  const page = () => props.result.page;
  const hasPager = () => Boolean(props.canGoBack || page()?.nextCursor);
  const hasUnpageableRemainder = () => props.result.truncated && !hasPager();
  const hasFooter = () => hasPager() || hasUnpageableRemainder();
  const rowRange = () => {
    const current = page();
    const returned = current?.returned ?? props.result.rows.length;
    if (returned === 0) return t.noRows;
    const start = current?.start ?? 0;
    return t.rowRange({ start: start + 1, end: start + returned });
  };

  return (
    <div class={`${props.surface === "flat" ? "" : "paper"} flex h-full min-h-0 flex-1 flex-col overflow-hidden`}>
      <DataTable
        ariaLabel={t.queryResults}
        rows={rows()}
        columns={columns()}
        getRowId={(row) => row.__rowKey}
        class="min-h-0 flex-1 overflow-auto"
        density="compact"
        fillHeight
        hoverRows={false}
        cellContentClass="max-h-24 overflow-auto whitespace-pre-wrap break-words"
        empty={<span>{t.noMatchingRows}</span>}
        renderCell={({ col, value }) => {
          const column = props.result.columns.find((item) => item.key === col.id);
          const field = column ? fieldForColumn(column) : null;
          if (!field) return <span>{displayValue(value)}</span>;
          return (
            <FieldValue
              field={field}
              value={value}
              baseId={props.baseId}
              fieldsByTable={props.fieldsByTable}
              mode="table"
              relationValueMode={field.type === "relation" ? "labels" : "ids"}
            />
          );
        }}
        scrollPreserveKey={props.scrollPreserveKey}
      />
      <Show when={hasFooter()}>
        <div class="flex shrink-0 items-center justify-between gap-3 bg-[var(--ui-surface-subtle)] px-3 py-2 text-xs text-secondary">
          <span>{hasUnpageableRemainder() ? t.showingFirstRows({ count: props.result.rows.length }) : rowRange()}</span>
          <Show when={hasPager()}>
            <div class="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={props.loading || !props.canGoBack}
                onClick={() => props.onPrevious?.()}
              >
                <i class={props.loading ? "ti ti-loader-2 animate-spin" : "ti ti-chevron-left"} />{" "}
                {props.backLabel === "First page" ? t.firstPage : t.previous}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={props.loading || !page()?.nextCursor}
                onClick={() => {
                  const cursor = page()?.nextCursor;
                  if (cursor) props.onNext?.(cursor);
                }}
              >
                {t.next} <i class={props.loading ? "ti ti-loader-2 animate-spin" : "ti ti-chevron-right"} />
              </Button>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
