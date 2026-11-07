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

/**
 * The page an example belongs to: its kind, or a layout that reads as a kind of its own, such as the calendar layout
 * of a heatmap. A later `Chart.Calendar` (kind "calendar") lands on the same page.
 */
export const pageKind = (example: ChartShowcaseExample): string => {
  const spec = example.spec;
  const layout = spec !== null && typeof spec === "object" && !Array.isArray(spec) ? spec.layout : undefined;
  return example.kind === "heatmap" && layout === "calendar" ? "calendar" : example.kind;
};

/** One page per kind, in registry order; a known catalog name titles it, the first example describes it. */
export const chartShowcaseKinds: readonly ChartShowcaseKind[] = [...new Set(chartShowcaseExamples.map(pageKind))].map((kind) => {
  const examples = chartShowcaseExamples.filter((example) => pageKind(example) === kind);
  const first = examples[0]!;
  const title = plannedChartKinds.find((planned) => planned.kind === kind)?.title ?? first.title;
  return { kind, slug: slug(kind), title, summary: first.summary, question: first.question, examples };
});

export const chartShowcaseKind = (slugOrKind: string) =>
  chartShowcaseKinds.find((entry) => entry.slug === slugOrKind || entry.kind === slugOrKind);

/** Planned kinds without an example yet, by question. */
export const plannedChartSlots = (question: ChartShowcaseQuestion) =>
  plannedChartKinds.filter((planned) => planned.question === question && !chartShowcaseKinds.some((entry) => entry.kind === planned.kind));

export type { ChartShowcaseExample, ChartShowcaseQuestion };
export { chartShowcaseQuestions };
