import { useLocale } from "@k2b/ui";
import { Bar, Button, type Column, Inline, Mark, type MarkProps, type StatusFact, Table, Text } from "@k2b/ui/v2";
import { createMemo, Show } from "solid-js";
import type { PublicDslQueryPreviewResponse } from "../../../api/gql-public";
import type { PublicField as Field } from "../../../api/public-dto";
import { FieldValue } from "../table/FieldValue";
import { formatFieldValueText } from "../table/field-value-format";
import { queryMessages } from "./messages";

export type QueryResult = Extract<PublicDslQueryPreviewResponse, { ok: true }>;
type ResultRow = QueryResult["rows"][number] & { key: string };
type ResultColumn = QueryResult["columns"][number];

const NUMERIC = new Set(["number", "percent", "duration", "rollup", "decimal", "count", "sum", "avg", "min", "max"]);

/**
 * A value without a field, such as an aggregate: a number in the reader's language (12.400,5), the rest as it came. A
 * number written as text counts as one only in a numeric column, so a code such as "00123" stays as it is.
 */
const plain = (value: unknown, locale: string, numeric = false): string => {
  if (value === null || value === undefined || value === "") return "–";
  if (typeof value === "number") return value.toLocaleString(locale, { maximumFractionDigits: 2 });
  if (numeric && typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value))
    return Number(value).toLocaleString(locale, { maximumFractionDigits: 2 });
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((each) => plain(each, locale, numeric)).join(", ");
  return JSON.stringify(value);
};

/** What a result says in a status row: its rows, or that only the first ones came. */
export const resultLead = (result: QueryResult | null, locale: string): string => {
  const { t } = queryMessages.resolve([locale]);
  if (!result) return t.noResultYet;
  const returned = result.page?.returned ?? result.rows.length;
  if (returned === 0) return t.noRows;
  if (result.truncated && !result.page?.nextCursor) return t.showingFirstRows({ count: result.rows.length });
  const start = result.page?.start ?? 0;
  return t.rowRange({ start: start + 1, end: start + returned });
};

/**
 * Two key figures of a result for its status row, from its data: its columns, and the totals of its first two sums or
 * counts on this page (a grouped result says what it adds up).
 */
export const resultFacts = (result: QueryResult | null, locale: string): StatusFact[] => {
  const { t } = queryMessages.resolve([locale]);
  if (!result || result.rows.length === 0) return [];
  const totals = result.columns
    .filter((column) => column.aggregate === "sum" || column.aggregate === "count")
    .slice(0, 2)
    .map((column) => ({
      before: column.label,
      value: result.rows.reduce((sum, row) => sum + (Number(row.values[column.key]) || 0), 0),
    }));
  return totals.length ? totals : [{ value: result.columns.length, after: t.columnsWord({ count: result.columns.length }) }];
};

/** The one line over a result: its rows, its key figures and how long the query took ("Zeilen 1–100 · 5 Spalten · 84 ms"). */
export const resultSummary = (result: QueryResult, locale: string, took?: number | null): string => {
  const said = (value: string | number | undefined) => (typeof value === "number" ? value.toLocaleString(locale) : (value ?? ""));
  const facts = resultFacts(result, locale).map((fact) => [fact.before, said(fact.value), fact.after].filter(Boolean).join(" "));
  return [resultLead(result, locale), ...facts, ...(took != null ? [`${took.toLocaleString(locale)} ms`] : [])].join(" · ");
};

/**
 * The rows of a GQL result on v2: one column per output, a field's value as the table shows it, an aggregate as
 * text, and two lines per row on the phone. One toolbar row over the table says what came and how fast, and moves through
 * pages of 100 with Previous and Next.
 */
export default function QueryResults(props: {
  result: QueryResult;
  /** The mark that leads each row: the source table's for records, the view's for groups. */
  mark: MarkProps;
  baseId: string;
  fieldsByTable: Record<string, Field[]>;
  loading?: boolean;
  canGoBack?: boolean;
  /** Back goes to the first page (not one page back) when the history of pages is gone, such as after a reload. */
  backToFirst?: boolean;
  onPrevious?: () => void;
  onNext?: (cursor: string) => void;
  /** How long the query took in ms, measured where it ran; unknown for the page the server rendered. */
  took?: number | null;
}) {
  const locale = useLocale();
  const t = () => queryMessages.resolve([locale()]).t;
  const rows = createMemo<ResultRow[]>(() =>
    props.result.rows.map((row, index) => ({ ...row, key: row.recordId ? `${row.recordId}:${index}` : `row-${index}` })),
  );
  const fieldOf = (column: ResultColumn): Field | null => {
    if (column.type === "aggregate" || !column.tableId || !column.fieldId) return null;
    return props.fieldsByTable[column.tableId]?.find((field) => field.id === column.fieldId && !field.deletedAt) ?? null;
  };
  const text = (row: ResultRow, column: ResultColumn) => {
    const field = fieldOf(column);
    const value = row.values[column.key];
    return field
      ? formatFieldValueText({ field, value, fieldsByTable: props.fieldsByTable, locale: locale() })
      : plain(value, locale(), NUMERIC.has(column.aggregate ?? column.type));
  };
  const columns = createMemo((): Column<ResultRow>[] =>
    props.result.columns.map((column, index) => {
      const field = fieldOf(column);
      const numeric = NUMERIC.has(field?.type ?? column.aggregate ?? column.type);
      return {
        title: column.label,
        width: numeric ? { min: 80, default: 120 } : { min: 120, default: 220 },
        align: numeric ? "end" : "start",
        drop: index > 0,
        cell: (row) =>
          index === 0 ? (
            <Inline>
              <Mark {...props.mark} />
              <Text>{text(row, column)}</Text>
            </Inline>
          ) : field ? (
            <FieldValue
              field={field}
              value={row.values[column.key]}
              baseId={props.baseId}
              fieldsByTable={props.fieldsByTable}
              mode="table"
              relationValueMode={field.type === "relation" ? "labels" : "ids"}
            />
          ) : (
            plain(row.values[column.key], locale(), numeric)
          ),
      };
    }),
  );
  const next = () => props.result.page?.nextCursor ?? null;
  return (
    <>
      <Bar
        start={props.loading ? t().runningQuery : resultSummary(props.result, locale(), props.took)}
        end={
          <Show when={props.canGoBack || next()}>
            <Button icon="chevron-left" disabled={!props.canGoBack} busy={props.loading} onClick={() => props.onPrevious?.()}>
              {props.backToFirst ? t().firstPage : t().previous}
            </Button>
            <Button
              icon="chevron-right"
              disabled={!next()}
              busy={props.loading}
              onClick={() => {
                const cursor = next();
                if (cursor) props.onNext?.(cursor);
              }}
            >
              {t().next}
            </Button>
          </Show>
        }
      />
      <Table
        label={t().queryResults}
        rows={rows()}
        rowKey={(row) => row.key}
        sticky
        columns={columns()}
        empty={{ icon: "table-off", text: t().noMatchingRows }}
        phone={(row) => {
          // the last number of the row stands on the right, the next two values under the name
          const [first, ...rest] = props.result.columns;
          const figure = rest.findLast((column) => NUMERIC.has(fieldOf(column)?.type ?? column.aggregate ?? column.type));
          return {
            mark: props.mark,
            lines: [
              first ? text(row, first) : "–",
              rest
                .filter((column) => column !== figure)
                .slice(0, 2)
                .map((column) => text(row, column))
                .join(" · "),
            ],
            time: figure ? text(row, figure) : undefined,
          };
        }}
      />
    </>
  );
}
