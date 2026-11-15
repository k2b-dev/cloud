import { expect, test } from "bun:test";
import { cardToolResult, cardToolView, chartToolResult, chartToolView } from "./gustav-views";
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

test("Gustav's lines are straight with hollow points unless he says otherwise; other kinds stay as described", () => {
  const saldo = {
    kind: "line",
    title: "Saldo",
    series: [{ label: "Saldo", data: [1, 0, 0, 3].map((y, index) => ({ x: `2026-0${index + 6}-01`, y })) }],
  };
  const description = (args: unknown) => (chartToolView(args)?.blocks[0] as { description?: Record<string, unknown> }).description;
  expect(description(saldo)).toMatchObject({ smooth: false, points: true });
  expect(description({ ...saldo, smooth: true, points: false })).toMatchObject({ smooth: true, points: false });
  expect(description(revenue)).not.toHaveProperty("points");
});

test("plain stat charts become one flat row of key figures; a stat with its own change or unit stays a chart", () => {
  const group = chartToolView({
    title: "Logistik",
    subtitle: "Stand 13:35",
    charts: [
      { kind: "stat", title: "Offene Aufgaben", value: 1366, subtitle: "Momentaufnahme" },
      { kind: "stat", title: "Diese Woche fällig", value: 3 },
    ],
  });
  expect(group?.blocks).toEqual([
    {
      kind: "Section",
      title: "Logistik",
      description: "Stand 13:35",
      children: [
        {
          kind: "Stats",
          items: [
            { label: "Offene Aufgaben", value: 1366, note: "Momentaufnahme" },
            { label: "Diese Woche fällig", value: 3 },
          ],
        },
      ],
    },
  ]);
  expect(chartToolView({ kind: "stat", title: "Umsatz", value: 12, sparkline: [1, 2, 3] })?.blocks).toEqual([
    { kind: "Stats", items: [{ label: "Umsatz", value: 12, trend: [1, 2, 3] }] },
  ]);
  expect(chartToolView({ kind: "stat", title: "Umsatz", value: 12, delta: 2 })?.blocks[0]).toMatchObject({ kind: "Chart" });
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

test("a card becomes one flat key figure with its change or scope as the quiet line", () => {
  const view = cardToolView({ title: "Girokonto", value: "2.481,20 €", trendValue: "+312,00 €", trendLabel: "seit 01.11.", emoji: "💶" });
  expect(view?.blocks).toEqual([{ kind: "Stats", items: [{ label: "Girokonto", value: "2.481,20 €", note: "+312,00 € seit 01.11." }] }]);
  expect(cardToolView({ title: "Tagesgeld", value: "12.050,00 €", caption: "2,1 % Zins" })?.blocks[0]).toMatchObject({
    items: [{ note: "2,1 % Zins" }],
  });
  // The icon is the small sign before the label; a name that is no Tabler icon is left out, the figure stays.
  expect(cardToolView({ title: "Girokonto", value: "2.481,20 €", icon: "building-bank" })?.blocks[0]).toEqual({
    kind: "Stats",
    items: [{ label: "Girokonto", value: "2.481,20 €", icon: "ti ti-building-bank" }],
  });
  expect(cardToolView({ title: "Girokonto", value: "1", icon: 'ti ti-x" bad' })?.blocks[0]).toEqual({
    kind: "Stats",
    items: [{ label: "Girokonto", value: "1" }],
  });
  expect(cardToolView({ title: "", value: "1" })).toBeNull();
  expect(modelCapabilityResult(cardToolResult({ title: "A", value: "1" }))).toMatchObject({ displayed: true });
});
