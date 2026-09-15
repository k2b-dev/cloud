import type { DslQueryCompletionItem, DslQueryTextRange } from "../contracts";
import type { AggregateKind } from "../service/aggregate-capabilities";
import { type CompletionRequest, completionItem, keywordItems, matchesNeedle, rankItems, uniqueItems } from "./intelligence-core";
import {
  AGGREGATE_FUNCTIONS,
  GROUP_GRANULARITIES,
  NULL_MODIFIERS,
  NULL_PLACEMENTS,
  PREDICATE_COMPARISON_OPERATORS,
  PREDICATE_FUNCTIONS,
  PREDICATE_JOIN_OPERATORS,
  PREDICATE_OPERATORS,
  SEARCH_QUOTED_RE,
  SORT_DIRECTIONS,
  SOURCE_REF_RE,
  sourceKindSuggestions,
  topLevelSuggestions,
} from "./intelligence-grammar";
import {
  completedFromSource,
  completedQualifiedRef,
  defaultAggregateAlias,
  defaultAliasForRef,
  fieldReferenceSuggestions,
  groupRefSupportsGranularity,
  parseSourceReference,
  scopeBeforeToken,
  sourceRefExists,
  sourceSuggestions,
} from "./intelligence-source";
import type { DslQueryContextKey } from "./parameters";
import type { DslResolverContext } from "./resolver";

const splitJoinEquality = (input: string): { left: string; right: string } | null => {
  let quote: string | null = null;
  let braceDepth = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (quote === `"` && c === `"` && input[i + 1] === `"`) {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === `"` || c === "'") {
      quote = c;
      continue;
    }
    if (c === "{") {
      braceDepth++;
      continue;
    }
    if (c === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (braceDepth === 0 && c === "=") return { left: input.slice(0, i), right: input.slice(i + 1) };
  }
  return null;
};

const containsComparisonOperator = (input: string): boolean => {
  let quote: string | null = null;
  let braceDepth = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (quote === `"` && c === `"` && input[i + 1] === `"`) {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === `"` || c === "'") {
      quote = c;
      continue;
    }
    if (c === "{") {
      braceDepth++;
      continue;
    }
    if (c === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (braceDepth === 0 && /[=<>!]/.test(c)) return true;
  }
  return false;
};

const SAME_LINE_CLAUSE_KEYWORDS = [
  { clause: "select", re: /^select\b/i },
  { clause: "where", re: /^where\b/i },
  { clause: "left join", re: /^left\s+join\b/i },
  { clause: "join", re: /^join\b/i },
  { clause: "group by", re: /^group\s+by\b/i },
  { clause: "aggregate", re: /^aggregate\b/i },
  { clause: "having", re: /^having\b/i },
  { clause: "sort", re: /^sort\b/i },
  { clause: "search", re: /^search\b/i },
  { clause: "limit", re: /^limit\b/i },
  { clause: "offset", re: /^offset\b/i },
  { clause: "include deleted", re: /^include\s+deleted\b/i },
  { clause: "deleted only", re: /^deleted\s+only\b/i },
] as const;

export const sameLineClauseSegment = (
  segment: string,
  absoluteSegmentStart: number,
  source: NonNullable<ReturnType<typeof completedFromSource>>,
): { segment: string; absoluteStart: number } | null => {
  const firstNonSpace = source.tail.search(/\S/);
  if (firstNonSpace < 0) return null;
  const trimmedTail = source.tail.slice(firstNonSpace);
  const keyword = SAME_LINE_CLAUSE_KEYWORDS.find((item) => item.re.test(trimmedTail));
  if (!keyword) return null;
  const absoluteStart = absoluteSegmentStart + source.tailStart + firstNonSpace;
  return { segment: segment.slice(source.tailStart + firstNonSpace), absoluteStart };
};

const newlinePrefixedItems = (items: DslQueryCompletionItem[]): DslQueryCompletionItem[] =>
  items.map((item) => ({
    ...item,
    insertText: `\n${item.insertText}`,
    textEdit: { ...item.textEdit, text: `\n${item.textEdit.text}` },
  }));

export const rewriteSameLineClauseItems = (query: string, items: DslQueryCompletionItem[], clauseStart: number): DslQueryCompletionItem[] =>
  items.map((item) => ({
    ...item,
    textEdit: {
      start: clauseStart,
      end: item.textEdit.end,
      text: `\n${query.slice(clauseStart, item.textEdit.start)}${item.textEdit.text}`,
    },
  }));

const sourceClauseSuggestions = (
  ctx: DslResolverContext,
  query: string,
  range: DslQueryTextRange,
  segment: string,
): DslQueryCompletionItem[] => {
  const completed = completedFromSource(ctx, segment);
  if (completed && /^\s+a?s?$/i.test(completed.tail)) {
    return keywordItems(query, range, [{ label: "as", insertText: "as ", detail: "Name this source scope" }]);
  }
  if (completed && /^\s+as\s*$/i.test(completed.tail)) {
    const alias = defaultAliasForRef(completed.ref);
    return keywordItems(query, range, [{ label: alias, insertText: alias, detail: "Source alias" }], "alias");
  }
  if (completed?.tail === "") {
    return keywordItems(query, { start: range.end, end: range.end }, [
      { label: "as", insertText: " as ", detail: "Name this source scope" },
    ]);
  }
  if (completed?.tail.trim().length === 0 && /\s$/.test(completed.tail)) return newlinePrefixedItems(topLevelSuggestions(query, range));
  if (completed && completed.tail.trim().length > 0 && !sameLineClauseSegment(segment, 0, completed)) {
    return newlinePrefixedItems(topLevelSuggestions(query, range));
  }

  const restRaw = segment.trimStart().replace(/^from\b/i, "");
  const rest = restRaw.trimStart();
  if (!rest || /^(?:t|ta|tab|tabl|v|vi|vie)$/i.test(rest)) return sourceKindSuggestions(query, range);
  const kindMatch = rest.match(/^(table|view)(?:\s+([\s\S]*))?$/i);
  if (!kindMatch) return [];
  if (kindMatch[2] === undefined && !/\s$/.test(restRaw)) return sourceKindSuggestions(query, range);
  return sourceSuggestions(ctx, query, range, kindMatch[1]!.toLowerCase() as "table" | "view");
};

const joinClauseSuggestions = (
  ctx: DslResolverContext,
  query: string,
  range: DslQueryTextRange,
  segment: string,
  currentSource?: CompletionRequest["currentSource"],
): DslQueryCompletionItem[] => {
  const restRaw = segment.trimStart().replace(/^(?:left\s+)?join\b/i, "");
  const rest = restRaw.trimStart();
  const leftJoin = /^left\s+join\b/i.test(segment.trimStart());
  if (!rest || /^(?:t|ta|tab|tabl|v|vi|vie)$/i.test(rest)) return sourceKindSuggestions(query, range, !leftJoin);
  const tableMatch = rest.match(/^(table|view)\b([\s\S]*)$/i);
  if (!tableMatch) return [];
  const kind = tableMatch[1]!.toLowerCase() === "view" ? "view" : "table";
  if (kind === "view" && !leftJoin) return [];
  const afterTable = tableMatch[2] ?? "";
  if (!afterTable && !/\s$/.test(restRaw)) return sourceKindSuggestions(query, range, !leftJoin);

  const sourceMatch = afterTable.match(new RegExp(String.raw`^\s+(${SOURCE_REF_RE})([\s\S]*)$`, "i"));
  if (!sourceMatch) return sourceSuggestions(ctx, query, range, kind);

  const sourceRef = sourceMatch[1] ? parseSourceReference(sourceMatch[1]) : null;
  if (!sourceRef || !sourceRefExists(ctx, kind, sourceRef)) return sourceSuggestions(ctx, query, range, kind);

  const tail = sourceMatch[2] ?? "";
  if (tail === "") {
    return keywordItems(query, { start: range.end, end: range.end }, [{ label: "as", insertText: " as ", detail: "Name this join scope" }]);
  }
  const onMatch = tail.match(/\s+on\b([\s\S]*)$/i);
  if (onMatch) {
    const condition = onMatch[1] ?? "";
    if (condition.trim() === "") return fieldReferenceSuggestions(ctx, query, range, "join", undefined, currentSource);

    const equality = splitJoinEquality(condition);
    if (!equality) {
      const left = completedQualifiedRef(condition);
      if (left && left.tail.trim() === "" && /\s$/.test(condition)) {
        return keywordItems(query, range, [{ label: "=", insertText: "= ", detail: "Join equality" }], "modifier");
      }
      return fieldReferenceSuggestions(ctx, query, range, "join", undefined, currentSource);
    }

    if (equality.right.trim() === "") return fieldReferenceSuggestions(ctx, query, range, "join", undefined, currentSource);
    const right = completedQualifiedRef(equality.right);
    if (right && right.tail.trim() === "" && /\s$/.test(equality.right)) {
      return newlinePrefixedItems(topLevelSuggestions(query, range));
    }
    if (right && right.tail.trim().length > 0) return newlinePrefixedItems(topLevelSuggestions(query, range));
    return fieldReferenceSuggestions(ctx, query, range, "join", undefined, currentSource);
  }
  if (/\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s+\w*$/i.test(tail)) {
    return keywordItems(query, range, [{ label: "on", insertText: "on ", detail: "Join condition" }]);
  }
  if (/\s+as\s*$/i.test(tail)) {
    const alias = defaultAliasForRef(sourceRef);
    return keywordItems(query, range, [{ label: alias, insertText: alias, detail: "Join alias" }], "alias");
  }
  if (/^\s+a?s?$/i.test(tail)) {
    return keywordItems(query, range, [{ label: "as", insertText: "as ", detail: "Name this join scope" }]);
  }
  return [];
};

const aggregateFromFunction = (fn: string): AggregateKind | undefined => {
  const match = AGGREGATE_FUNCTIONS.find((item) => item.toLowerCase() === fn.toLowerCase());
  return match;
};

const aggregateClauseSuggestions = (
  ctx: DslResolverContext,
  query: string,
  range: DslQueryTextRange,
  segment: string,
  currentSource?: CompletionRequest["currentSource"],
): DslQueryCompletionItem[] => {
  const body = segment.trimStart().replace(/^aggregate\b/i, "");
  const completedCall = body.match(/([A-Za-z][A-Za-z0-9_]*)\(([^()]*)\)([\s\S]*)$/);
  if (completedCall?.[1] && aggregateFromFunction(completedCall[1])) {
    const fn = completedCall[1];
    const arg = completedCall[2] ?? "";
    const tail = completedCall[3] ?? "";
    if (/^\s+a?s?$/i.test(tail)) return keywordItems(query, range, [{ label: "as", insertText: "as ", detail: "Name this aggregate" }]);
    if (/^\s+as\s*$/i.test(tail)) {
      const alias = defaultAggregateAlias(fn, arg);
      return keywordItems(query, range, [{ label: alias, insertText: alias, detail: "Aggregate alias" }], "alias");
    }
    if (/^\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s*$/i.test(tail)) {
      if (/\s$/.test(tail)) return newlinePrefixedItems(topLevelSuggestions(query, range));
      return [];
    }
    if (/^\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s+\S/i.test(tail)) return newlinePrefixedItems(topLevelSuggestions(query, range));
  }
  const call = body.match(/([A-Za-z][A-Za-z0-9_]*)\([^()]*$/);
  if (call?.[1]) {
    const aggregate = aggregateFromFunction(call[1]);
    const items: DslQueryCompletionItem[] = [];
    if (aggregate === "count" && matchesNeedle(query, range, ["*"])) {
      items.push(completionItem(range, "literal", "*", "*", "all records"));
    }
    items.push(...fieldReferenceSuggestions(ctx, query, range, "aggregate", aggregate, currentSource));
    return rankItems(query, range, uniqueItems(items));
  }
  return keywordItems(
    query,
    range,
    AGGREGATE_FUNCTIONS.map((fn) => ({ label: fn, insertText: `${fn}(`, detail: "aggregate function" })),
    "function",
  );
};

const selectClauseSuggestions = (
  ctx: DslResolverContext,
  query: string,
  range: DslQueryTextRange,
  segment: string,
  currentSource?: CompletionRequest["currentSource"],
): DslQueryCompletionItem[] => {
  const body = segment.trimStart().replace(/^select\b/i, "");
  const part = body.slice(body.lastIndexOf(",") + 1);
  if (scopeBeforeToken(query, range)) return fieldReferenceSuggestions(ctx, query, range, "output", undefined, currentSource);
  if (part.trim() === "") return fieldReferenceSuggestions(ctx, query, range, "output", undefined, currentSource);

  const formulaMatch = part.match(/^\s*formula\([\s\S]*\)([\s\S]*)$/i);
  if (formulaMatch) {
    const tail = formulaMatch[1] ?? "";
    if (/^\s+a?s?$/i.test(tail))
      return keywordItems(query, range, [{ label: "as", insertText: "as ", detail: "Name this formula output" }]);
    if (/^\s+as\s*$/i.test(tail)) {
      return keywordItems(query, range, [{ label: "formula_result", insertText: "formula_result", detail: "Select alias" }], "alias");
    }
    if (/^\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s*$/i.test(tail)) {
      if (/\s$/.test(tail)) return newlinePrefixedItems(topLevelSuggestions(query, range));
      return [];
    }
    if (/^\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s+\S/i.test(tail)) return newlinePrefixedItems(topLevelSuggestions(query, range));
    return [];
  }

  const completed = completedQualifiedRef(part);
  if (completed) {
    if (completed.tail === "") return fieldReferenceSuggestions(ctx, query, range, "output", undefined, currentSource);
    if (/^\s+a?s?$/i.test(completed.tail))
      return keywordItems(query, range, [{ label: "as", insertText: "as ", detail: "Name this output" }]);
    if (/^\s+as\s*$/i.test(completed.tail)) {
      return keywordItems(
        query,
        range,
        [{ label: defaultAliasForRef(completed.ref), insertText: defaultAliasForRef(completed.ref), detail: "Select alias" }],
        "alias",
      );
    }
    if (/^\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s*$/i.test(completed.tail)) {
      if (/\s$/.test(completed.tail)) return newlinePrefixedItems(topLevelSuggestions(query, range));
      return [];
    }
    if (/^\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s+\S/i.test(completed.tail)) return newlinePrefixedItems(topLevelSuggestions(query, range));
    return newlinePrefixedItems(topLevelSuggestions(query, range));
  }

  return fieldReferenceSuggestions(ctx, query, range, "output", undefined, currentSource);
};

const aliasSuggestions = (query: string, range: DslQueryTextRange, clause: "select" | "aggregate"): DslQueryCompletionItem[] => {
  const re = new RegExp(String.raw`\b${clause}\s+([^\n;]+)`, "gi");
  const aliases: DslQueryCompletionItem[] = [];
  for (const match of query.matchAll(re)) {
    const body = match[1] ?? "";
    for (const alias of body.matchAll(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
      aliases.push(completionItem(range, "alias", alias[1]!, alias[1]!, `${clause} alias`));
    }
  }
  return aliases;
};

const sortTargetSuggestions = (
  ctx: DslResolverContext,
  query: string,
  range: DslQueryTextRange,
  currentSource?: CompletionRequest["currentSource"],
): DslQueryCompletionItem[] => {
  const aliases = [...aliasSuggestions(query, range, "select"), ...aliasSuggestions(query, range, "aggregate")];
  return rankItems(
    query,
    range,
    uniqueItems([...fieldReferenceSuggestions(ctx, query, range, "sort", undefined, currentSource), ...aliases]),
  );
};

const sortClauseSuggestions = (
  ctx: DslResolverContext,
  query: string,
  range: DslQueryTextRange,
  segment: string,
  currentSource?: CompletionRequest["currentSource"],
): DslQueryCompletionItem[] => {
  const body = segment.trimStart().replace(/^sort\b/i, "");
  const item = body.slice(body.lastIndexOf(",") + 1);
  if (/\bnulls\s+(?:first|last)\s+\S*$/i.test(item) || (/\bnulls\s+(?:first|last)\s*$/i.test(item) && /\s$/.test(item))) {
    return newlinePrefixedItems(topLevelSuggestions(query, range));
  }
  if (/\bnulls\s+\w*$/i.test(item)) {
    return keywordItems(
      query,
      range,
      NULL_PLACEMENTS.map((label) => ({ label, insertText: label, detail: "null ordering" })),
      "modifier",
    );
  }
  if (/\b(?:asc|desc)\s+\w*$/i.test(item)) {
    return keywordItems(
      query,
      range,
      NULL_MODIFIERS.map((label) => ({ label, insertText: label, detail: "null ordering" })),
      "modifier",
    );
  }
  if (/\S+\s+[A-Za-z_]*$/i.test(item) && !scopeBeforeToken(query, range)) {
    return keywordItems(
      query,
      range,
      SORT_DIRECTIONS.map((label) => ({ label, insertText: label, detail: "sort direction" })),
      "modifier",
    );
  }
  return sortTargetSuggestions(ctx, query, range, currentSource);
};

const numericClauseSuggestions = (
  query: string,
  range: DslQueryTextRange,
  segment: string,
  clause: "limit" | "offset",
): DslQueryCompletionItem[] => {
  const body = segment.trimStart().replace(new RegExp(String.raw`^${clause}\b`, "i"), "");
  if (/^\s*\d+\s+\S*$/i.test(body) || (/^\s*\d+\s*$/i.test(body) && /\s$/.test(body))) {
    return newlinePrefixedItems(topLevelSuggestions(query, range));
  }
  return [];
};

const deletedClauseSuggestions = (query: string, range: DslQueryTextRange, segment: string): DslQueryCompletionItem[] => {
  const lower = segment.trimStart().toLowerCase();
  if (/^include\s+\w*$/i.test(lower)) {
    return keywordItems(query, range, [{ label: "deleted", insertText: "deleted", detail: "Include trashed records" }], "modifier");
  }
  if (/^deleted\s+\w*$/i.test(lower)) {
    return keywordItems(query, range, [{ label: "only", insertText: "only", detail: "Only trashed records" }], "modifier");
  }
  if (
    /^(?:include\s+deleted|deleted\s+only)\s+\S*$/i.test(segment) ||
    (/^(?:include\s+deleted|deleted\s+only)\s*$/i.test(segment) && /\s$/.test(segment))
  ) {
    return newlinePrefixedItems(topLevelSuggestions(query, range));
  }
  return [];
};

const groupClauseSuggestions = (
  ctx: DslResolverContext,
  query: string,
  range: DslQueryTextRange,
  segment: string,
  currentSource?: CompletionRequest["currentSource"],
): DslQueryCompletionItem[] => {
  const body = segment.trimStart().replace(/^group\s+by\b/i, "");
  const item = body.slice(body.lastIndexOf(",") + 1);
  if (/\s+by\s+\w*$/i.test(item)) {
    return keywordItems(
      query,
      range,
      GROUP_GRANULARITIES.map((label) => ({ label, insertText: label, detail: "date bucket" })),
      "modifier",
    );
  }
  const completed = completedQualifiedRef(item);
  if (completed && completed.tail !== "") {
    if (/^\s+b?y?$/i.test(completed.tail) && groupRefSupportsGranularity(ctx, query, completed.ref, currentSource)) {
      return keywordItems(query, range, [{ label: "by", insertText: "by ", detail: "Date granularity" }]);
    }
    return newlinePrefixedItems(topLevelSuggestions(query, range));
  }
  if (/\s$/.test(item) && groupRefSupportsGranularity(ctx, query, item.trim(), currentSource)) {
    return keywordItems(query, range, [{ label: "by", insertText: "by ", detail: "Date granularity" }]);
  }
  return fieldReferenceSuggestions(ctx, query, range, "group", undefined, currentSource);
};

const predicateSuggestions = (
  ctx: DslResolverContext,
  query: string,
  range: DslQueryTextRange,
  segment: string,
  includeAggregateAliases = false,
  currentSource?: CompletionRequest["currentSource"],
  contextKeys: readonly DslQueryContextKey[] = [],
): DslQueryCompletionItem[] => {
  const body = segment.trimStart().replace(/^(?:where|having)\b/i, "");
  const trimmedBody = body.trimEnd();
  const expectsOperand =
    trimmedBody.length === 0 ||
    /(?:^|\s)(?:and|or|not)\s*$/i.test(trimmedBody) ||
    /(?:=|!=|>=|<=|>|<|\(|,)\s*$/.test(trimmedBody) ||
    !/\s$/.test(body);
  if (!expectsOperand) {
    const operators = containsComparisonOperator(trimmedBody)
      ? PREDICATE_JOIN_OPERATORS
      : [...PREDICATE_COMPARISON_OPERATORS, ...PREDICATE_JOIN_OPERATORS];
    return keywordItems(query, range, operators, "modifier");
  }

  const items = [
    ...fieldReferenceSuggestions(ctx, query, range, "predicate", undefined, currentSource),
    ...keywordItems(query, range, PREDICATE_FUNCTIONS, "function"),
    ...keywordItems(query, range, PREDICATE_OPERATORS),
    ...contextKeys.map((key) => completionItem(range, "literal", `@${key}`, `@${key}`, "query context")),
  ];
  if (includeAggregateAliases) items.push(...aliasSuggestions(query, range, "aggregate"));
  return rankItems(query, range, uniqueItems(items));
};

const searchClauseSuggestions = (
  ctx: DslResolverContext,
  query: string,
  range: DslQueryTextRange,
  segment: string,
  currentSource?: CompletionRequest["currentSource"],
): DslQueryCompletionItem[] => {
  const body = segment.trimStart().replace(/^search\b/i, "");
  const quoted = body.trimStart().match(SEARCH_QUOTED_RE);
  if (quoted) {
    const rest = body.trimStart().slice(quoted[0].length);
    if (/^\s+i?n?$/i.test(rest)) return keywordItems(query, range, [{ label: "in", insertText: "in ", detail: "Search specific fields" }]);
    if (/^\s+in\s+[\s\S]*$/i.test(rest)) {
      const fieldList = rest.replace(/^\s+in\b/i, "");
      const part = fieldList.slice(fieldList.lastIndexOf(",") + 1);
      const completed = completedQualifiedRef(part);
      if (completed && completed.tail.trim().length > 0) return newlinePrefixedItems(topLevelSuggestions(query, range));
      return fieldReferenceSuggestions(ctx, query, range, "search", undefined, currentSource);
    }
    return [];
  }
  if (matchesNeedle(query, range, ["'text'"])) return [completionItem(range, "literal", "quoted search text", "''", "search text")];
  return [];
};

export const clauseSuggestions = (
  kind: string,
  ctx: DslResolverContext,
  query: string,
  range: DslQueryTextRange,
  segment: string,
  currentSource?: CompletionRequest["currentSource"],
  contextKeys: readonly DslQueryContextKey[] = [],
): DslQueryCompletionItem[] => {
  switch (kind) {
    case "":
      return topLevelSuggestions(query, range);
    case "from":
      return sourceClauseSuggestions(ctx, query, range, segment);
    case "join":
      return joinClauseSuggestions(ctx, query, range, segment, currentSource);
    case "select":
      return selectClauseSuggestions(ctx, query, range, segment, currentSource);
    case "where":
      return predicateSuggestions(ctx, query, range, segment, false, currentSource, contextKeys);
    case "group":
      return groupClauseSuggestions(ctx, query, range, segment, currentSource);
    case "aggregate":
      return aggregateClauseSuggestions(ctx, query, range, segment, currentSource);
    case "having":
      return predicateSuggestions(ctx, query, range, segment, true, currentSource, contextKeys);
    case "sort":
      return sortClauseSuggestions(ctx, query, range, segment, currentSource);
    case "search":
      return searchClauseSuggestions(ctx, query, range, segment, currentSource);
    case "limit":
      return numericClauseSuggestions(query, range, segment, "limit");
    case "offset":
      return numericClauseSuggestions(query, range, segment, "offset");
    case "deleted":
      return deletedClauseSuggestions(query, range, segment);
    default:
      return topLevelSuggestions(query, range);
  }
};
