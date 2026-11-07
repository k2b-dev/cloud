import { commonOptions, inspectA11y, numberFormatOption } from "./common";
import type { ChartShowcaseExample } from "./types";

const examples: ChartShowcaseExample[] = [
  {
    id: "bar-gauge-quotas",
    kind: "barGauge",
    question: "compare",
    title: "Bar gauge",
    summary: "Several values against the same range, one row each, with bands for close and too much.",
    spec: {
      kind: "barGauge",
      title: "Mailbox quota",
      subtitle: "Used of 10 GB · invented data",
      data: [
        { label: "Support", value: 8.7 },
        { label: "Sales", value: 6.2 },
        { label: "Accounting", value: 4.9 },
        { label: "Office", value: 2.4 },
      ],
      min: 0,
      max: 10,
      unit: "GB",
      thresholds: [
        { value: 7, label: "Close" },
        { value: 9, label: "Full" },
      ],
    },
    useFor: ["Usage of several accounts, rooms or machines against the same limit."],
    avoidFor: ["Values without a shared maximum; use a bar chart."],
    a11y: inspectA11y,
    options: [
      ...commonOptions,
      { name: "data", type: "{ label, value, min?, max? }[]", description: "One row per item; up to eight rows fit the frame." },
      { name: "min, max", type: "number", description: "The shared range." },
      { name: "unit", type: "string", description: "Unit after each value." },
      numberFormatOption,
      { name: "thresholds", type: "{ value, label? }[]", description: "Band edges for every row." },
    ],
  },
];

export default examples;
