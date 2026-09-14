import type { Completion, SuggestContext, Suggestion } from "@k2b/ui";
import type {
  PulseCurrentState,
  PulseMetricSeries,
  PulseMetricSummary,
  PulseRecordedEvent,
  PulseSignalField,
  PulseSource,
} from "../contracts";
import { AGGREGATIONS } from "../contracts";

type PulseQueryAuthoringInventory = {
  metrics: PulseMetricSummary[];
  events?: PulseRecordedEvent[];
  states?: PulseCurrentState[];
  sources: PulseSource[];
  series: PulseMetricSeries[];
  fields?: PulseSignalField[];
};

type QueryStatement = "metric" | "events" | "states";

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const quoteQueryValue = (value: string): string =>
  /[\s,=]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;

const previousToken = (text: string, tokenStart: number): string => {
  const before = text.slice(0, tokenStart).trimEnd();
  const parts = before.split(/\s+/);
  return parts.at(-1)?.toLowerCase() ?? "";
};

const tokensBefore = (text: string, tokenStart: number): string[] => text.slice(0, tokenStart).trim().split(/\s+/).filter(Boolean);

const hasWhere = (text: string): boolean => /\bwhere\b/i.test(text);

const matches = (value: string, query: string): boolean => value.toLowerCase().includes(query.trim().toLowerCase());

const suggestion = (text: string, hint?: string, expansion?: string): Suggestion => ({
  text,
  label: text,
  hint,
  expansion: expansion && expansion !== text ? expansion : undefined,
});

const statementSuggestions = (query: string): Suggestion[] =>
  [suggestion("metric", "metric time series"), suggestion("events", "event rows"), suggestion("states", "current states")].filter((item) =>
    matches(item.text, query),
  );

const metricNameSuggestions = (metrics: PulseMetricSummary[], query: string): Suggestion[] =>
  metrics
    .filter((metric) => matches(metric.name, query))
    .slice(0, 40)
    .map((metric) => suggestion(metric.name, [metric.type, metric.unit].filter(Boolean).join(" · "), quoteQueryValue(metric.name)));

const aggregationSuggestions = (query: string): Suggestion[] =>
  AGGREGATIONS.filter((item) => matches(item, query)).map((item) => suggestion(item, "aggregation"));

const clauseSuggestions = (kind: "metric" | "events" | "states", query: string, text: string): Suggestion[] => {
  const clauses =
    kind === "metric"
      ? ["every", "since", "source", "resource", "resource_type", ...(hasWhere(text) ? [] : ["where"])]
      : [
          ...(kind === "events" && /\bevents\s+\S+\s+(?:count|sum|unique\s+(?:actor|session))\b/i.test(text) ? ["every", "group"] : []),
          "since",
          "source",
          "resource",
          "resource_type",
          "limit",
          ...(hasWhere(text) ? [] : ["where"]),
        ];
  return clauses.filter((item) => item.startsWith(query.toLowerCase())).map((item) => suggestion(item, "clause"));
};

const withTriggerPrefix = (trigger: string, items: Suggestion[]): Suggestion[] =>
  items.map((item) => ({
    ...item,
    text: `${trigger}${item.text}`,
    label: item.label ?? item.text,
    expansion: `${trigger}${item.expansion ?? item.text}`,
  }));

const uniqueValues = (values: (string | null | undefined)[]): string[] => [...new Set(values.filter((value): value is string => !!value))];

const signalNames = (params: PulseQueryAuthoringInventory, scope: PulseSignalField["scope"], loadedNames: string[]): string[] =>
  uniqueValues([...loadedNames, ...(params.fields ?? []).filter((field) => field.scope === scope).map((field) => field.signalName)]);

const eventKindSuggestions = (params: PulseQueryAuthoringInventory, query: string): Suggestion[] =>
  [
    "*",
    ...signalNames(
      params,
      "event",
      (params.events ?? []).map((event) => event.kind),
    ),
  ]
    .filter((kind) => matches(kind, query))
    .slice(0, 40)
    .map((kind) => suggestion(kind, kind === "*" ? "all events" : "event kind", quoteQueryValue(kind)));

const stateKeySuggestions = (params: PulseQueryAuthoringInventory, query: string): Suggestion[] =>
  [
    "*",
    ...signalNames(
      params,
      "state",
      (params.states ?? []).map((state) => state.key),
    ),
  ]
    .filter((key) => matches(key, query))
    .slice(0, 40)
    .map((key) => suggestion(key, key === "*" ? "all states" : "state key", quoteQueryValue(key)));

const sourceSuggestions = (sources: PulseSource[], query: string): Suggestion[] =>
  sources
    .filter((source) => matches(source.name, query) || matches(source.id, query))
    .slice(0, 30)
    .map((source) => suggestion(source.name, `${source.kind} · ${source.id.slice(0, 8)}`, source.id));

const entitySuggestions = (params: PulseQueryAuthoringInventory, query: string): Suggestion[] =>
  uniqueValues([
    ...params.series.map((item) => item.resourceKey),
    ...(params.events ?? []).map((item) => item.resourceKey),
    ...(params.states ?? []).map((item) => item.resourceKey),
  ])
    .filter((value) => matches(value, query))
    .slice(0, 40)
    .map((value) => suggestion(value, "resource", quoteQueryValue(value)));

const dimensionSuggestions = (params: PulseQueryAuthoringInventory, query: string): Suggestion[] => {
  const dimensions = new Map<string, Set<string>>();
  for (const field of params.fields ?? []) {
    if (field.role === "dimension" && !dimensions.has(field.key)) dimensions.set(field.key, new Set());
  }
  for (const item of [...params.series, ...(params.events ?? []), ...(params.states ?? [])]) {
    for (const [key, value] of Object.entries(item.dimensions)) {
      if (!dimensions.has(key)) dimensions.set(key, new Set());
      dimensions.get(key)!.add(value);
    }
  }
  return [...dimensions.entries()]
    .filter(([key]) => matches(key, query))
    .slice(0, 40)
    .map(([key, values]) => {
      const value = [...values][0] ?? "";
      return suggestion(
        `${key}=`,
        values.size ? `${values.size} values` : "dimension",
        value ? `${key}=${quoteQueryValue(value)}` : `${key}=`,
      );
    });
};

const dimensionKeySuggestions = (params: PulseQueryAuthoringInventory, query: string): Suggestion[] =>
  uniqueValues([
    ...(params.fields ?? []).filter((field) => field.role === "dimension").map((field) => field.key),
    ...[...params.series, ...(params.events ?? []), ...(params.states ?? [])].flatMap((item) => Object.keys(item.dimensions)),
  ])
    .filter((key) => matches(key, query))
    .slice(0, 40)
    .map((key) => suggestion(key, "dimension key"));

const literalSuggestions = (items: string[], query: string, hint: string): Suggestion[] =>
  items.filter((value) => matches(value, query)).map((value) => suggestion(value, hint));

const STATEMENT_NAMES: QueryStatement[] = ["metric", "events", "states"];
const BUCKET_LITERALS = ["1m", "5m", "15m", "1h"];
const RANGE_LITERALS = ["1h", "6h", "24h", "7d", "30d"];
const LIMIT_LITERALS = ["50", "100", "500", "1000"];

type PreviousTokenSuggestionFactory = (params: PulseQueryAuthoringInventory, query: string) => Suggestion[];

const literalSuggestionFactory =
  (items: string[], hint: string): PreviousTokenSuggestionFactory =>
  (_params, query) =>
    literalSuggestions(items, query, hint);

const PREVIOUS_TOKEN_SUGGESTIONS: Record<string, PreviousTokenSuggestionFactory> = {
  metric: (params, query) => metricNameSuggestions(params.metrics, query),
  events: (params, query) => eventKindSuggestions(params, query),
  states: (params, query) => stateKeySuggestions(params, query),
  source: (params, query) => sourceSuggestions(params.sources, query),
  every: literalSuggestionFactory(BUCKET_LITERALS, "bucket"),
  since: literalSuggestionFactory(RANGE_LITERALS, "range"),
  limit: literalSuggestionFactory(LIMIT_LITERALS, "rows"),
  resource: (params, query) => entitySuggestions(params, query),
  unique: (_params, query) => literalSuggestions(["actor", "session"], query, "identity"),
  group: (_params, query) => literalSuggestions(["by"], query, "clause"),
  by: (params, query) => dimensionKeySuggestions(params, query),
};

const shouldSuggestDimensions = (ctx: SuggestContext): boolean => {
  const beforeToken = ctx.fullText.slice(0, ctx.tokenStart).trimEnd();
  return previousToken(ctx.fullText, ctx.tokenStart) === "where" || beforeToken.endsWith(",");
};

const suggestionsAfterPreviousToken = (params: PulseQueryAuthoringInventory, query: string, ctx: SuggestContext): Suggestion[] | null => {
  const prev = previousToken(ctx.fullText, ctx.tokenStart);
  const factory = PREVIOUS_TOKEN_SUGGESTIONS[prev];
  if (factory) return factory(params, query);
  if (shouldSuggestDimensions(ctx)) return dimensionSuggestions(params, query);
  return null;
};

type StatementSuggestionFactory = (params: PulseQueryAuthoringInventory, query: string, text: string, tokenIndex: number) => Suggestion[];

const metricStatementSuggestions: StatementSuggestionFactory = (params, query, text, tokenIndex) => {
  if (tokenIndex === 1) return metricNameSuggestions(params.metrics, query);
  if (tokenIndex === 2) return aggregationSuggestions(query);
  return clauseSuggestions("metric", query, text);
};

const rowStatementSuggestions =
  (kind: "events" | "states"): StatementSuggestionFactory =>
  (params, query, text, tokenIndex) => {
    const names = kind === "events" ? eventKindSuggestions(params, query) : stateKeySuggestions(params, query);
    if (tokenIndex === 1) return names;
    if (kind === "events" && tokenIndex === 2)
      return [...literalSuggestions(["count", "sum", "unique"], query, "event aggregation"), ...clauseSuggestions(kind, query, text)];
    return clauseSuggestions(kind, query, text);
  };

const STATEMENT_SUGGESTIONS: Record<QueryStatement, StatementSuggestionFactory> = {
  metric: metricStatementSuggestions,
  events: rowStatementSuggestions("events"),
  states: rowStatementSuggestions("states"),
};

const isStatementPrefixPosition = (query: string, tokenIndex: number): boolean =>
  tokenIndex <= 1 && STATEMENT_NAMES.some((item) => item.startsWith(query.toLowerCase()));

const suggestionsByStatement = (params: PulseQueryAuthoringInventory, query: string, ctx: SuggestContext): Suggestion[] => {
  const before = tokensBefore(ctx.fullText, ctx.tokenStart);
  const first = before[0]?.toLowerCase() ?? "";
  const tokenIndex = before.length;
  if (!first) return statementSuggestions(query);
  if (isStatementPrefixPosition(query, tokenIndex)) return statementSuggestions(query);
  return STATEMENT_SUGGESTIONS[first as QueryStatement]?.(params, query, ctx.fullText, tokenIndex) ?? statementSuggestions(query);
};

const suggestPulseQuery = (params: PulseQueryAuthoringInventory, query: string, ctx: SuggestContext): Suggestion[] =>
  suggestionsAfterPreviousToken(params, query, ctx) ?? suggestionsByStatement(params, query, ctx);

export const buildPulseQuery = (params: {
  metric: string;
  aggregation?: string;
  bucket?: string;
  since?: string;
  sourceId?: string | null;
  resourceKey?: string | null;
  dimensions?: Record<string, string | number | boolean | null>;
}): string => {
  const filters = Object.entries(params.dimensions ?? {}).map(([key, value]) => `${key}=${quoteQueryValue(String(value))}`);
  return [
    "metric",
    quoteQueryValue(params.metric),
    params.aggregation ?? "avg",
    "every",
    params.bucket ?? "5m",
    "since",
    params.since ?? "24h",
    params.sourceId ? `source ${params.sourceId}` : "",
    params.resourceKey ? `resource ${quoteQueryValue(params.resourceKey)}` : "",
    filters.length > 0 ? `where ${filters.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
};

export const defaultPulseQuery = (metrics: PulseMetricSummary[]): string => {
  const metric = metrics[0];
  if (!metric) return "";
  const aggregation = metric.type === "counter" ? "rate" : "avg";
  return buildPulseQuery({ metric: metric.name, aggregation, bucket: "5m", since: "24h" });
};

export const buildPulseQueryCompletions = (params: PulseQueryAuthoringInventory): Completion[] => [
  {
    dropdown: true,
    suggest: (query: string, ctx: SuggestContext) => suggestPulseQuery(params, query, ctx),
  },
  {
    trigger: " ",
    dropdown: true,
    allowAfterWord: true,
    suggest: (query: string, ctx: SuggestContext) => withTriggerPrefix(" ", suggestPulseQuery(params, query, ctx)),
  },
];

const span = (className: string, text: string): string => `<span class="${className}">${escapeHtml(text)}</span>`;
const stringSpan = (text: string): string => span("text-amber-700 dark:text-amber-300", text);
const keywordSpan = (text: string): string => span("text-blue-600 dark:text-blue-300", text);
const aggregationSpan = (text: string): string => span("text-emerald-700 dark:text-emerald-300", text);
const literalSpan = (text: string): string => span("text-purple-700 dark:text-purple-300", text);

const readQuotedEnd = (text: string, start: number): number => {
  let end = start + 1;
  let escaped = false;
  while (end < text.length) {
    const current = text[end]!;
    if (escaped) escaped = false;
    else if (current === "\\") escaped = true;
    else if (current === '"') return end + 1;
    end += 1;
  }
  return end;
};

const readWordEnd = (text: string, start: number, pattern: RegExp): number => {
  let end = start + 1;
  while (end < text.length && pattern.test(text[end]!)) end += 1;
  return end;
};

const highlightWords = (
  text: string,
  options: { wordPattern: RegExp; token: (token: string) => string; tripleQuoted?: boolean },
): string => {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (options.tripleQuoted && text.startsWith('"""', i)) {
      const start = i;
      const end = text.indexOf('"""', i + 3);
      i = end === -1 ? text.length : end + 3;
      out += stringSpan(text.slice(start, i));
      continue;
    }

    const ch = text[i]!;
    if (ch === '"') {
      const end = readQuotedEnd(text, i);
      out += stringSpan(text.slice(i, end));
      i = end;
      continue;
    }

    if (options.wordPattern.test(ch)) {
      const end = readWordEnd(text, i, options.wordPattern);
      out += options.token(text.slice(i, end));
      i = end;
      continue;
    }

    out += escapeHtml(ch);
    i += 1;
  }
  return out;
};

const QUERY_KEYWORDS = new Set([
  "metric",
  "events",
  "states",
  "every",
  "since",
  "source",
  "resource",
  "resource_type",
  "limit",
  "where",
  "group",
  "by",
]);

const queryTokenHighlight = (token: string): string => {
  const lower = token.toLowerCase();
  if (QUERY_KEYWORDS.has(lower)) return keywordSpan(token);
  if (["unique", "actor", "session"].includes(lower)) return aggregationSpan(token);
  if (AGGREGATIONS.includes(lower as (typeof AGGREGATIONS)[number])) return aggregationSpan(token);
  if (/^\d+[mhd]$/.test(lower)) return literalSpan(token);
  return escapeHtml(token);
};

export const pulseQueryHighlight = (text: string): string =>
  highlightWords(text, {
    wordPattern: /[A-Za-z0-9_.-]/,
    token: queryTokenHighlight,
  });

const DASHBOARD_DSL_KEYWORDS = new Set([
  "dashboard",
  "description",
  "controls",
  "range",
  "text",
  "source",
  "resource",
  "section",
  "row",
  "card",
  "stat",
  "gauge",
  "line",
  "bar",
  "barGauge",
  "map",
  "table",
  "markdown",
  "query",
  "warn",
  "critical",
  "when",
  "message",
  "latitude",
  "longitude",
  "label",
  "series",
  "size",
  "dimension",
  "attribute",
  "count",
  "sum",
]);

const DASHBOARD_QUERY_KEYWORDS = new Set(["metric", "events", "states", "every", "since", "where", "limit", "resource_type"]);

const dashboardTokenHighlight = (token: string): string => {
  const lower = token.toLowerCase();
  if (DASHBOARD_DSL_KEYWORDS.has(token) || DASHBOARD_QUERY_KEYWORDS.has(lower)) return keywordSpan(token);
  if (AGGREGATIONS.includes(lower as (typeof AGGREGATIONS)[number]) || lower === "latest" || lower === "increase")
    return aggregationSpan(token);
  if (/^\$?[0-9]+[mhd]?$/.test(lower) || lower.startsWith("$")) return literalSpan(token);
  return escapeHtml(token);
};

export const pulseDashboardDslHighlight = (text: string): string =>
  highlightWords(text, {
    wordPattern: /[A-Za-z0-9_.$-]/,
    token: dashboardTokenHighlight,
    tripleQuoted: true,
  });
