import { commonOptions, inspectA11y, numberFormatOption } from "./common";
import type { ChartShowcaseExample } from "./types";

const examples: ChartShowcaseExample[] = [
  {
    id: "donut-costs",
    kind: "donut",
    question: "share",
    title: "Donut chart",
    summary: "The same parts as a pie, with room in the middle. Shares read as arcs along the ring.",
    spec: {
      kind: "donut",
      title: "Costs by category",
      subtitle: "October · in euros",
      data: [
        { label: "Purchasing", value: 14800 },
        { label: "Staff", value: 9600 },
        { label: "Rent", value: 3200 },
        { label: "Other", value: 1920 },
      ],
      format: { style: "currency", currency: "EUR" },
      legend: true,
    },
    useFor: ["Parts of a budget or a total amount.", "Dashboards where several shares sit next to each other."],
    avoidFor: ["Precise comparison of similar parts; use bars.", "Parts that do not add up to a whole."],
    a11y: inspectA11y,
    options: [
      ...commonOptions,
      { name: "data", type: "{ label, value }[]", description: "Parts of the total; only values of zero and above." },
      numberFormatOption,
      { name: "legend", type: "boolean", description: "Names the parts below the ring." },
    ],
  },
];

export default examples;
