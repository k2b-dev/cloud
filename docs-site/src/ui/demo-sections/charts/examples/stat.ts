import { commonOptions, inspectA11y, numberFormatOption } from "./common";
import type { ChartShowcaseExample } from "./types";

const examples: ChartShowcaseExample[] = [
  {
    id: "stat-revenue",
    kind: "stat",
    question: "numbers",
    title: "Key figure",
    summary: "One number with its change and a small trend. Green or red only when “better” is set.",
    spec: {
      kind: "stat",
      title: "Revenue from the newsletter",
      subtitle: "October against September",
      value: 18420,
      format: { style: "currency", currency: "EUR" },
      delta: 2460,
      better: "up",
      sparkline: [11200, 12900, 12100, 14300, 15960, 18420],
    },
    height: 160,
    useFor: ["The one number a reader needs first, with its direction."],
    avoidFor: ["Several equal numbers in a row; use key figure tiles.", "A change without knowing what is better; leave better out."],
    a11y: inspectA11y,
    options: [
      ...commonOptions,
      { name: "value", type: "number", description: "The key figure." },
      numberFormatOption,
      { name: "delta", type: "number", description: "Change against the previous period, in the format of the value." },
      { name: "better", type: '"up" | "down"', description: "Which direction is good; only then the change is colored." },
      { name: "sparkline", type: "number[]", description: "The recent trend behind the number." },
    ],
  },
];

export default examples;
