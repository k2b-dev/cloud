import { isExampleList } from "./files";
import { exampleModules } from "./registry.generated";
import { type ChartShowcaseExample, type ChartShowcaseQuestion, chartShowcaseQuestions, plannedChartKinds } from "./types";

/**
 * Every example of the chart showcase: one file per kind in this folder (registry.generated.ts lists them; every Fibel
 * start and build regenerates it). A file may export its list as default or by any name. The overview, the kind
 * pages, the dashboards and the browser test all read this list, ordered by question.
 */
export const chartShowcaseExamples: readonly ChartShowcaseExample[] = [
  ...new Map(
    exampleModules
      .flatMap((module) => [...new Set(Object.values(module))].filter(isExampleList))
      .flat()
      .map((example) => [example.id, example] as const),
  ).values(),
].sort(
  (a, b) =>
    chartShowcaseQuestions.findIndex((question) => question.id === a.question) -
    chartShowcaseQuestions.findIndex((question) => question.id === b.question),
);

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
