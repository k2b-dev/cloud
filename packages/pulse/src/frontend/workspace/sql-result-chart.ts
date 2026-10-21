import { dates } from "@k2b/stdlib";
import type { ChartProps } from "@k2b/ui";
import type { SqlResult } from "./sql-client";

export const SQL_CHART_MAX_SERIES = 8;
export const SQL_CHART_MAX_POINTS = 480;
export type SqlChartCut = { seriesShown: number; seriesTotal: number; pointsShown: number; pointsTotal: number };
export type SqlResultChart =
  | { kind: "none"; reason: "no-time-column" | "no-numeric-column" | "no-rows" }
  | { kind: "chart"; xColumn: string; chart: Extract<ChartProps, { kind: "line" }>; cut: SqlChartCut; truncated: boolean };
const unwrap = (type: string) => type.replace(/^Nullable\((.*)\)$/, "$1");
const numeric = /^(?:U?Int\d+|Float\d+|Decimal(?:\d+)?(?:\([^)]*\))?)$/;
const time = /^(?:Date|DateTime(?:64)?(?:\([^)]*\))?)$/;
const timestamp = (value: unknown, type: string): number => {
  if (typeof value === "number") return value * 1000; // ClickHouse Unix seconds.
  if (typeof value !== "string") return Number.NaN;
  const iso = value.replace(" ", "T");
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(iso)) return Date.parse(iso);
  const zone = /'([^']+)'/.exec(type)?.[1];
  if (!zone || zone === "UTC" || /^\d{4}-\d{2}-\d{2}$/.test(iso)) return Date.parse(`${iso}${iso.length === 10 ? "T00:00:00" : ""}Z`);
  try {
    return Date.parse(dates.zonedDateTimeToInstant(iso, zone, { disambiguation: "compatible" }));
  } catch {
    return Number.NaN;
  }
};

/** Preserve returned row order; cap before adapting, never sort or aggregate SQL results. */
export const sqlResultChart = (result: Pick<SqlResult, "columns" | "rows">, locale = "en"): SqlResultChart => {
  if (!result.rows.length) return { kind: "none", reason: "no-rows" };
  const xIndex = result.columns.findIndex((column) => time.test(unwrap(column.type)));
  if (xIndex < 0) return { kind: "none", reason: "no-time-column" };
  const columns = result.columns.flatMap((column, index) =>
    index !== xIndex && numeric.test(unwrap(column.type)) ? [{ ...column, index }] : [],
  );
  if (!columns.length) return { kind: "none", reason: "no-numeric-column" };
  const xColumn = result.columns[xIndex]!;
  const timeZone = dates.normalizeTimeZone(/'([^']+)'/.exec(xColumn.type)?.[1], "UTC");
  const dateFormat = new Intl.DateTimeFormat(locale, { timeZone, year: "numeric", month: "numeric", day: "numeric" });
  const clockOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" } as const;
  const subsecond = unwrap(xColumn.type).startsWith("DateTime64") ? { fractionalSecondDigits: 3 as const } : {};
  const clockFormat = new Intl.DateTimeFormat(locale, { timeZone, ...clockOptions, ...subsecond });
  const fullFormat = new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    ...(unwrap(xColumn.type) === "Date" ? {} : { ...clockOptions, ...subsecond, timeZoneName: "shortOffset" }),
  });
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 });
  const shown = columns.slice(0, SQL_CHART_MAX_SERIES);
  const rows = result.rows.slice(0, SQL_CHART_MAX_POINTS);
  const cut = { seriesShown: shown.length, seriesTotal: columns.length, pointsShown: rows.length, pointsTotal: result.rows.length };
  const series = shown.map((column) => ({
    label: column.name,
    data: rows.flatMap((row) => {
      const x = timestamp(row[xIndex], result.columns[xIndex]!.type);
      const raw = row[column.index];
      const y = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
      return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
    }),
  }));
  const times = rows.map((row) => timestamp(row[xIndex], xColumn.type)).filter(Number.isFinite);
  const first = times[0];
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const domain: [number, number] | undefined = times.length
    ? minTime === maxTime
      ? [minTime - 1, maxTime + 1]
      : [minTime, maxTime]
    : undefined;
  const day = first === undefined ? undefined : dates.formatDateKey(new Date(first), { timeZone });
  const sameDay = day !== undefined && times.every((value) => dates.formatDateKey(new Date(value), { timeZone }) === day);
  const clockTicks = unwrap(xColumn.type) !== "Date" && sameDay;
  const axisLabel = `${xColumn.name}${clockTicks && first !== undefined ? ` · ${dateFormat.format(first)}` : ""} (${timeZone})`;
  return {
    kind: "chart",
    xColumn: result.columns[xIndex]!.name,
    chart: {
      kind: "line",
      series,
      xAxis: {
        label: axisLabel,
        ticks: 2,
        domain,
        // Two precise endpoint labels fit the narrow console even when nice ticks add intermediates.
        format: (value) =>
          (minTime === maxTime ? value !== minTime : domain && value > domain[0] && value < domain[1])
            ? ""
            : (clockTicks && dates.formatDateKey(new Date(value), { timeZone }) === day ? clockFormat : dateFormat).format(value),
      },
      padding: { left: 60, right: 60 },
      interactive: true,
      tooltip: ({ datum }) => ({
        title: datum.values
          .flatMap((field) => (field.key === "x" && typeof field.value === "number" ? [fullFormat.format(field.value)] : []))
          .join(""),
        rows: datum.values
          .filter((field) => field.key === "y")
          .map((field) => ({
            label: datum.label ?? "",
            value: field.formatted ?? (typeof field.value === "number" ? numberFormat.format(field.value) : field.value),
          })),
      }),
      legend: true,
    },
    cut,
    truncated: cut.seriesShown < cut.seriesTotal || cut.pointsShown < cut.pointsTotal,
  };
};
