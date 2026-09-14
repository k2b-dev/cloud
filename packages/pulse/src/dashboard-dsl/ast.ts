import type {
  PulseDashboardCondition,
  PulseDashboardControl,
  PulseDashboardMetricWidget,
  PulseDashboardRow,
  PulseDashboardStatesWidget,
  PulseExplorerQuery,
  PulseMapFieldSelector,
} from "../contracts";

type DashboardDslDiagnostic = {
  severity: "error";
  message: string;
  line: number;
  column: number;
};

export type Result<T> = { ok: true; data: T; diagnostics: DashboardDslDiagnostic[] } | { ok: false; diagnostics: DashboardDslDiagnostic[] };

export type DashboardDslDocument = {
  kind: "dashboard";
  title: string;
  description: string | null;
  controls: DashboardDslControl[];
  blocks: DashboardDslBlock[];
};

export type DashboardDslBlock =
  | DashboardDslSection
  | DashboardDslCard
  | DashboardDslMarkdown
  | DashboardDslVisual
  | DashboardDslMap
  | DashboardDslRow;

export type DashboardDslControl = {
  kind: PulseDashboardControl["kind"];
  label: string;
  variable: string;
  defaultValue: string;
  options: string[];
  resourceType: string | null;
};

export type ControlOptionState = {
  variable: string;
  defaultValue: string;
  options: string[];
  resourceType: string | null;
};

export type DashboardContainerBody = {
  description: string | null;
  controls: DashboardDslControl[];
  blocks: DashboardDslBlock[];
};

export type MarkdownBlockState = {
  description: string | null;
  content: string | null;
};

export type VisualBlockState = {
  description: string | null;
  query: string | null;
  queryPosition: Position | null;
  visual: DashboardDslVisual["visual"];
  conditions: PulseDashboardCondition[];
};

export type MapBlockState = {
  description: string | null;
  query: string | null;
  queryPosition: Position | null;
  latitude: PulseMapFieldSelector | null;
  longitude: PulseMapFieldSelector | null;
  label: PulseMapFieldSelector | null;
  series: PulseMapFieldSelector | null;
  size: "count" | "sum";
};

export type DashboardDslSection = {
  kind: "section";
  title: string;
  description: string | null;
  blocks: DashboardDslBlock[];
};

export type DashboardDslCard = {
  kind: "card";
  title: string;
  description: string | null;
  span: number | null;
  blocks: DashboardDslBlock[];
};

export type DashboardDslRow = {
  kind: "row";
  height: PulseDashboardRow["height"];
  blocks: DashboardDslBlock[];
};

export type DashboardDslMarkdown = {
  kind: "markdown";
  title: string | null;
  description: string | null;
  markdown: string;
  span: number | null;
};

export type DashboardDslVisual = {
  kind: "visual";
  title: string;
  visual: PulseDashboardMetricWidget["visual"] | PulseDashboardStatesWidget["visual"];
  description: string | null;
  query: string | null;
  queryPosition: Position | null;
  span: number | null;
  conditions: PulseDashboardCondition[];
};

export type DashboardDslMap = {
  kind: "map";
  title: string;
  description: string | null;
  query: string | null;
  queryPosition: Position | null;
  latitude: PulseMapFieldSelector | null;
  longitude: PulseMapFieldSelector | null;
  label: PulseMapFieldSelector | null;
  series: PulseMapFieldSelector | null;
  size: "count" | "sum";
  span: number | null;
};

export type Position = {
  index: number;
  line: number;
  column: number;
};

export type CompileQuery = (query: string) => { ok: true; data: PulseExplorerQuery } | { ok: false; message: string };
export type UniqueDashboardId = (prefix: string, title: string) => string;

export type DashboardCompilerContext = {
  document: DashboardDslDocument;
  compileQuery: CompileQuery;
  diagnostics: DashboardDslDiagnostic[];
  uniqueId: UniqueDashboardId;
};
