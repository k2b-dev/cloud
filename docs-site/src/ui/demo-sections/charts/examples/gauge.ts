import { commonOptions, inspectA11y, numberFormatOption } from "./common";
import type { ChartShowcaseExample } from "./types";

const examples: ChartShowcaseExample[] = [
  {
    id: "gauge-storage",
    kind: "gauge",
    question: "numbers",
    title: "Gauge",
    summary: "One value within a known range, with bands that say when it is fine, close or too much.",
    spec: {
      kind: "gauge",
      title: "Storage used",
      subtitle: "Of 2 TB · invented data",
      value: 1.46,
      min: 0,
      max: 2,
      unit: "TB",
      format: { decimals: 2 },
      thresholds: [
        { value: 1.4, label: "Plan more" },
        { value: 1.8, label: "Full soon" },
      ],
    },
    useFor: ["One value against a fixed limit, such as storage, quota or capacity."],
    avoidFor: ["Values without a natural maximum.", "Several values; use a bar gauge."],
    a11y: inspectA11y,
    options: [
      ...commonOptions,
      { name: "value", type: "number", description: "The current value; the needle stops at the range, the tooltip keeps the real value." },
      { name: "min, max", type: "number", description: "The range of the dial." },
      { name: "unit", type: "string", description: "Unit after the value." },
      numberFormatOption,
      { name: "thresholds", type: "{ value, label? }[]", description: "Band edges; each band gets its own color." },
    ],
  },
];

export default examples;
