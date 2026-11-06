import type { ChartProps } from "../src/content/Chart";
export const barFamilyFixtures = [
  {
    kind: "bar",
    title: "Orders by channel",
    x: ["Q1", "Q2", "Q3", "Q4"],
    series: [
      { label: "Store", data: [350, 420, 510, 480] },
      { label: "Web", data: [240, 310, 420, 530] },
      { label: "Fair", data: [90, 120, 180, 100] },
    ],
    layout: "grouped",
  },
  {
    kind: "bar",
    title: "Stacked orders",
    x: ["Q1", "Q2", "Q3", "Q4"],
    series: [
      { label: "Store", data: [350, 420, 510, 480] },
      { label: "Web", data: [240, 310, 420, 530] },
    ],
    layout: "stacked",
  },
  {
    kind: "bar",
    title: "Revenue across periods",
    x: ["1–7", "8–14", "15–21", "22–28"],
    series: [{ label: "October", data: [3100, 4200, 5100, 4800] }],
    compare: { label: "September", data: [2700, 3900, 4600, 4100] },
  },
  {
    kind: "hbar",
    title: "Orders by category",
    series: ["Q1", "Q2", "Q3", "Q4"],
    rows: [
      { group: "Store", label: "Furniture", values: [35, 36, 50, 43] },
      { group: "Store", label: "Lighting", values: [49, 46, 47, 34] },
      { group: "Web", label: "Furniture", values: [50, 43, 39, 46] },
      { group: "Web", label: "Pictures", values: [41, 37, 40, 43] },
    ],
  },
] satisfies ChartProps[];
