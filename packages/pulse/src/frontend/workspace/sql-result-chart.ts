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
export const sqlResultChart = (result: Pick<SqlResult, "columns" | "rows">): SqlResultChart => {
  if (!result.rows.length) return { kind: "none", reason: "no-rows" };
  const xIndex = result.columns.findIndex((column) => time.test(unwrap(column.type)));
  if (xIndex < 0) return { kind: "none", reason: "no-time-column" };
  const columns = result.columns.flatMap((column, index) =>
    index !== xIndex && numeric.test(unwrap(column.type)) ? [{ ...column, index }] : [],
  );
  if (!columns.length) return { kind: "none", reason: "no-numeric-column" };
  const shown = columns.slice(0, SQL_CHART_MAX_SERIES);
  const rows = result.rows.slice(0, SQL_CHART_MAX_POINTS);
  const cut = { seriesShown: shown.length, seriesTotal: columns.length, pointsShown: rows.length, pointsTotal: result.rows.length };
  return {
    kind: "chart",
    xColumn: result.columns[xIndex]!.name,
    chart: {
      kind: "line",
      series: shown.map((column) => ({
        label: column.name,
        data: rows.flatMap((row) => {
          const x = timestamp(row[xIndex], result.columns[xIndex]!.type);
          const raw = row[column.index];
          const y = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
          return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
        }),
      })),
      xAxis: { label: result.columns[xIndex]!.name },
      legend: true,
    },
    cut,
    truncated: cut.seriesShown < cut.seriesTotal || cut.pointsShown < cut.pointsTotal,
  };
};
