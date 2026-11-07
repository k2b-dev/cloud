import type { CodeChartDescription, CodePageTree } from "./page-contract";
/** Children are descriptions, never DOM nodes or callback handlers. Core checks that the root is Page. */
export type CodePageNode = CodePageTree["children"][number];
export type CodePageChild = CodePageNode | CodePageTree | readonly CodePageChild[] | false | null | undefined;
export type CodePageComponent<P> = (props: P) => CodePageNode | CodePageTree;
type CodeNodeProps<K extends CodePageNode["kind"]> = Omit<Extract<CodePageNode, { kind: K }>, "kind">;
export declare const Page: CodePageComponent<{ title: string; children?: CodePageChild }>;
export declare const Section: CodePageComponent<{ title: string; children?: CodePageChild }>;
export declare const Text: CodePageComponent<{ text?: string; children?: string | number | readonly (string | number)[] }>;
export declare const Heading: CodePageComponent<{
  text?: string;
  children?: string | number | readonly (string | number)[];
  level?: 2 | 3 | 4;
}>;
export declare const Table: CodePageComponent<CodeNodeProps<"Table">>;
export declare const Form: CodePageComponent<CodeNodeProps<"Form">>;
export declare const Detail: CodePageComponent<CodeNodeProps<"Detail">>;
export declare const Link: CodePageComponent<CodeNodeProps<"Link">>;
export declare const Button: CodePageComponent<Omit<Extract<CodePageNode, { kind: "Button" | "Action" }>, "kind">>;
export declare const Action: typeof Button;
export declare const Notice: CodePageComponent<CodeNodeProps<"Notice">>;
type CodeChartProps<K> = CodeChartDescription extends infer D
  ? D extends { kind: infer Kind }
    ? K extends Kind
      ? Omit<D, "kind">
      : never
    : never
  : never;
export declare const Chart: CodePageComponent<CodeNodeProps<"Chart">> & {
  Bar: CodePageComponent<CodeChartProps<"bar">>;
  Line: CodePageComponent<CodeChartProps<"line">>;
  Scatter: CodePageComponent<CodeChartProps<"scatter">>;
  Pie: CodePageComponent<CodeChartProps<"pie">>;
  Donut: CodePageComponent<CodeChartProps<"donut">>;
  Histogram: CodePageComponent<CodeChartProps<"histogram">>;
  Gauge: CodePageComponent<CodeChartProps<"gauge">>;
  Sparkline: CodePageComponent<CodeChartProps<"sparkline">>;
  Boxplot: CodePageComponent<CodeChartProps<"boxplot">>;
  Heatmap: CodePageComponent<CodeChartProps<"heatmap">>;
  BarGauge: CodePageComponent<CodeChartProps<"barGauge">>;
  Stat: CodePageComponent<CodeChartProps<"stat">>;
};
export declare function jsx<P>(component: CodePageComponent<P>, props: P | null, ...children: CodePageChild[]): CodePageNode | CodePageTree;
export declare namespace jsx {
  namespace JSX {
    type Element = CodePageNode | CodePageTree;
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicElements {}
  }
}
