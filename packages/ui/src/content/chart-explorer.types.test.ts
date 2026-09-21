import { expect, test } from "bun:test";
import { type ChartExplorerData, type ChartExplorerSnapshot, createChartExplorer } from "./chart-explorer";
import { prepareChartSnapshot } from "./chart-snapshot";

/** Checked by tsc; never starts a controller outside a Solid owner. */
function publicTypeContract(
  initial: ChartExplorerSnapshot<{
    latency: ChartExplorerData<{ key: string; milliseconds: number }>;
    requests: ChartExplorerData<{ key: string; count: number }>;
  }>,
) {
  const explorer = createChartExplorer({ snapshot: () => initial, load: () => initial });
  const milliseconds: number | undefined = explorer.snapshot().charts.latency.rows[0]?.milliseconds;
  const count: number | undefined = explorer.snapshot().charts.requests.rows[0]?.count;
  // @ts-expect-error Chart names remain exact.
  explorer.snapshot().charts.missing;
  // @ts-expect-error Heterogeneous row shapes remain exact.
  explorer.snapshot().charts.latency.rows[0]?.count;
  createChartExplorer({
    snapshot: () => initial,
    // @ts-expect-error A response must contain all configured charts.
    load: () => ({ request: initial.request, charts: { latency: initial.charts.latency } }),
  });
  prepareChartSnapshot(
    {
      kind: "bar",
      data: [],
      // @ts-expect-error Component-only props do not belong to renderer options.
      style: { height: "20rem" },
    },
    { key: () => "a", tooltip: () => ({ rows: [] }) },
  );
  return [milliseconds, count];
}
test("public API has a compile-time contract fixture", () => expect(typeof publicTypeContract).toBe("function"));
