import { axisOption, commonOptions, inspectA11y } from "./common";
import type { ChartShowcaseExample } from "./types";

const months = [
  "2026-01-01",
  "2026-02-01",
  "2026-03-01",
  "2026-04-01",
  "2026-05-01",
  "2026-06-01",
  "2026-07-01",
  "2026-08-01",
  "2026-09-01",
  "2026-10-01",
];

const examples: ChartShowcaseExample[] = [
  {
    id: "line-visitors",
    kind: "line",
    question: "trend",
    title: "Line chart",
    summary: "One or more values over time. Inspect a month and every series answers at once.",
    spec: {
      kind: "line",
      title: "Visitors per month",
      subtitle: "Website · invented data",
      series: [
        {
          label: "This year",
          data: months.map((x, i) => ({ x, y: [18200, 19400, 21900, 21100, 23800, 26500, 25900, 27400, 29800, 31200][i]! })),
        },
        {
          label: "Last year",
          role: "reference",
          data: months.map((x, i) => ({ x, y: [16100, 16800, 18300, 18900, 19800, 21200, 21900, 22400, 23900, 24800][i]! })),
        },
      ],
      yAxis: { format: { style: "number", compact: true } },
      xAxis: { format: { date: "day" } },
      legend: true,
      smooth: true,
    },
    useFor: [
      "A value that changes continuously, such as visitors, revenue or response time.",
      "Up to four series on one scale, such as this year against last year.",
      "Many points: a line stays readable where columns would turn into stripes.",
    ],
    avoidFor: [
      "Categories without an order, such as products or countries; use a bar chart.",
      "Two values with different units; draw two charts instead of a second axis.",
      "A single number; use a key figure.",
    ],
    a11y: [...inspectA11y, "Arrow keys move along the time axis; the tooltip lists every series at that time."],
    options: [
      ...commonOptions,
      {
        name: "series",
        type: "{ label?, data: { x, y }[], role?, style? }[]",
        description:
          'Series of points; x is a number or ISO date, a missing y is null and leaves a gap. role "reference" draws a comparison series dashed.',
      },
      axisOption("xAxis"),
      axisOption("yAxis"),
      { name: "smooth", type: "boolean", description: "Draws a smooth curve through the points." },
      { name: "area", type: "boolean", description: "Fills the area under the first series." },
      { name: "references", type: "{ value, axis?, label? }[]", description: "Labelled reference lines, such as a target." },
      { name: "legend", type: "boolean", description: "Names the series; on by default with more than one series." },
    ],
  },
  {
    id: "line-latency",
    kind: "line",
    question: "trend",
    title: "Target and gaps",
    summary: "A reference line marks the target; a missing hour stays a gap instead of dropping to zero.",
    spec: {
      kind: "line",
      title: "Response time",
      subtitle: "p95 in milliseconds · last 12 hours",
      series: [
        {
          label: "p95",
          data: [212, 198, 205, 231, null, 264, 248, 226, 219, 241, 236, 228].map((y, i) => ({
            x: `2026-11-06T${String(i + 8).padStart(2, "0")}:00`,
            y,
          })),
        },
      ],
      xAxis: { format: { date: "minute" } },
      yAxis: { label: "ms", domain: [0, 300] },
      references: [{ value: 250, label: "Target 250 ms" }],
      area: true,
    },
    useFor: ["Operational values with a target or a limit.", "Data with gaps that must stay visible."],
    avoidFor: ["Filling a gap with zero; a missing value is null, never 0."],
    a11y: inspectA11y,
    options: [
      { name: "references", type: "{ value, axis?, label? }[]", description: "Labelled reference lines on the x or y axis." },
      { name: "yAxis.domain", type: "[min, max]", description: "Exact range of the axis; it must contain every value and reference." },
    ],
  },
];

export default examples;
