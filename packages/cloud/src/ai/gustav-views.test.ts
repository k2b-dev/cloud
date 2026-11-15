import { expect, test } from "bun:test";
import { chartToolResult, chartToolView } from "./gustav-views";
import { capabilityResultView, modelCapabilityResult } from "./result-view";

const revenue = {
  kind: "bar",
  title: "Revenue per month",
  subtitle: "EUR, 2026",
  data: [
    { label: "Jan", value: 1200 },
    { label: "Feb", value: 980 },
  ],
};

test("one chart becomes one Chart block with the same description", () => {
  const view = chartToolView(revenue);
  expect(view?.blocks).toHaveLength(1);
  expect(view?.blocks[0]).toMatchObject({ kind: "Chart", description: { kind: "bar", title: "Revenue per month", subtitle: "EUR, 2026" } });
});

test("a group becomes its charts under the group's title, side by side in a grid", () => {
  const view = chartToolView({ title: "Shop", layout: "grid", charts: [revenue, { ...revenue, title: "Orders" }] });
  expect(view?.blocks).toEqual([
    expect.objectContaining({
      kind: "Section",
      title: "Shop",
      children: [expect.objectContaining({ kind: "Chart", width: "half" }), expect.objectContaining({ kind: "Chart", width: "half" })],
    }),
  ]);
});

test("input a block cannot hold keeps the tool's own drawing", () => {
  expect(chartToolView({ kind: "bar", title: "Empty", data: [] })).toBeNull();
  expect(chartToolView("not a chart")).toBeNull();
  const wide = {
    kind: "line",
    title: "Too many lines",
    series: Array.from({ length: 9 }, (_, index) => ({ name: `S${index}`, data: [1, 2] })),
    x: ["a", "b"],
  };
  expect(chartToolView(wide)).toBeNull();
});

test("the stored result binds as a view for people while the model reads only that it was shown", () => {
  const result = chartToolResult(revenue);
  expect(capabilityResultView(result)?.blocks[0]).toMatchObject({ kind: "Chart" });
  expect(modelCapabilityResult(result)).toEqual({ displayed: true, data: {}, viewSummary: expect.any(String) });
  // An older stored result has no view and stays as it was.
  expect(capabilityResultView({ displayed: true })).toBeNull();
});
