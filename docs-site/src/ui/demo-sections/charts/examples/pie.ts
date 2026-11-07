import { commonOptions, inspectA11y, numberFormatOption } from "./common";
import type { ChartShowcaseExample } from "./types";

const examples: ChartShowcaseExample[] = [
  {
    id: "pie-devices",
    kind: "pie",
    question: "share",
    title: "Pie chart",
    summary: "A few parts of one whole. Each slice shows its share; the tooltip adds the amount.",
    spec: {
      kind: "pie",
      title: "Visits by device",
      subtitle: "October · invented data",
      data: [
        { label: "Phone", value: 14820 },
        { label: "Desktop", value: 9240 },
        { label: "Tablet", value: 2110 },
      ],
      showLabels: true,
      legend: true,
    },
    useFor: ["Two to five parts that add up to one meaningful total."],
    avoidFor: ["Comparing parts of similar size; use bars.", "More than six parts; group the small ones as “Other”.", "Changes over time."],
    a11y: [...inspectA11y, "The tooltip names the slice, its amount and its share of the total."],
    options: [
      ...commonOptions,
      { name: "data", type: "{ label, value }[]", description: "Parts of the total; only values of zero and above." },
      { name: "showLabels", type: "boolean", description: "Prints the share on large enough slices." },
      { name: "legend", type: "boolean", description: "Names the slices below the chart." },
      numberFormatOption,
    ],
  },
];

export default examples;
