import { commonOptions, inspectA11y } from "./common";
import type { ChartShowcaseExample } from "./types";

// Invented order values in euros: most orders are small, a few are large.
const orders = [
  12, 18, 19, 22, 24, 25, 27, 28, 29, 31, 32, 33, 34, 35, 36, 37, 38, 39, 41, 42, 42, 43, 44, 45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 57,
  58, 59, 61, 62, 64, 66, 68, 69, 71, 73, 76, 78, 81, 84, 88, 92, 97, 104, 112, 125, 141, 168,
];

const examples: ChartShowcaseExample[] = [
  {
    id: "histogram-orders",
    kind: "histogram",
    question: "distribution",
    title: "Histogram",
    summary: "How many values fall into each range. The shape shows where most values are and how far they spread.",
    spec: {
      kind: "histogram",
      title: "Order values",
      subtitle: "Last 30 days · in euros",
      data: orders,
      bins: [0, 20, 40, 60, 80, 100, 120, 140, 160, 180],
      tooltip: { label: "Orders" },
    },
    useFor: ["The spread of one measure across many items.", "Spotting skew, gaps and a second peak."],
    avoidFor: ["Few values; show them as points.", "Comparing groups; use box plots side by side."],
    a11y: [...inspectA11y, "Each bin names its range and its count; the last bin includes its upper edge."],
    options: [
      ...commonOptions,
      { name: "data", type: "number[]", description: "The raw values." },
      { name: "bins", type: "number | number[]", description: "A bin count or ascending bin edges." },
      { name: "references", type: "{ value, label? }[]", description: "Reference lines, such as the median." },
    ],
  },
];

export default examples;
