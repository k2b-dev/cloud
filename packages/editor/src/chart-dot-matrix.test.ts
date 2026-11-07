import { expect, test } from "bun:test";
import { chartKinds, chartMarks, chartRenderOptions, chartTable } from "./charts";

const spec = {
  kind: "bar",
  title: "Campaign",
  marks: "dots",
  layout: "nested",
  total: 100,
  dots: 20,
  x: ["A", "B"],
  series: [
    { label: "Opened", data: [80, null] },
    { label: "Clicked", data: [30, null] },
  ],
};
const schema = chartKinds();
test("portable nested dots validate subsets and preserve source counts and gaps", () => {
  const input = schema.parse(spec);
  expect(chartRenderOptions(input, "en")).toMatchObject({ marks: "dots", total: 100, dots: 20 });
  expect(chartMarks(input)).toBe(40);
  expect(chartTable(input, "en").rows[0]!.values["series:0"]).toBe(80);
  expect(chartTable(input, "en").rows[1]!.cells["series:0"]).toBe("–");
  for (const invalid of [
    { dots: 3 },
    { total: 50 },
    { dots: 0 },
    { layout: "stacked" },
    { marks: "bars" },
    { normalize: true },
    {
      series: [
        { label: "A", data: [30, 20] },
        { label: "B", data: [40, 10] },
      ],
    },
  ])
    expect(schema.safeParse({ ...spec, ...invalid }).success).toBe(false);
});

test("portable percentage matrices use latest values in the legend instead of summed shares", () => {
  const input = chartKinds().parse({
    kind: "bar",
    title: "Newsletter",
    marks: "dots",
    layout: "nested",
    total: 1,
    x: ["Jan", "Feb"],
    series: [
      { label: "Opened", data: [0.45, 0.6] },
      { label: "Clicked", data: [0.2, 0.25] },
    ],
    format: { style: "percent" },
  });
  expect(chartRenderOptions(input, "en")).toMatchObject({ legendValues: "latest" });
  const axisInput = chartKinds().parse({ ...input, format: undefined, yAxis: { format: { style: "percent" } } });
  expect(chartRenderOptions(axisInput, "en")).toMatchObject({ legendValues: "latest" });
});
