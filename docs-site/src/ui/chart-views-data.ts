import { type ChartExplorerData, type ChartExplorerRequest, type ChartExplorerSnapshot, prepareChartSnapshot } from "@k2b/ui";

export type OrderRow = { key: string; region: string; year: string; month: number; orders: number; basket: number };
export type OrderCharts = { orders: ChartExplorerData<OrderRow>; basket: ChartExplorerData<OrderRow>; table: ChartExplorerData<OrderRow> };

export const orderViews = [
  { id: "orders", label: "Orders" },
  { id: "basket", label: "Average basket" },
] as const;
export const orderSteps = [
  { key: "2025", label: "2025" },
  { key: "2026", label: "2026" },
];
export const orderRegions = [
  { key: "north", label: "North", color: "var(--stdlib-chart-c1)" },
  { key: "south", label: "South", color: "var(--stdlib-chart-c2)" },
  { key: "west", label: "West", color: "var(--stdlib-chart-c3)" },
];
export const orderInitial: ChartExplorerRequest = { step: "2026" };

/** One synthetic dataset: a row per region, year and month. */
const dataset: OrderRow[] = orderSteps.flatMap((year, y) =>
  orderRegions.flatMap((region, r) =>
    Array.from({ length: 12 }, (_, index) => {
      const month = index + 1;
      const season = Math.round(18 * Math.sin(((month - 3) / 12) * 2 * Math.PI));
      return {
        key: `${region.key}:${year.key}:${month}`,
        region: region.label,
        year: year.key,
        month,
        orders: 120 + r * 35 + y * 22 + season + ((month * (r + 3)) % 9),
        basket: 42 + r * 6 + y * 3 + ((month + r) % 5),
      };
    }),
  ),
);
const regionOf = (row: OrderRow) => orderRegions.findIndex((region) => region.label === row.region);

/**
 * Pure local builder: every chart of the request from the same rows. Series keep their region's slot, and the
 * renderer colors a series by its index modulo 8, so a reference year at slot + 8 draws dashed in its region's color.
 */
export function orderSnapshot(request: ChartExplorerRequest): ChartExplorerSnapshot<OrderCharts> {
  const visible = (row: OrderRow) => !request.visibleKeys || request.visibleKeys.includes(orderRegions[regionOf(row)]!.key);
  // A reference on the shown year adds nothing to compare.
  const reference = request.referenceStep !== request.step ? request.referenceStep : undefined;
  const rows = dataset.filter((row) => visible(row) && (row.year === request.step || row.year === reference));
  const chart = (measure: "orders" | "basket") => {
    const slots = Array.from({ length: reference ? 16 : 8 }, (_, slot) => {
      const region = orderRegions[slot % 8];
      const year = slot < 8 ? request.step : reference;
      const data = region ? rows.filter((row) => row.region === region.label && row.year === year) : [];
      return { region, year, data };
    });
    const series = slots.map((slot) => ({
      label: slot.region ? `${slot.region.label} · ${slot.year}` : "",
      data: slot.data.map((row) => ({ x: row.month, y: row[measure] })),
      ...(slot.year === reference ? { lineStyle: "dashed" as const } : {}),
    }));
    return prepareChartSnapshot(
      {
        kind: "line",
        series,
        xAxis: { domain: [1, 12], label: "Month" },
        yAxis: measure === "orders" ? { domain: [0, 250], label: "Orders" } : { domain: [30, 70], format: (value) => `€${value}` },
      },
      {
        key: ({ datum }) => `${datum.seriesIndex ?? 0}:${slots[datum.seriesIndex ?? 0]!.data[datum.index]!.key}`,
        rowKey: ({ datum }) => slots[datum.seriesIndex ?? 0]!.data[datum.index]!.key,
        tooltip: ({ datum }) => {
          const row = slots[datum.seriesIndex ?? 0]!.data[datum.index]!;
          return {
            title: `${row.region} · ${row.year}`,
            rows: [
              { label: "Month", value: String(row.month) },
              {
                label: measure === "orders" ? "Orders" : "Average basket",
                value: measure === "orders" ? String(row.orders) : `€${row.basket}`,
              },
            ],
          };
        },
      },
    );
  };
  // The table entry has no marks; it carries the rows the table shows when the switcher picks it.
  const table = { kind: "line" as const, svg: "", width: 480, height: 280, stretch: true, marks: [] };
  return {
    request,
    charts: { orders: { chart: chart("orders"), rows }, basket: { chart: chart("basket"), rows }, table: { chart: table, rows } },
  };
}

export const orderLegend = (request: ChartExplorerRequest) =>
  [request.step, ...(request.referenceStep && request.referenceStep !== request.step ? [request.referenceStep] : [])].flatMap(
    (year, index) =>
      orderRegions
        .filter((region) => !request.visibleKeys || request.visibleKeys.includes(region.key))
        .map((region) => ({
          label: `${region.label} · ${year}`,
          color: orderRegions.indexOf(region),
          ...(index > 0 ? { style: "dashed" as const, reference: true } : {}),
        })),
  );
