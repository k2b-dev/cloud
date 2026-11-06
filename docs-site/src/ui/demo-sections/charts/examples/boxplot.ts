import { axisOption, commonOptions, inspectA11y } from "./common";
import type { ChartShowcaseExample } from "./types";

const examples: ChartShowcaseExample[] = [
  {
    id: "boxplot-delivery",
    kind: "boxplot",
    question: "distribution",
    title: "Box plot",
    summary: "The middle half, the median and the outliers of several groups, side by side.",
    spec: {
      kind: "boxplot",
      title: "Delivery time by carrier",
      subtitle: "Days from order to door · invented data",
      data: [
        { label: "Carrier A", values: [1.2, 1.5, 1.8, 2.0, 2.1, 2.3, 2.4, 2.6, 2.9, 3.1, 3.4, 6.2] },
        { label: "Carrier B", values: [1.9, 2.2, 2.5, 2.7, 2.8, 3.0, 3.2, 3.5, 3.6, 3.9, 4.2, 4.4] },
        { label: "Carrier C", values: [0.9, 1.0, 1.1, 1.2, 1.3, 1.3, 1.4, 1.6, 1.7, 1.9, 4.8, 5.1] },
        { label: "Pickup", values: [0.5, 0.6, 0.8, 0.9, 1.0, 1.0, 1.1, 1.2, 1.4, 1.5, 1.6, 1.8] },
      ],
      yAxis: { label: "Days" },
    },
    useFor: ["Comparing the spread of several groups.", "Showing outliers without hiding the typical range."],
    avoidFor: [
      "Readers who do not know box plots; a histogram or a short sentence may say more.",
      "Fewer than about ten values per group.",
    ],
    a11y: [...inspectA11y, "The tooltip reads the box in words: median, lower and upper quartile, whiskers and the count."],
    options: [
      ...commonOptions,
      { name: "data", type: "{ label, values: number[] }[]", description: "One group of raw values per box; the quartiles are computed." },
      axisOption("yAxis"),
    ],
  },
];

export default examples;
