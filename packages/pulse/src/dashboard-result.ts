import { DASHBOARD_MAX_MARKS, DASHBOARD_MAX_POINTS, type DashboardPanel, NUMBER_METADATA_COLUMNS } from "./dashboard-contracts";
import { dashboardChartRenderOptions } from "./dashboard-description";
import { readOverviewNumber } from "./overview-number";
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
  if (!["number", "table", "map"].includes(panel.kind)) {
    const x = columns.findIndex((column) => column.name === panel.x);
    if (panel.kind === "line" && (x < 0 || !/^(?:Nullable\()?Date(?:Time(?:64)?(?:\(|$)|\)?$)/.test(columns[x]!.type)))
      throw new Error("A line panel needs a Date, DateTime or DateTime64 time column");
    if (rows.length) dashboardChartRenderOptions(panel, { columns, rows }, { locale: "en", timeZone: "UTC" });
    return { columns, rows };
  }
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
      }
  }
  if (panel.kind === "map") {
    const x = columns.findIndex((column) => column.name === panel.x);
    const value = columns.findIndex((column) => column.name !== panel.x);
    for (const row of rows) {
      // Null or empty means no lookup result; those rows stay in SQL but off the map.
      if (row[x] !== null && row[x] !== "" && !(typeof row[x] === "string" && /^[A-Za-z]{2}$/.test(row[x])))
        throw new Error("A map panel needs ISO 3166-1 alpha-2 country codes");
      if (row[value] === null || Number(row[value]) < 0) throw new Error("Map values must be nonnegative numbers");
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
  if (rows.length > DASHBOARD_MAX_POINTS) throw new Error("A panel supports at most 480 rows. Aggregate the query.");
  return { columns, rows };
};
