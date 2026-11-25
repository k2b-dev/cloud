import type { ChartSnapshot } from "@k2b/ui";
import { type OperationalChartSpec, prepareOperationalCharts } from "../../frontend/operational-charts";
import { gatewayOpsMessages } from "../../messages";

/**
 * One chart as the server prepares it for a v2 page: the drawing (SVG geometry) and the same values as table rows,
 * already worded, so the first HTML holds both and the island formats nothing.
 */
export type OpsChart = {
  title: string;
  description?: string;
  error?: string | null;
  snapshot: ChartSnapshot;
  table: { columns: { title: string; end?: boolean }[]; rows: { key: string; cells: string[] }[] };
};

/** Operational line and bar charts as `OpsChart`s; times read in UTC, as the drawings' axes do. */
export const opsCharts = (specs: OperationalChartSpec[], locale: string): OpsChart[] => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  return prepareOperationalCharts(specs, locale).map((chart, index) => {
    const line = specs[index]?.kind === "line";
    return {
      title: chart.title,
      description: chart.description,
      error: chart.error,
      snapshot: chart.data.chart,
      table: {
        columns: [...(line ? [{ title: `${t.time} · UTC` }] : []), { title: t.series }, { title: t.chartValue, end: true }],
        rows: chart.data.rows.map((row) => ({
          key: row.key,
          cells: [...(line ? [row.at === undefined ? "—" : time.format(row.at)] : []), row.label, row.formatted],
        })),
      },
    };
  });
};
