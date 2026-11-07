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
