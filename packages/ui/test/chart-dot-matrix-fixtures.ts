import type { ChartProps } from "../src/content/Chart";
export const dotMatrixFixtures = [
  {
    kind: "bar",
    marks: "dots",
    layout: "nested",
    total: 1000,
    dots: 100,
    x: ["Mon", "Tue", "Wed", "Thu", "Fri"],
    series: [
      { label: "Opened", data: [780, 620, 810, 690, 570] },
      { label: "Clicked", data: [320, 210, 420, 290, 190] },
    ],
  },
  {
    kind: "bar",
    marks: "dots",
    layout: "nested",
    total: 100,
    dots: 40,
    x: ["North", "South", "East", "West"],
    series: [
      { label: "Delivered", data: [80, null, 60, 95] },
      { label: "Read", data: [30, null, 20, 65] },
    ],
  },
] satisfies ChartProps[];
