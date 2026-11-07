/** JSON as a portable chart description stores it: no functions, dates as ISO text, missing values as null. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** What a reader wants to show; the overview groups every example by it. */
export type ChartShowcaseQuestion = "trend" | "compare" | "share" | "flow" | "distribution" | "numbers";

/**
 * One live example of the chart showcase. Every file in this folder exports a list of these; the overview, the page of
 * each kind, the example dashboards and the browser test all read the same list, so no page can drift from its code.
 */
export type ChartShowcaseExample = {
  /** Unique, stable and URL-safe, such as "line-forecast". */
  id: string;
  /** Chart kind ("line", "sankey", …) or Cloud block ("stats", "table", "budget", …). */
  kind: string;
  question: ChartShowcaseQuestion;
  /** English UI docs language, invented data only. */
  title: string;
  summary: string;
  /** The portable description: `{ kind, … }` for a chart, `{ block, … }` for a block. */
  spec: JsonValue;
  /** Content height in pixels; defaults to 240. */
  height?: number;
  width?: "third" | "half" | "twoThirds" | "full";
  useFor: string[];
  avoidFor: string[];
  /** Keyboard and screen reader behaviour. */
  a11y: string[];
  options: { name: string; type: string; description: string }[];
};

export const chartShowcaseQuestions: readonly {
  id: ChartShowcaseQuestion;
  title: string;
  question: string;
  description: string;
  icon: string;
}[] = [
  {
    id: "trend",
    title: "Trend",
    question: "How does a value change over time?",
    description: "Lines, columns over time and small trend lines for one or many series.",
    icon: "ti ti-chart-line",
  },
  {
    id: "compare",
    title: "Compare",
    question: "Which category is larger?",
    description: "Columns, rows and ranked bars that put categories side by side.",
    icon: "ti ti-chart-bar",
  },
  {
    id: "share",
    title: "Share",
    question: "What part of the whole is each piece?",
    description: "Slices and parts of one total that add up to 100 %.",
    icon: "ti ti-chart-donut",
  },
  {
    id: "flow",
    title: "Flow",
    question: "Where does it come from and where does it go?",
    description: "Steps, states over time and amounts that move from one place to another.",
    icon: "ti ti-arrows-split",
  },
  {
    id: "distribution",
    title: "Distribution",
    question: "How are the values spread?",
    description: "Points, bins, boxes and grids that show spread, clusters and outliers.",
    icon: "ti ti-chart-dots-3",
  },
  {
    id: "numbers",
    title: "Numbers and money",
    question: "What is the one number that matters?",
    description: "Key figures, progress against a target and amounts with a direction.",
    icon: "ti ti-currency-euro",
  },
];

/**
 * Kinds of the approved catalog that have no example yet. The overview shows each as a quiet slot in its group until a
 * file in this folder adds an example of that kind; then the slot disappears by itself.
 */
export const plannedChartKinds: readonly { kind: string; title: string; question: ChartShowcaseQuestion }[] = [
  { kind: "area", title: "Area, absolute and 100 %", question: "trend" },
  { kind: "dots", title: "Dot matrix", question: "trend" },
  { kind: "calendar", title: "Calendar heatmap", question: "trend" },
  { kind: "hbar", title: "Horizontal bars with totals", question: "compare" },
  { kind: "pareto", title: "Pareto", question: "compare" },
  { kind: "funnel", title: "Funnel", question: "compare" },
  { kind: "treemap", title: "Treemap", question: "share" },
  { kind: "sankey", title: "Sankey", question: "flow" },
  { kind: "balanceFlow", title: "Balance flow", question: "flow" },
  { kind: "waterfall", title: "Waterfall", question: "flow" },
  { kind: "bubble", title: "Bubbles with names", question: "distribution" },
  { kind: "radar", title: "Radar", question: "distribution" },
  { kind: "stats", title: "Key figure tiles", question: "numbers" },
  { kind: "flow", title: "Amount with direction", question: "numbers" },
  { kind: "balance", title: "Balance line", question: "numbers" },
  { kind: "budget", title: "Budget", question: "numbers" },
  { kind: "table", title: "Table", question: "numbers" },
];
