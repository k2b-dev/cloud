import { expect, test } from "bun:test";
import { CloudAiChartInputSchema } from "./default-tool-contracts";
import { parseCloudAiView } from "./view-block";

const bubble = {
  kind: "bubble",
  title: "Campaigns",
  groups: ["North"],
  xLabel: "Visits",
  yLabel: "Opens",
  averages: true,
  locale: "de-DE",
  data: [{ label: "A", group: "North", x: 1200, y: 2400, size: 3600 }],
};
const radar = {
  kind: "radar",
  title: "Score",
  axes: ["Quality", "Speed", "Cost"],
  max: 5,
  unit: "points",
  series: [
    { label: "A", data: [1, 2, 3] },
    { label: "B", data: [4, 3, 2] },
  ],
};
test("model schema preserves numeric bubble points and numeric radar series, including grouped charts", () => {
  expect(CloudAiChartInputSchema.parse(bubble)).toMatchObject(bubble);
  expect(CloudAiChartInputSchema.parse(radar)).toMatchObject(radar);
  expect(CloudAiChartInputSchema.safeParse({ title: "Group", charts: [bubble, radar] }).success).toBe(true);
});
test("model schema rejects invalid locales, domains and radar scales at the JSON entry", () => {
  for (const bad of [
    { ...bubble, locale: "de_DE" },
    { ...bubble, data: [{ ...bubble.data[0], size: -1 }] },
    {
      ...bubble,
      data: [
        { ...bubble.data[0], x: -1e308 },
        { ...bubble.data[0], x: 1e308 },
      ],
    },
    { ...radar, max: 0 },
    { ...radar, series: [{ label: "A", data: [1, 2, 6] }] },
    { kind: "bar", title: "Bar", locale: "de-DE", data: [{ label: "A", value: 3 }] },
  ])
    expect(CloudAiChartInputSchema.safeParse(bad).success).toBe(false);
});

test("saved view parse path preserves named distribution inputs", () => {
  expect(parseCloudAiView({ view: "chart", ...bubble })).toMatchObject({ view: "chart", ...bubble });
  expect(parseCloudAiView({ view: "chart", ...radar })).toMatchObject({ view: "chart", ...radar });
});
