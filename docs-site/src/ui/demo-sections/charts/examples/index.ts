import bar from "./bar";
import barGauge from "./barGauge";
import boxplot from "./boxplot";
import donut from "./donut";
import gauge from "./gauge";
import heatmap from "./heatmap";
import histogram from "./histogram";
import line from "./line";
import map from "./map";
import pie from "./pie";
import scatter from "./scatter";
import sparkline from "./sparkline";
import stat from "./stat";
import stateTimeline from "./stateTimeline";
import { type ChartShowcaseExample, type ChartShowcaseQuestion, chartShowcaseQuestions, plannedChartKinds } from "./types";

/**
 * Every example of the chart showcase, one file per kind. Add a kind by adding its file and one line here; the
 * registry test fails for a file that is not listed. The overview, the kind pages, the dashboards and the browser
 * test all read this list.
 */
export const chartShowcaseExamples: readonly ChartShowcaseExample[] = [
  ...line,
  ...sparkline,
  ...bar,
  ...barGauge,
  ...pie,
  ...donut,
  ...stateTimeline,
  ...scatter,
  ...histogram,
  ...boxplot,
  ...heatmap,
  ...map,
  ...stat,
  ...gauge,
];

export type ChartShowcaseKind = {
  kind: string;
  /** URL segment, such as "bar-gauge". */
  slug: string;
  title: string;
  summary: string;
  question: ChartShowcaseQuestion;
  examples: readonly ChartShowcaseExample[];
};

const slug = (kind: string) => kind.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** One page per kind, in registry order; the first example names and describes the kind. */
export const chartShowcaseKinds: readonly ChartShowcaseKind[] = [...new Set(chartShowcaseExamples.map((example) => example.kind))].map(
  (kind) => {
    const examples = chartShowcaseExamples.filter((example) => example.kind === kind);
    const first = examples[0]!;
    return { kind, slug: slug(kind), title: first.title, summary: first.summary, question: first.question, examples };
  },
);

export const chartShowcaseKind = (slugOrKind: string) =>
  chartShowcaseKinds.find((entry) => entry.slug === slugOrKind || entry.kind === slugOrKind);

/** Planned kinds without an example yet, by question. */
export const plannedChartSlots = (question: ChartShowcaseQuestion) =>
  plannedChartKinds.filter((planned) => planned.question === question && !chartShowcaseKinds.some((entry) => entry.kind === planned.kind));

export type { ChartShowcaseExample, ChartShowcaseQuestion };
export { chartShowcaseQuestions };
