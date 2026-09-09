import { err, fail, ok, type Result } from "@k2b/cloud/server";
import type { Aggregation, EventAggregation, EventQuery, MetricQuery, PulseExplorerQuery, StateQuery } from "../contracts";
import { AGGREGATIONS } from "../contracts";
import { SHORT_ID_REGEX } from "../lib/short-id";
import { PULSE_DIMENSION_KEY_LIMIT } from "../telemetry-contract";

const MAX_DURATION_MS = 90 * 24 * 60 * 60_000;

type QueryTokenQuote = '"' | "'";

type QueryTokenState = {
  tokens: string[];
  current: string;
  quote: QueryTokenQuote | null;
};

export const intervalToMs = (input: string): number | null => {
  const match = input.trim().match(/^(\d+)(m|h|d)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const duration = unit === "m" ? amount * 60_000 : unit === "h" ? amount * 60 * 60_000 : amount * 24 * 60 * 60_000;
  return duration <= MAX_DURATION_MS ? duration : null;
};

export const durationToInterval = (input: string): string | null => {
  if (intervalToMs(input) === null) return null;
  const match = input.trim().match(/^(\d+)(m|h|d)$/);
  if (!match) return null;
  const unit = match[2] === "m" ? "minutes" : match[2] === "h" ? "hours" : "days";
  return `${Number(match[1])} ${unit}`;
};

export const tokenizeQueryText = (text: string): string[] => {
  const state: QueryTokenState = { tokens: [], current: "", quote: null };
  for (let i = 0; i < text.length; i += 1) {
    i = readQueryTokenChar(text, i, state);
  }
  if (state.quote) return [];
  pushCurrentQueryToken(state);
  return state.tokens;
};

const readQueryTokenChar = (text: string, index: number, state: QueryTokenState): number => {
  const char = text[index]!;
  if (state.quote) return readQuotedQueryTokenChar(text, index, state);
  if (isQueryQuote(char)) state.quote = char;
  else if (isQueryTokenSeparator(char)) pushQueryTokenSeparator(char, state);
  else state.current += char;
  return index;
};

const readQuotedQueryTokenChar = (text: string, index: number, state: QueryTokenState): number => {
  const char = text[index]!;
  if (char === state.quote) {
    state.quote = null;
    return index;
  }
  if (char === "\\" && index + 1 < text.length) {
    state.current += text[index + 1]!;
    return index + 1;
  }
  state.current += char;
  return index;
};

const isQueryQuote = (char: string): char is QueryTokenQuote => char === '"' || char === "'";
const isQueryTokenSeparator = (char: string): boolean => /\s/.test(char) || char === ",";

const pushQueryTokenSeparator = (char: string, state: QueryTokenState) => {
  pushCurrentQueryToken(state);
  if (char === ",") state.tokens.push(",");
};

const pushCurrentQueryToken = (state: QueryTokenState) => {
  if (!state.current) return;
  state.tokens.push(state.current);
  state.current = "";
};

const parseDimensionFilter = (token: string): [string, string] | null => {
  const separator = token.indexOf("=");
  if (separator <= 0) return null;
  const key = token.slice(0, separator).trim();
  const value = token.slice(separator + 1).trim();
  return key && value ? [key, value] : null;
};

const readQueryName = (token: string | undefined): string | null => {
  const value = token?.trim();
  if (!value || value === "*") return null;
  return value;
};

const readQueryLimit = (value: string | undefined, fallback: number): Result<number> => {
  if (!value) return ok(fallback);
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) return fail(err.badInput("Limit must be a positive integer"));
  if (limit > 1_000) return fail(err.badInput("Limit cannot exceed 1000 rows"));
  return ok(limit);
};

type SharedClauses = {
  since: string;
  sourceId: string | null;
  entityId: string | null;
  entityType: string | null;
  dimensions: Record<string, string>;
  limit: number;
};

type SharedClauseState = SharedClauses & {
  index: number;
  seen: Set<string>;
};

type SharedClauseReader = (tokens: string[], state: SharedClauseState) => Result<void>;

type MetricTokenParts = {
  metric: string;
  aggregation: Aggregation;
  bucket: string;
  reduce: MetricQuery["reduce"];
  groupBy: string | null;
  sharedTokens: string[];
};

const parseSharedQueryClauses = (
  tokens: string[],
  startIndex: number,
  defaults: { since?: string; limit?: number } = {},
): Result<SharedClauses> => {
  const state: SharedClauseState = {
    since: defaults.since ?? "",
    sourceId: null,
    entityId: null,
    entityType: null,
    dimensions: {},
    limit: defaults.limit ?? 500,
    index: startIndex,
    seen: new Set(),
  };
  while (state.index < tokens.length) {
    const clause = readSharedQueryClause(tokens, state);
    if (!clause.ok) return fail(clause.error);
  }
  const { index: _index, seen: _seen, ...clauses } = state;
  return ok(clauses);
};

const readSharedQueryClause = (tokens: string[], state: SharedClauseState): Result<void> => {
  const token = tokens[state.index]?.toLowerCase();
  const reader = token ? SHARED_CLAUSE_READERS[token] : undefined;
  if (!token || !reader) return fail(err.badInput(`Unexpected token "${tokens[state.index]}"`));
  if (state.seen.has(token)) return fail(err.badInput(`Clause "${token}" may only be used once`));
  state.seen.add(token);
  return reader(tokens, state);
};

const SHARED_CLAUSE_READERS: Record<string, SharedClauseReader> = {
  since: (tokens, state) => {
    const value = tokens[state.index + 1];
    if (!value) return fail(err.badInput("Since duration is missing"));
    state.since = value;
    state.index += 2;
    return ok(undefined);
  },
  source: (tokens, state) => {
    state.sourceId = tokens[state.index + 1] ?? null;
    if (!state.sourceId || !SHORT_ID_REGEX.test(state.sourceId)) return fail(err.badInput("Source must be a 6-character short ID"));
    state.index += 2;
    return ok(undefined);
  },
  entity: (tokens, state) => {
    state.entityId = tokens[state.index + 1] ?? null;
    if (!state.entityId) return fail(err.badInput("Entity is missing"));
    state.index += 2;
    return ok(undefined);
  },
  entity_type: (tokens, state) => {
    state.entityType = tokens[state.index + 1] ?? null;
    if (!state.entityType) return fail(err.badInput("Entity type is missing"));
    state.index += 2;
    return ok(undefined);
  },
  limit: (tokens, state) => readLimitClause(tokens, state),
  where: (tokens, state) => readWhereClause(tokens, state),
};

const readLimitClause = (tokens: string[], state: SharedClauseState): Result<void> => {
  const parsed = readQueryLimit(tokens[state.index + 1], state.limit);
  if (!parsed.ok) return fail(parsed.error);
  state.limit = parsed.data;
  state.index += 2;
  return ok(undefined);
};

const readWhereClause = (tokens: string[], state: SharedClauseState): Result<void> => {
  state.index += 1;
  let filters = 0;
  while (state.index < tokens.length) {
    const filter = tokens[state.index];
    if (!filter || filter === ",") {
      state.index += 1;
      continue;
    }
    if (SHARED_CLAUSE_READERS[filter.toLowerCase()]) break;
    const parsed = parseDimensionFilter(filter);
    if (!parsed) return fail(err.badInput(`Invalid dimension filter "${filter}"`));
    if (!(parsed[0] in state.dimensions) && Object.keys(state.dimensions).length >= PULSE_DIMENSION_KEY_LIMIT)
      return fail(err.badInput(`Where cannot exceed ${PULSE_DIMENSION_KEY_LIMIT} dimension filters`));
    state.dimensions[parsed[0]] = parsed[1];
    filters += 1;
    state.index += 1;
  }
  if (filters === 0) return fail(err.badInput("Where requires at least one key=value filter"));
  return ok(undefined);
};

const compileMetricQueryTokens = (baseId: string, tokens: string[]): Result<MetricQuery> => {
  const parts = readMetricTokenParts(tokens);
  if (!parts.ok) return fail(parts.error);
  const shared = parseSharedQueryClauses(parts.data.sharedTokens, 0, { since: "24h", limit: 1_000 });
  if (!shared.ok) return fail(shared.error);
  if (!intervalToMs(parts.data.bucket) || !intervalToMs(shared.data.since))
    return fail(err.badInput("Use compact durations like 5m, 1h, or 7d"));
  return ok(metricQueryFromParts(baseId, parts.data, shared.data));
};

const readMetricTokenParts = (tokens: string[]): Result<MetricTokenParts> => {
  const metric = tokens[1]?.trim();
  if (!metric) return fail(err.badInput("Metric query name is missing"));
  const aggregation = readMetricAggregation(tokens[2]);
  if (!aggregation.ok) return fail(aggregation.error);
  const metricOptions = readMetricOptions(tokens, metric);
  if (!metricOptions.ok) return fail(metricOptions.error);
  return ok({
    metric,
    aggregation: aggregation.data,
    bucket: metricOptions.data.bucket,
    reduce: metricOptions.data.reduce,
    groupBy: metricOptions.data.groupBy,
    sharedTokens: metricOptions.data.sharedTokens,
  });
};

const readMetricAggregation = (value: string | undefined): Result<Aggregation> => {
  if (!value || !AGGREGATIONS.includes(value as Aggregation)) return fail(err.badInput(`Unsupported aggregation "${value ?? ""}"`));
  return ok(value as Aggregation);
};

const readMetricOptions = (
  tokens: string[],
  _metric: string,
): Result<Pick<MetricTokenParts, "bucket" | "reduce" | "groupBy" | "sharedTokens">> => {
  let bucket = "5m";
  let everySeen = false;
  let reduce: MetricQuery["reduce"] = null;
  let reduceSeen = false;
  let groupBy: string | null = null;
  let groupSeen = false;
  let index = 3;
  const sharedTokens: string[] = [];
  while (index < tokens.length) {
    const token = tokens[index]?.toLowerCase();
    if (token === "every") {
      if (everySeen) return fail(err.badInput('Clause "every" may only be used once'));
      const value = tokens[index + 1];
      if (!value) return fail(err.badInput("Every duration is missing"));
      everySeen = true;
      bucket = value;
      index += 2;
      continue;
    }
    if (token === "reduce") {
      if (reduceSeen) return fail(err.badInput('Clause "reduce" may only be used once'));
      const value = tokens[index + 1]?.toLowerCase();
      if (!value || !["sum", "avg", "min", "max"].includes(value)) {
        return fail(err.badInput(`Unsupported reducer "${value ?? ""}"`));
      }
      reduceSeen = true;
      reduce = value as NonNullable<MetricQuery["reduce"]>;
      index += 2;
      continue;
    }
    if (token === "group") {
      if (groupSeen) return fail(err.badInput('Clause "group by" may only be used once'));
      if (tokens[index + 1]?.toLowerCase() !== "by") return fail(err.badInput('Group clause must use "group by <resource|dimension>"'));
      const value = tokens[index + 2]?.trim();
      if (!value || value === ",") return fail(err.badInput("Group by value is missing"));
      groupSeen = true;
      groupBy = value;
      index += 3;
      continue;
    }
    sharedTokens.push(tokens[index]!);
    index += 1;
  }
  return ok({ bucket, reduce, groupBy, sharedTokens });
};

const metricQueryFromParts = (baseId: string, parts: MetricTokenParts, shared: SharedClauses): MetricQuery => ({
  kind: "metric",
  baseId,
  metric: parts.metric,
  aggregation: parts.aggregation,
  bucket: parts.bucket,
  since: shared.since,
  sourceId: shared.sourceId,
  entityId: shared.entityId,
  entityType: shared.entityType,
  dimensions: shared.dimensions,
  reduce: parts.reduce,
  groupBy: parts.groupBy,
});

const compileEventQueryTokens = (baseId: string, tokens: string[]): Result<EventQuery> => {
  const options = readEventOptions(tokens);
  if (!options.ok) return fail(options.error);
  const shared = parseSharedQueryClauses(options.data.sharedTokens, 0, { since: "24h", limit: 500 });
  if (!shared.ok) return fail(shared.error);
  if (!intervalToMs(shared.data.since)) return fail(err.badInput("Use compact durations like 5m, 1h, or 7d"));
  if (options.data.bucket && !intervalToMs(options.data.bucket)) return fail(err.badInput("Use compact durations like 5m, 1h, or 7d"));
  return ok({
    kind: "events",
    baseId,
    event: readQueryName(tokens[1]),
    since: shared.data.since,
    sourceId: shared.data.sourceId,
    entityId: shared.data.entityId,
    entityType: shared.data.entityType,
    dimensions: shared.data.dimensions,
    aggregation: options.data.aggregation,
    bucket: options.data.bucket,
    groupBy: options.data.groupBy,
    limit: shared.data.limit,
  });
};

type EventOptions = {
  aggregation: EventAggregation;
  bucket: string | null;
  groupBy: string[];
  sharedTokens: string[];
};

const EVENT_AGGREGATION_TOKENS = new Set(["count", "sum", "unique"]);
const EVENT_OPTION_TOKENS = new Set(["every", "group"]);
const EVENT_CLAUSE_TOKENS = new Set([...Object.keys(SHARED_CLAUSE_READERS), ...EVENT_OPTION_TOKENS]);

const readEventOptions = (tokens: string[]): Result<EventOptions> => {
  let index = 2;
  let aggregation: EventAggregation = "rows";
  const first = tokens[index]?.toLowerCase();
  if (first && EVENT_AGGREGATION_TOKENS.has(first)) {
    if (first === "unique") {
      const identity = tokens[index + 1]?.toLowerCase();
      if (identity !== "actor" && identity !== "session") return fail(err.badInput('Unique must be followed by "actor" or "session"'));
      aggregation = identity === "actor" ? "unique_actor" : "unique_session";
      index += 2;
    } else {
      aggregation = first as Extract<EventAggregation, "count" | "sum">;
      index += 1;
    }
  }

  let bucket: string | null = aggregation === "rows" ? null : "1h";
  const groupBy: string[] = [];
  const sharedTokens: string[] = [];
  let everySeen = false;
  let groupSeen = false;
  while (index < tokens.length) {
    const token = tokens[index]?.toLowerCase();
    if (token === "every") {
      if (aggregation === "rows") return fail(err.badInput("Every requires an event aggregation"));
      if (everySeen) return fail(err.badInput('Clause "every" may only be used once'));
      const value = tokens[index + 1];
      if (!value) return fail(err.badInput("Every duration is missing"));
      everySeen = true;
      bucket = value;
      index += 2;
      continue;
    }
    if (token === "group") {
      if (aggregation === "rows") return fail(err.badInput("Group by requires an event aggregation"));
      if (groupSeen) return fail(err.badInput('Clause "group by" may only be used once'));
      if (tokens[index + 1]?.toLowerCase() !== "by") return fail(err.badInput('Group must be followed by "by"'));
      groupSeen = true;
      index += 2;
      while (index < tokens.length && !EVENT_CLAUSE_TOKENS.has(tokens[index]!.toLowerCase())) {
        const key = tokens[index]!;
        index += 1;
        if (key === ",") continue;
        if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(key)) return fail(err.badInput(`Invalid group key "${key}"`));
        if (groupBy.includes(key)) return fail(err.badInput(`Duplicate group key "${key}"`));
        groupBy.push(key);
      }
      if (groupBy.length === 0) return fail(err.badInput("Group by requires at least one dimension key"));
      if (groupBy.length > 4) return fail(err.badInput("Group by cannot exceed 4 dimension keys"));
      continue;
    }
    sharedTokens.push(tokens[index]!);
    index += 1;
  }
  return ok({ aggregation, bucket, groupBy, sharedTokens });
};

const compileStateQueryTokens = (baseId: string, tokens: string[]): Result<StateQuery> => {
  const shared = parseSharedQueryClauses(tokens, 2, { since: "", limit: 500 });
  if (!shared.ok) return fail(shared.error);
  if (shared.data.since && !intervalToMs(shared.data.since)) return fail(err.badInput("Use compact durations like 5m, 1h, or 7d"));
  return ok({
    kind: "states",
    baseId,
    state: readQueryName(tokens[1]),
    since: shared.data.since || null,
    sourceId: shared.data.sourceId,
    entityId: shared.data.entityId,
    entityType: shared.data.entityType,
    dimensions: shared.data.dimensions,
    limit: shared.data.limit,
  });
};

export const compilePulseQueryText = (baseId: string, text: string): Result<PulseExplorerQuery> => {
  const trimmed = text.trim();
  if (!trimmed) return fail(err.badInput("Query is empty"));
  const tokens = tokenizeQueryText(trimmed);
  if (tokens.length === 0) return fail(err.badInput("Query has an unterminated quote"));
  const kind = tokens[0]?.toLowerCase();
  if (kind === "metric") return compileMetricQueryTokens(baseId, tokens);
  if (kind === "events") return compileEventQueryTokens(baseId, tokens);
  if (kind === "states") return compileStateQueryTokens(baseId, tokens);
  return fail(err.badInput('Query must start with "metric", "events", or "states"'));
};
