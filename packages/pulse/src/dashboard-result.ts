import {
  DASHBOARD_MAX_MARKS,
  DASHBOARD_MAX_POINTS,
  DASHBOARD_MAX_SERIES,
  type DashboardPanel,
  NUMBER_METADATA_COLUMNS,
} from "./dashboard-contracts";
import { readOverviewNumber } from "./overview-number";
import { sqlTimestamp } from "./sql-result-values";
import type { SqlRows } from "./store/sql-run";

export type DashboardPanelData = { columns: { name: string; type: string }[]; rows: unknown[][] };
/** The output projection is also the public disclosure boundary. Never send unselected columns. */
export const projectDashboardPanel = (panel: DashboardPanel, result: SqlRows): DashboardPanelData => {
  if (result.truncated) throw new Error("The SQL result was truncated. Aggregate the query before displaying it.");
  const indexes = panel.columns.map((name) => {
    const matches = result.columns.flatMap((column, index) => (column.name === name ? [index] : []));
    if (matches.length !== 1) throw new Error(`Expected one output column named ${name}`);
    return matches[0]!;
  });
  const columns = indexes.map((index) => result.columns[index]!);
  const rows = result.rows.map((row) => indexes.map((index) => row[index]));
  if (rows.length * Math.max(1, columns.length - (panel.x ? 1 : 0) - (panel.series ? 1 : 0)) > DASHBOARD_MAX_MARKS)
    throw new Error("A panel supports at most 3,840 marks. Aggregate the query.");
  if (panel.kind === "number" && !panel.x && rows.length > 1) throw new Error("A number panel requires one aggregate row");
  if (panel.kind !== "table") {
    const values = columns.flatMap((column, index) =>
      column.name !== panel.x &&
      column.name !== panel.series &&
      !(panel.kind === "number" && NUMBER_METADATA_COLUMNS.some((name) => name === column.name))
        ? [index]
        : [],
    );
    if (!values.length) throw new Error("Choose a numeric value column");
    for (const row of rows)
      for (const index of values) {
        const cell = row[index];
        if (cell !== null && (cell === "" || !["string", "number"].includes(typeof cell) || !Number.isFinite(Number(cell))))
          throw new Error("Chart values must be finite numbers or null");
        if (panel.kind === "funnel" && (cell === null || Number(cell) < 0)) throw new Error("Funnel values must be nonnegative numbers");
      }
    if (panel.kind === "bar") {
      const group = columns.findIndex((column) => column.name === panel.series);
      const groups = group < 0 ? 1 : new Set(rows.map((row) => JSON.stringify(row[group]))).size;
      if (groups * values.length > DASHBOARD_MAX_SERIES) throw new Error("A panel supports at most 8 series");
    }
  }
  if (panel.kind === "number") {
    const x = columns.findIndex((column) => column.name === panel.x);
    if (panel.x && (x < 0 || !/^(?:Nullable\()?DateTime(?:64)?(?:\(|$)/.test(columns[x]!.type)))
      throw new Error("A number trend needs a DateTime or DateTime64 time column");
    for (const column of columns)
      if (
        NUMBER_METADATA_COLUMNS.some((name) => name === column.name) &&
        !/^(?:(?:Nullable|LowCardinality)\()?String\)?$/.test(column.type)
      )
        throw new Error("Number presentation columns must be strings");
    // Use the same typed value contract as the renderer, but reject any invalid
    // point instead of letting the sparkline omit it silently.
    for (const row of rows) {
      const number = readOverviewNumber({ columns, rows: [row], truncated: false });
      if (!number.ok || (panel.x && number.data.points.length !== 1))
        throw new Error("Number values and trend timestamps must be valid finite numbers and dates");
    }
  }
  if (panel.kind === "line" || panel.kind === "bar") {
    const x = columns.findIndex((column) => column.name === panel.x);
    if (panel.kind === "line" && (x < 0 || !/^(?:Nullable\()?Date(?:Time(?:64)?(?:\(|$)|\)?$)/.test(columns[x]!.type)))
      throw new Error("A line panel needs a Date, DateTime or DateTime64 time column");
    const group = columns.findIndex((column) => column.name === panel.series);
    const values = columns.flatMap((column, index) => (index !== x && index !== group ? [index] : []));
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (panel.kind === "line" && !Number.isFinite(sqlTimestamp(row[x], columns[x]!.type)))
        throw new Error("The time column contains an invalid value");
      for (const value of values) {
        const key = JSON.stringify([group < 0 ? "" : row[group], columns[value]!.name]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        const cell = row[value];
        if (cell !== null && (cell === "" || !["string", "number"].includes(typeof cell) || !Number.isFinite(Number(cell))))
          throw new Error("Chart values must be finite numbers or null");
      }
    }
    if (counts.size > DASHBOARD_MAX_SERIES || [...counts.values()].some((count) => count > DASHBOARD_MAX_POINTS))
      throw new Error("A panel supports at most 8 series and 480 points per series. Aggregate the query.");
  } else if (rows.length > DASHBOARD_MAX_POINTS) throw new Error("A panel supports at most 480 rows. Aggregate the query.");
  return { columns, rows };
};
