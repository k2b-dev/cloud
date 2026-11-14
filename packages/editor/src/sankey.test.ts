import { expect, test } from "bun:test";
import { chartKinds, chartMarks, chartRenderOptions, chartTable } from "./charts";

const input = {
  kind: "sankey",
  title: "Paths",
  nodes: [
    { id: "a", label: "Click" },
    { id: "b", label: "Read" },
  ],
  links: [{ source: "a", target: "b", value: 1234.5 }],
};
test("Sankey JSON validates graph semantics and keeps typed table rows and locale", () => {
  const schema = chartKinds();
  const parsed = schema.parse(input);
  expect(chartMarks(parsed)).toBe(3);
  expect(chartTable(parsed, "de").columns[0]?.label).toBe("Fluss");
  expect(schema.safeParse({ ...input, locale: "de_DE" }).success).toBe(false);
  expect(
    schema.safeParse({
      ...input,
      links: [
        { source: "b", target: "a", value: 2 },
        { source: "a", target: "b", value: 1 },
      ],
    }).success,
  ).toBe(false);
  const table = chartTable(parsed, "de");
  expect(table.rows).toHaveLength(3);
  expect(table.rows.find((r) => r.cells.label === "Click → Read")?.cells.value).toBe("1.234,5");
  expect(chartRenderOptions(parsed, "en", { width: 900 })).toMatchObject({ displayWidth: 900 });
});

test("notebook reserves the full wrapped Sankey legend height", async () => {
  const { notebookChartHeight } = await import("./markdown/lib/chart-blocks");
  const { sankeyLayout } = await import("@k2b/ui/charts/core");
  const parsed = chartKinds().parse({
    ...input,
    legend: Array.from({ length: 60 }, (_, i) => ({ tone: "tax", label: "Long meaning " + i })),
  });
  const options = chartRenderOptions(parsed, "en", { legend: "outside" });
  if (options.kind !== "sankey") throw new Error("Expected Sankey");
  expect(notebookChartHeight(parsed, "en")).toBe(sankeyLayout(options).height);
  expect(notebookChartHeight(parsed, "en")).toBeGreaterThan(280);
});
