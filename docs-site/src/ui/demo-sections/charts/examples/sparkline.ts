import { commonOptions, inspectA11y } from "./common";
import type { ChartShowcaseExample } from "./types";

const examples: ChartShowcaseExample[] = [
  {
    id: "sparkline-subscribers",
    kind: "sparkline",
    question: "trend",
    title: "Sparkline",
    summary: "A word-sized trend without axes, next to a number or inside a table row.",
    spec: {
      kind: "sparkline",
      title: "Subscribers, last 12 weeks",
      data: [44120, 44380, 44210, 44690, 45020, 45310, 45180, 45840, 46420, 46910, 47530, 48210],
      area: true,
    },
    height: 96,
    useFor: ["The direction of a value next to the value itself.", "Many small trends in a list or table."],
    avoidFor: ["Exact values or dates; use a line chart with axes.", "Comparing series with each other."],
    a11y: inspectA11y,
    options: [
      ...commonOptions,
      { name: "data", type: "number[]", description: "Values in order; at least two." },
      { name: "area", type: "boolean", description: "Fills the area under the line." },
    ],
  },
];

export default examples;
