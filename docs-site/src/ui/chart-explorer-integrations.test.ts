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
  expect(snapshots).toHaveLength(24);
  expect(new Set(snapshots.map((item) => JSON.stringify(item.request))).size).toBe(24);
  for (const item of snapshots) {
    expect(item.charts.queues.rows).toHaveLength(item.request.visibleKeys!.length);
    expect(item.charts.queues.chart.marks).toHaveLength(item.charts.queues.rows.length * (item.request.referenceStep ? 2 : 1));
  }
});
