import type { StatusTone } from "../surfaces/StatusBadge";

/**
 * What a column holds. It decides alignment, wrapping, the shown text, search and sort:
 * text wraps; number, amount, bar, flow and delta read right-aligned with equal-width digits; date reads in the
 * reader's language; status shows a badge from `states`.
 */
export type DataTableColumnType = "text" | "number" | "date" | "status" | "bar" | "amount" | "flow" | "delta";

/** A number format by name, as a portable description stores it. `decimals` fixes the fraction digits. */
export type DataTableNumberFormat = {
  style?: "number" | "percent" | "currency";
  /** ISO 4217 code; required for `style: "currency"`, `amount` and `flow`. */
  currency?: string;
  decimals?: number;
  compact?: boolean;
};

/** The label and tone of one stored status value. */
export type DataTableStatusState = { label: string; tone: StatusTone };

/** The typed part of a column, independent of how the row stores its values. */
export type DataTableTypedColumn = {
  type?: DataTableColumnType;
  format?: DataTableNumberFormat;
  /** Labels and tones of a status column, by stored value. */
  states?: Readonly<Record<string, DataTableStatusState>>;
  /** The value a bar column fills its track at; defaults to the largest value in the rows. */
  max?: number;
};

const numericTypes = new Set<DataTableColumnType>(["number", "amount", "bar", "flow", "delta"]);
export const isNumericColumnType = (type?: DataTableColumnType): boolean => !!type && numericTypes.has(type);

const finite = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
};

const fractionDigits = (decimals?: number) => {
  if (decimals === undefined) return {};
  const digits = Math.min(20, Math.max(0, Math.trunc(decimals) || 0));
  return { minimumFractionDigits: digits, maximumFractionDigits: digits };
};

/** Formats a number the way a typed column shows it: in the reader's language, by the column's format. */
export const formatTableNumber = (value: number, column: DataTableTypedColumn, locale: string): string => {
  const format = column.format ?? {};
  // Amounts and flows are money: with a currency they always read as one, whatever `style` says.
  const money = column.type === "amount" || column.type === "flow" || format.style === "currency";
  const options: Intl.NumberFormatOptions =
    money && format.currency
      ? { style: "currency", currency: format.currency }
      : format.style === "percent"
        ? { style: "percent", maximumFractionDigits: 1 }
        : { maximumFractionDigits: 3 };
  return new Intl.NumberFormat(locale, {
    ...options,
    ...(format.compact ? { notation: "compact", maximumFractionDigits: 1 } : {}),
    ...fractionDigits(format.decimals),
  }).format(Object.is(value, -0) ? 0 : value);
};

const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
/** A date column reads ISO text, a timestamp or a Date; a day without a time stays that day in every zone. */
export const formatTableDate = (value: unknown, locale: string): string | null => {
  if (typeof value === "string" && dateOnly.test(value)) {
    const day = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(day.getTime()) ? null : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(day);
  }
  const date = value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
};

/** True when the value is missing: such a cell shows a dash, sorts last and never counts as zero. */
export const isEmptyCell = (value: unknown): boolean => value === null || value === undefined || value === "";

/**
 * The text a typed cell shows, for search, grouping and copied rows. Amounts and flows read without a sign; a flow
 * is the amount alone because its direction is the arrow, and a delta is the signed change in percent.
 */
export const tableCellText = (value: unknown, column: DataTableTypedColumn, locale: string): string => {
  if (isEmptyCell(value)) return "";
  const type = column.type ?? "text";
  if (type === "status") return column.states?.[String(value)]?.label ?? String(value);
  if (type === "date") return formatTableDate(value, locale) ?? String(value);
  if (isNumericColumnType(type)) {
    const number = finite(value);
    if (number === null) return String(value);
    if (type === "delta")
      return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" })
        .format(number)
        .replace("-", "−");
    return formatTableNumber(type === "flow" ? Math.abs(number) : number, column, locale);
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
};

/** The value a typed column sorts by: numbers by value, dates by time, a status by its label, the rest as text. */
export const tableSortValue = (value: unknown, column: DataTableTypedColumn, locale: string): number | string | null => {
  if (isEmptyCell(value)) return null;
  const type = column.type ?? "text";
  if (isNumericColumnType(type)) return finite(value);
  if (type === "date") {
    const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number") return value;
  return tableCellText(value, column, locale);
};

type Readable<T> = DataTableTypedColumn & { id: string; value?: keyof T | ((row: T) => unknown) };

export const readTableValue = <T>(row: T, column: Readable<T>): unknown =>
  typeof column.value === "function" ? column.value(row) : column.value ? row[column.value] : undefined;

/**
 * The rows any of whose shown values contains the query, ignoring case and accents. An empty query keeps every row.
 * Matches the text a reader sees, so a status matches by its label and an amount as it is formatted.
 */
export const filterRows = <T>(rows: readonly T[], columns: readonly Readable<T>[], query: string, locale: string): T[] => {
  const fold = (text: string) =>
    text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLocaleLowerCase(locale);
  const needle = fold(query.trim());
  if (!needle) return [...rows];
  return rows.filter((row) => columns.some((column) => fold(tableCellText(readTableValue(row, column), column, locale)).includes(needle)));
};

/** Rows in the order of one column: values first, missing values last in both directions. */
export const sortRows = <T>(
  rows: readonly T[],
  columns: readonly Readable<T>[],
  sort: { key: string; direction: "asc" | "desc" } | null | undefined,
  locale: string,
): T[] => {
  const column = sort ? columns.find((entry) => entry.id === sort.key) : undefined;
  if (!sort || !column) return [...rows];
  const collator = new Intl.Collator(locale, { numeric: true });
  const keyed = rows.map((row, index) => ({ row, index, key: tableSortValue(readTableValue(row, column), column, locale) }));
  const factor = sort.direction === "asc" ? 1 : -1;
  keyed.sort((a, b) => {
    if (a.key === null || b.key === null) return a.key === b.key ? a.index - b.index : a.key === null ? 1 : -1;
    const order = typeof a.key === "number" && typeof b.key === "number" ? a.key - b.key : collator.compare(String(a.key), String(b.key));
    return order * factor || a.index - b.index;
  });
  return keyed.map((entry) => entry.row);
};

/** Rows split by one column, in the order each group first appears; the label is the group's shown value. */
export const groupRows = <T>(rows: readonly T[], column: Readable<T>, locale: string): { key: string; label: string; rows: T[] }[] => {
  const groups = new Map<string, { key: string; label: string; rows: T[] }>();
  for (const row of rows) {
    const value = readTableValue(row, column);
    const key = isEmptyCell(value) ? "" : String(value);
    const group = groups.get(key) ?? { key, label: tableCellText(value, column, locale), rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
};
