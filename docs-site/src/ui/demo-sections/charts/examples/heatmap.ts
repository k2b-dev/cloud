import { commonOptions, inspectA11y, numberFormatOption } from "./common";
import type { ChartShowcaseExample } from "./types";

const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hours = ["6–9", "9–12", "12–15", "15–18", "18–21", "21–24"];
// Opens per time slot: Thursday morning is when the newsletter goes out.
const opens = [
  [120, 340, 260, 210, 380, 290],
  [110, 310, 240, 200, 350, 270],
  [130, 330, 250, 220, 360, 280],
  [420, 1280, 860, 540, 610, 380],
  [140, 300, 230, 190, 280, 210],
  [60, 180, 220, 200, 260, 240],
  [50, 160, 210, 230, 310, 260],
];

const examples: ChartShowcaseExample[] = [
  {
    id: "heatmap-opens",
    kind: "heatmap",
    question: "distribution",
    title: "Heatmap",
    summary: "A value for every pair of two categories, such as day and hour. Patterns appear as bright patches.",
    spec: {
      kind: "heatmap",
      title: "Newsletter opens by day and time",
      subtitle: "Last 8 weeks · invented data",
      data: days.flatMap((y, row) => hours.map((x, column) => ({ x, y, value: opens[row]![column]! }))),
      tooltip: { label: "Opens" },
    },
    height: 280,
    useFor: ["Patterns across two categories, such as weekday and hour.", "Spotting the busiest and quietest combinations."],
    avoidFor: ["Exact comparison of values; color is read only roughly.", "More rows than fit the frame; group them first."],
    a11y: [...inspectA11y, "Arrow keys move cell by cell; the tooltip names both categories and the value."],
    options: [
      ...commonOptions,
      { name: "data", type: "{ x, y, value }[]", description: "One cell per pair; x names the column, y the row." },
      { name: "showValues", type: "boolean", description: "Prints the value in every cell that fits it." },
      { name: "min, max", type: "number", description: "Fixed ends of the color scale." },
      numberFormatOption,
    ],
  },
];

export default examples;
