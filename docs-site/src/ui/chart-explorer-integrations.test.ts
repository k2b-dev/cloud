import { expect, test } from "bun:test";
import { chartRequestFromSearch, chartSearchParams } from "./chart-group-url";
import { queueSteps, staticQueueSnapshots } from "./chart-local-data";

test("URL state preserves empty filters, references and unrelated page parameters", () => {
  const request = { step: "17", referenceStep: "08", visibleKeys: [] };
  const params = chartSearchParams(request, new URLSearchParams("window=24h"));
  expect(chartRequestFromSearch(params.toString())).toEqual(request);
  expect(params.get("window")).toBe("24h");
  expect(chartRequestFromSearch("explorerStep=invalid&explorerSeries=cached,cached,unknown")).toEqual({
    step: "08",
    referenceStep: undefined,
    visibleKeys: ["cached"],
  });
});

test("static report covers every offered state and the local slider offers thirteen times", () => {
  expect(queueSteps).toHaveLength(13);
  const snapshots = staticQueueSnapshots();
  expect(snapshots).toHaveLength(224);
  expect(new Set(snapshots.map((item) => JSON.stringify(item.request))).size).toBe(224);
  for (const item of snapshots) {
    expect(item.charts.queues.rows).toHaveLength(item.request.visibleKeys!.length);
    expect(item.charts.queues.chart.marks).toHaveLength(item.charts.queues.rows.length * (item.request.referenceStep ? 2 : 1));
  }
});

test("delivery map moves stable entities across thirteen times and keeps reference positions", async () => {
  const { deliverySnapshot, deliveryInitial, deliverySteps } = await import("./chart-map-data");
  expect(deliverySteps).toHaveLength(13);
  const initial = deliverySnapshot(deliveryInitial).charts.deliveries;
  const next = deliverySnapshot({ ...deliveryInitial, step: "20", referenceStep: "08" }).charts.deliveries;
  expect(next.chart.kind).toBe("map");
  expect(next.rows).toHaveLength(2);
  expect(next.chart.marks).toHaveLength(4);
  expect(next.chart.marks[0]!.datum.anchor).not.toEqual(initial.chart.marks[0]!.datum.anchor);
  expect(next.chart.marks[1]!.datum.anchor).toEqual(initial.chart.marks[0]!.datum.anchor);
  expect(next.chart.marks[0]!.rowKey).toBe(next.chart.marks[1]!.rowKey);
  expect(next.chart.marks[0]!.tooltip.rows).toContainEqual({ label: "Distance travelled", value: "290 km" });
  expect(deliverySnapshot({ ...deliveryInitial, visibleKeys: [] }).charts.deliveries.rows).toEqual([]);
});
