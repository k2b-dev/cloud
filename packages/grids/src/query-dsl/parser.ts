import { isAggregateKind } from "../aggregate-catalog";
import { parseFormula } from "../formula/parser";
import type { Expr } from "../formula/types";
import { parseIdentifierRef, parseQualifiedIdentifierRef, QUERY_RESERVED_WORDS, splitTrailingKeywordOutsideQuotes } from "../ref-syntax";
import type {
  DslAggregateFn,
  DslAggregateItem,
  DslGroupItem,
  DslJoin,
  DslParseDiagnostic,
  DslParseResult,
  DslQualifiedRef,
  DslQueryAst,
  DslSelectItem,
  DslSortItem,
  DslSourceRef,
  DslSourceSpan,
} from "./types";

const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const GROUP_GRANULARITIES = new Set(["day", "week", "month", "quarter", "year"]);
const RESERVED_ALIASES = QUERY_RESERVED_WORDS;
const emptyAst = (): DslQueryAst => ({
  joins: [],
  select: [],
  groupBy: [],
  aggregations: [],
  sort: [],
});

const error = (line: number, message: string, column?: number, length?: number): DslParseDiagnostic => ({
  line,
  ...(column !== undefined ? { column } : {}),
  ...(length !== undefined ? { length } : {}),
  message,
});

const LEGACY_HASH_REF_MESSAGE =
  'legacy # references are not valid in GQL; use a field or source name like Amount, a quoted name like "Line total", or a stable id like {fieldId}';

const sourceSpan = (line: number, column: number, text: string): DslSourceSpan => ({
  line,
  column,
  length: Math.max(text.trim().length, 1),
});

const atColumn = (diagnostic: DslParseDiagnostic, column: number): DslParseDiagnostic =>
  diagnostic.column === undefined ? { ...diagnostic, column } : diagnostic;

const stripComment = (line: string): { text: string; attachedCommentColumn?: number } => {
  let quote: string | null = null;
  let braceDepth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\" && i + 1 < line.length) {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (braceDepth > 0) {
      if (c === "{") braceDepth++;
      if (c === "}") braceDepth--;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "{") {
      braceDepth++;
      continue;
    }
    if (c === "-" && line[i + 1] === "-") {
      const previous = line[i - 1];
      return {
        text: line.slice(0, i),
        ...(previous && !/\s/.test(previous) ? { attachedCommentColumn: i + 1 } : {}),
      };
    }
  }
  return { text: line };
};

type InlineClause = { text: string; column: number };
type InlineClauses = { clauses: InlineClause[]; attachedCommentColumn?: number };

const inlineSourceLimitStartAt = (input: string, whitespaceStart: number): number | null => {
  let start = whitespaceStart;
  while (start < input.length && /\s/.test(input[start]!)) start++;
  return /^limit\s+\d+\s*$/i.test(input.slice(start)) ? start : null;
};

const inlineColumn = (leadingOffset: number, source: string, start: number, end = source.length): number => {
  const raw = source.slice(start, end);
  const local = raw.search(/\S/);
  return leadingOffset + start + (local < 0 ? 0 : local) + 1;
};

const splitInlineClauses = (line: string): InlineClauses => {
  const stripped = stripComment(line);
  const leadingOffset = stripped.text.match(/^\s*/)?.[0].length ?? 0;
  const trimmed = stripped.text.trim();
  if (!trimmed)
    return { clauses: [], ...(stripped.attachedCommentColumn ? { attachedCommentColumn: stripped.attachedCommentColumn } : {}) };

  const clauses: InlineClause[] = [];
  let start = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let quote: string | null = null;

  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (quote) {
      if (c === "\\" && i + 1 < trimmed.length) {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
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
    if (braceDepth > 0) continue;
    if (c === "(") {
      parenDepth++;
      continue;
    }
    if (c === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (parenDepth === 0 && c === ";") {
      const previous = trimmed.slice(start, i).trim();
      if (previous) clauses.push({ text: previous, column: inlineColumn(leadingOffset, trimmed, start, i) });
      start = i + 1;
      continue;
    }
    if (parenDepth === 0 && braceDepth === 0 && /\s/.test(c)) {
      const boundary = inlineSourceLimitStartAt(trimmed, i);
      const previous = trimmed.slice(start, i).trim();
      if (boundary !== null && /^from\s+(?:table|view)\s+\S/i.test(previous)) {
        clauses.push({ text: previous, column: inlineColumn(leadingOffset, trimmed, start, i) });
        start = boundary;
        i = boundary - 1;
      }
    }
  }

  const tail = trimmed.slice(start).trim();
  if (tail) clauses.push({ text: tail, column: inlineColumn(leadingOffset, trimmed, start) });
  return { clauses, ...(stripped.attachedCommentColumn ? { attachedCommentColumn: stripped.attachedCommentColumn } : {}) };
};

type TopLevelPart = { text: string; start: number };

const trimmedTopLevelPart = (input: string, start: number, end: number): TopLevelPart | null => {
  const raw = input.slice(start, end);
  const leading = raw.search(/\S/);
  if (leading < 0) return null;
  const text = raw.trim();
  return text ? { text, start: start + leading } : null;
};

const splitTopLevelParts = (input: string): TopLevelPart[] => {
  const parts: TopLevelPart[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === "\\" && i + 1 < input.length) {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (depth < 0) throw new Error("unbalanced closing parenthesis");
    if (c === "," && depth === 0) {
      const part = trimmedTopLevelPart(input, start, i);
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  if (quote) throw new Error("unterminated string literal");
  if (depth !== 0) throw new Error("unbalanced parenthesis");
  const tail = trimmedTopLevelPart(input, start, input.length);
  if (!tail && input.trimEnd().endsWith(",")) throw new Error("trailing comma");
  if (tail) parts.push(tail);
  return parts;
};

const splitAlias = (input: string): { value: string; alias?: string } => {
  const match = input.match(/^(?<value>[\s\S]+?)\s+as\s+(?<alias>[A-Za-z_][A-Za-z0-9_]*)$/i);
  if (!match?.groups) return { value: input.trim() };
  const value = match.groups.value;
  const alias = match.groups.alias;
  if (!value || !alias) return { value: input.trim() };
  return { value: value.trim(), alias };
};

const validateAlias = (alias: string, line: number): DslParseDiagnostic | null => {
  if (!ALIAS_RE.test(alias)) return error(line, `invalid alias "${alias}"`);
  if (RESERVED_ALIASES.has(alias.toLowerCase())) return error(line, `alias "${alias}" is reserved`);
  return null;
};

const aliasKey = (alias: string): string => alias.toLowerCase();
const sameAlias = (left: string | undefined, right: string): boolean => Boolean(left && aliasKey(left) === aliasKey(right));

const isIdentifierPart = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_]/.test(c);

const legacyHashRefDiagnostic = (input: string, line: number, column: number): DslParseDiagnostic | null => {
  const trimmed = input.trim();
  if (!/^#[A-Za-z0-9_][A-Za-z0-9_-]*/.test(trimmed)) return null;
  return error(
    line,
    LEGACY_HASH_REF_MESSAGE,
    column + input.indexOf(trimmed),
    trimmed.match(/^#[A-Za-z0-9_][A-Za-z0-9_-]*/)?.[0].length ?? 1,
  );
};

const legacySourceHashRefDiagnostic = (input: string, line: number, column: number): DslParseDiagnostic | null => {
  const trimmed = input.trim();
  const typed = trimmed.match(/^(?:table|view)\s+(?<ref>[\s\S]+)$/i);
  const ref = typed?.groups?.ref ?? trimmed;
  return legacyHashRefDiagnostic(ref, line, column + input.indexOf(ref));
};

const parseRef = (input: string, line?: number, column?: number): DslQualifiedRef | null => {
  const parsed = parseQualifiedIdentifierRef(input);
  if (!parsed) return null;
  if (parsed.scope && validateAlias(parsed.scope, 0)) return null;
  return {
    ...parsed,
    ...(line !== undefined && column !== undefined ? { span: sourceSpan(line, column, input) } : {}),
  };
};

const parseSource = (input: string, line?: number, column?: number): DslSourceRef | null => {
  const trimmed = input.trim();
  const trimmedColumn = column === undefined ? undefined : column + (input.match(/^\s*/)?.[0].length ?? 0);
  const typed = trimmed.match(/^(?<kind>table|view)\s+(?<ref>[\s\S]+)$/i);
  if (typed?.groups) {
    const kind = typed.groups.kind?.toLowerCase();
    const ref = typed.groups.ref ? parseIdentifierRef(typed.groups.ref) : null;
    if ((kind !== "table" && kind !== "view") || !ref) return null;
    const refOffset = typed.groups.ref ? trimmed.indexOf(typed.groups.ref) : 0;
    return {
      kind,
      ref,
      ...(line !== undefined && trimmedColumn !== undefined
        ? { span: sourceSpan(line, trimmedColumn + refOffset, typed.groups.ref ?? trimmed) }
        : {}),
    };
  }
  return null;
};

const parseFromSource = (
  input: string,
  line: number,
  column: number,
): { source?: DslSourceRef; alias?: string; diagnostic?: DslParseDiagnostic } => {
  const split = splitTrailingKeywordOutsideQuotes(input.trim(), "as");
  const sourceRaw = split ? split[0] : input;
  const aliasRaw = split ? split[1] : undefined;
  const source = parseSource(sourceRaw, line, column + input.indexOf(sourceRaw));
  if (!source) {
    const startsWithSourceKind = /^(?:table|view)(?:\s|$)/i.test(sourceRaw.trim());
    return {
      diagnostic:
        legacySourceHashRefDiagnostic(sourceRaw, line, column + input.indexOf(sourceRaw)) ??
        error(line, startsWithSourceKind ? "invalid from source" : 'from source must start with "table" or "view"'),
    };
  }
  if (!aliasRaw) return { source };
  const aliasError = validateAlias(aliasRaw, line);
  if (aliasError) return { diagnostic: aliasError };
  return { source, alias: aliasRaw };
};

const unwrapFormulaCall = (input: string): string | null => {
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith("formula(") || !trimmed.endsWith(")")) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = "formula".length; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (quote) {
      if (c === "\\" && i + 1 < trimmed.length) {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (depth === 0 && i < trimmed.length - 1) return null;
  }
  if (depth !== 0 || quote) return null;
  return trimmed.slice("formula(".length, -1).trim();
};

const isExpressionIdentifierBoundary = (c: string | undefined): boolean => !c || !isIdentifierPart(c);

const gqlExpressionSyntaxIssue = (input: string): { message: string; offset: number; length: number } | null => {
  let quote: string | null = null;
  let braceDepth = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === "\\" && i + 1 < input.length) {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
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
    if (braceDepth > 0) continue;
    if (c === "#") {
      const match = input.slice(i + 1).match(/^[A-Za-z0-9_][A-Za-z0-9_-]*/);
      if (match) {
        return {
          message: `legacy # field references are not valid in GQL; use a field name like Amount, a quoted name like "Line total", or a stable id like {fieldId}`,
          offset: i,
          length: match[0].length + 1,
        };
      }
    }
    if (input.startsWith("&&", i)) return { message: `use "and" instead of "&&" in GQL predicates`, offset: i, length: 2 };
    if (input.startsWith("||", i)) return { message: `use "or" instead of "||" in GQL predicates`, offset: i, length: 2 };
    if (c === "!" && input[i + 1] !== "=") return { message: `use "not" instead of "!" in GQL predicates`, offset: i, length: 1 };
    const maybeFormula = input.slice(i, i + "formula".length);
    const formulaWrapper = maybeFormula.toLowerCase() === "formula" && input.slice(i + "formula".length).match(/^\s*\(/);
    if (formulaWrapper && isExpressionIdentifierBoundary(input[i - 1])) {
      return {
        message: `where and having clauses already use formula syntax; write the expression directly without formula(...)`,
        offset: i,
        length: "formula".length,
      };
    }
  }
  return null;
};

const gqlLogicalCallIssue = (expr: Expr): { message: string; offset: number; length: number } | null => {
  switch (expr.kind) {
    case "call": {
      const fn = expr.fn.toUpperCase();
      if (fn === "AND" || fn === "OR" || fn === "NOT") {
        return {
          message: `use "${fn.toLowerCase()}" as an operator instead of "${fn}(...)" in GQL expressions`,
          offset: expr.span?.start ?? 0,
          length: fn.length,
        };
      }
      for (const arg of expr.args) {
        const issue = gqlLogicalCallIssue(arg);
        if (issue) return issue;
      }
      return null;
    }
    case "binop":
      return gqlLogicalCallIssue(expr.left) ?? gqlLogicalCallIssue(expr.right);
    case "unop":
      return gqlLogicalCallIssue(expr.operand);
    default:
      return null;
  }
};

const parseExpression = (
  source: string,
  line: number,
  column: number,
): { ok: true; expression: Expr; source: string } | { ok: false; diagnostic: DslParseDiagnostic } => {
  const leadingWhitespace = source.length - source.trimStart().length;
  const expressionSource = source.trim();
  const expressionColumn = column + leadingWhitespace;
  if (!expressionSource) return { ok: false, diagnostic: error(line, "missing expression") };
  const issue = gqlExpressionSyntaxIssue(expressionSource);
  if (issue) return { ok: false, diagnostic: error(line, issue.message, expressionColumn + issue.offset, issue.length) };
  const parsed = parseFormula(expressionSource, { scopedRefs: true, contextRefs: true });
  if (!parsed.ok) {
    const { span } = parsed.diagnostic;
    return {
      ok: false,
      diagnostic: error(line, parsed.error, expressionColumn + span.start, Math.max(span.end - span.start, 1)),
    };
  }
  const logicalCallIssue = gqlLogicalCallIssue(parsed.ast);
  if (logicalCallIssue) {
    return {
      ok: false,
      diagnostic: error(line, logicalCallIssue.message, expressionColumn + logicalCallIssue.offset, logicalCallIssue.length),
    };
  }
  return { ok: true, expression: parsed.ast, source: expressionSource };
};

const normalizeAggregateFn = (fn: string): DslAggregateFn | null => {
  const lower = fn.toLowerCase();
  if (lower === "countempty") return "countEmpty";
  if (lower === "countunique") return "countUnique";
  return isAggregateKind(lower) ? lower : null;
};

const parseSelectItem = (input: string, line: number, column: number): { item?: DslSelectItem; diagnostic?: DslParseDiagnostic } => {
  const { value, alias } = splitAlias(input);
  const span = sourceSpan(line, column, input);
  const formulaSource = /^(documentCount|latestDocumentAt)\s*\(/i.test(value) ? value : unwrapFormulaCall(value);
  if (formulaSource !== null) {
    if (!alias) return { diagnostic: error(line, "formula select items need an alias") };
    const aliasError = validateAlias(alias, line);
    if (aliasError) return { diagnostic: aliasError };
    const formulaOffset = Math.max(0, value.indexOf(formulaSource));
    const expr = parseExpression(formulaSource, line, column + input.indexOf(value) + formulaOffset);
    if (!expr.ok) return { diagnostic: expr.diagnostic };
    return { item: { kind: "formula", expression: expr.expression, source: expr.source, alias, span } };
  }
  const fieldColumn = column + input.indexOf(value);
  const field = parseRef(value, line, fieldColumn);
  if (!field) return { diagnostic: legacyHashRefDiagnostic(value, line, fieldColumn) ?? error(line, `invalid select item "${input}"`) };
  if (alias) {
    const aliasError = validateAlias(alias, line);
    if (aliasError) return { diagnostic: aliasError };
  }
  return { item: { kind: "field", field, ...(alias ? { alias } : {}), span } };
};

const parseAggregateItem = (input: string, line: number, column: number): { item?: DslAggregateItem; diagnostic?: DslParseDiagnostic } => {
  const { value, alias } = splitAlias(input);
  const span = sourceSpan(line, column, input);
  if (!alias) return { diagnostic: error(line, "aggregate items need an alias") };
  const aliasError = validateAlias(alias, line);
  if (aliasError) return { diagnostic: aliasError };
  const match = value.match(/^(?<fn>[A-Za-z][A-Za-z0-9_]*)\((?<arg>[\s\S]*)\)$/);
  if (!match?.groups) return { diagnostic: error(line, `invalid aggregate item "${input}"`) };
  const fnRaw = match.groups.fn;
  const argRaw = match.groups.arg;
  if (!fnRaw || argRaw === undefined) return { diagnostic: error(line, `invalid aggregate item "${input}"`) };
  const fn = normalizeAggregateFn(fnRaw);
  if (!fn) return { diagnostic: error(line, `unsupported aggregate "${fnRaw}"`) };
  const arg = argRaw.trim();
  if (arg === "*") return { item: { fn, argument: "*", alias, span } };
  const formulaSource = unwrapFormulaCall(arg);
  if (formulaSource !== null) {
    const formulaOffset = Math.max(0, argRaw.indexOf(formulaSource));
    const expr = parseExpression(formulaSource, line, column + input.indexOf(argRaw) + formulaOffset);
    if (!expr.ok) return { diagnostic: expr.diagnostic };
    return { item: { fn, argument: { kind: "formula", expression: expr.expression, source: expr.source }, alias, span } };
  }
  const argColumn = column + input.indexOf(argRaw) + argRaw.indexOf(arg);
  const ref = parseRef(arg, line, argColumn);
  if (!ref) return { diagnostic: legacyHashRefDiagnostic(arg, line, argColumn) ?? error(line, `invalid aggregate argument "${arg}"`) };
  return { item: { fn, argument: ref, alias, span } };
};

const parseGroupItem = (input: string, line: number, column: number): { item?: DslGroupItem; diagnostic?: DslParseDiagnostic } => {
  const split = splitTrailingKeywordOutsideQuotes(input.trim(), "by");
  const fieldRaw = split ? split[0] : input.trim();
  const fieldColumn = column + input.indexOf(fieldRaw);
  const field = parseRef(fieldRaw, line, fieldColumn);
  if (!field) return { diagnostic: legacyHashRefDiagnostic(fieldRaw, line, fieldColumn) ?? error(line, `invalid group field "${input}"`) };
  const granularity = split?.[1]?.toLowerCase();
  if (granularity && !GROUP_GRANULARITIES.has(granularity))
    return { diagnostic: error(line, `unsupported group granularity "${granularity}"`) };
  return {
    item: {
      field,
      ...(granularity ? { granularity: granularity as DslGroupItem["granularity"] } : {}),
      span: sourceSpan(line, column, input),
    },
  };
};

const parseSortItem = (input: string, line: number, column: number): { item?: DslSortItem; diagnostic?: DslParseDiagnostic } => {
  // Optional trailing `nulls first` / `nulls last`, stripped before the
  // direction so `sort due asc nulls first` parses cleanly.
  let working = input.trim();
  let nullsFirst: boolean | undefined;
  const nullsLast = splitTrailingKeywordOutsideQuotes(working, "nulls last");
  const nullsFirstSplit = splitTrailingKeywordOutsideQuotes(working, "nulls first");
  if (nullsLast && nullsLast[1] === "") {
    working = nullsLast[0];
    nullsFirst = false;
  } else if (nullsFirstSplit && nullsFirstSplit[1] === "") {
    working = nullsFirstSplit[0];
    nullsFirst = true;
  }

  const legacyDirection =
    (["ascending", "descending"] as const)
      .map((direction) => ({ direction, split: splitTrailingKeywordOutsideQuotes(working, direction) }))
      .find((item) => item.split && item.split[1] === "") ?? null;
  if (legacyDirection) {
    return {
      diagnostic: error(
        line,
        `use "${legacyDirection.direction === "ascending" ? "asc" : "desc"}" instead of "${legacyDirection.direction}"`,
        column + input.lastIndexOf(legacyDirection.direction),
        legacyDirection.direction.length,
      ),
    };
  }

  const split =
    (["asc", "desc"] as const)
      .map((direction) => ({ direction, split: splitTrailingKeywordOutsideQuotes(working, direction) }))
      .find((item) => item.split && item.split[1] === "") ?? null;
  const target = split?.split ? split.split[0] : working;
  if (!target) return { diagnostic: error(line, `invalid sort item "${input}"`) };
  const directionRaw = split?.direction;
  const direction = directionRaw === "desc" ? "desc" : "asc";
  const nulls = nullsFirst === undefined ? {} : { nullsFirst };
  const targetColumn = column + input.indexOf(target);
  const span = sourceSpan(line, column, input);
  const ref = parseRef(target, line, targetColumn);
  if (ref) return { item: { target: ref, direction, ...nulls, span } };
  const legacyRef = legacyHashRefDiagnostic(target, line, targetColumn);
  if (legacyRef) return { diagnostic: legacyRef };
  const aliasError = validateAlias(target, line);
  if (aliasError) return { diagnostic: aliasError };
  return { item: { target: { kind: "alias", alias: target }, direction, ...nulls, span } };
};

const splitJoinEquality = (input: string): [left: string, right: string] | null => {
  let quoted = false;
  let equalityIndex = -1;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === `"` && input[i + 1] === `"`) {
        i++;
        continue;
      }
      if (c === `"`) quoted = false;
      continue;
    }
    if (c === `"`) {
      quoted = true;
      continue;
    }
    if (c !== "=") continue;
    if (equalityIndex !== -1) return null;
    equalityIndex = i;
  }
  if (quoted || equalityIndex === -1) return null;
  const left = input.slice(0, equalityIndex).trim();
  const right = input.slice(equalityIndex + 1).trim();
  return left && right ? [left, right] : null;
};

const parseJoin = (lineSource: string, line: number, column: number): { item?: DslJoin; diagnostic?: DslParseDiagnostic } => {
  const match = lineSource.match(
    /^(?<mode>left\s+)?join\s+(?<source>[\s\S]+?)\s+as\s+(?<alias>[A-Za-z_][A-Za-z0-9_]*)\s+on\s+(?<condition>[\s\S]+)$/i,
  );
  if (!match?.groups) return { diagnostic: error(line, `invalid join clause`) };
  const sourceRaw = match.groups.source;
  const alias = match.groups.alias;
  const conditionRaw = match.groups.condition;
  const equality = conditionRaw ? splitJoinEquality(conditionRaw) : null;
  if (!sourceRaw || !alias || !conditionRaw || !equality) return { diagnostic: error(line, "invalid join refs") };
  const [leftRaw, rightRaw] = equality;
  const conditionColumn = column + lineSource.lastIndexOf(conditionRaw);
  const source = parseSource(sourceRaw, line, column + lineSource.indexOf(sourceRaw));
  const left = parseRef(leftRaw, line, conditionColumn + conditionRaw.indexOf(leftRaw));
  const right = parseRef(rightRaw, line, conditionColumn + conditionRaw.lastIndexOf(rightRaw));
  const aliasError = validateAlias(alias, line);
  if (aliasError) return { diagnostic: aliasError };
  if (!source || !left || !right) {
    const sourceDiagnostic = legacySourceHashRefDiagnostic(sourceRaw, line, column + lineSource.indexOf(sourceRaw));
    const leftDiagnostic = legacyHashRefDiagnostic(leftRaw, line, column + lineSource.indexOf(leftRaw));
    const rightDiagnostic = legacyHashRefDiagnostic(rightRaw, line, column + lineSource.lastIndexOf(rightRaw));
    return { diagnostic: sourceDiagnostic ?? leftDiagnostic ?? rightDiagnostic ?? error(line, "invalid join refs") };
  }
  return {
    item: {
      mode: match.groups.mode ? "left" : "inner",
      source,
      alias,
      on: { left, right },
      span: sourceSpan(line, column, lineSource),
    },
  };
};

const validateJoinScopes = (join: DslJoin, availableScopes: Set<string>, line: number): DslParseDiagnostic | null => {
  if (availableScopes.has(aliasKey(join.alias))) return error(line, `duplicate join alias "${join.alias}"`);
  const sides = [join.on.left, join.on.right];
  const newAliasSides = sides.filter((side) => sameAlias(side.scope, join.alias)).length;
  if (newAliasSides !== 1) return error(line, `join on must reference "${join.alias}" on exactly one side`);
  const unknownScope = sides.find((side) => side.scope && !sameAlias(side.scope, join.alias) && !availableScopes.has(aliasKey(side.scope)));
  if (unknownScope?.scope) return error(line, `unknown join scope "${unknownScope.scope}"`);
  return null;
};

const parseCommaItems = <T>(
  body: string,
  line: number,
  column: number,
  parseItem: (item: string, line: number, column: number) => { item?: T; diagnostic?: DslParseDiagnostic },
): { items: T[]; diagnostics: DslParseDiagnostic[] } => {
  const items: T[] = [];
  const diagnostics: DslParseDiagnostic[] = [];
  let parts: TopLevelPart[];
  try {
    parts = splitTopLevelParts(body);
  } catch (e) {
    return { items, diagnostics: [error(line, e instanceof Error ? e.message : String(e))] };
  }
  if (parts.length === 0) return { items, diagnostics: [error(line, "missing clause body")] };
  for (const part of parts) {
    const parsed = parseItem(part.text, line, column + part.start);
    if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
    if (parsed.item) items.push(parsed.item);
  }
  return { items, diagnostics };
};

const parseBoundedIntegerClause = (
  name: "limit" | "offset",
  body: string,
  line: number,
): { value?: number; diagnostic?: DslParseDiagnostic } => {
  if (!/^\d+$/.test(body)) {
    return { diagnostic: error(line, name === "limit" ? "limit must be a positive integer" : "offset must be a non-negative integer") };
  }
  const value = Number(body);
  const min = name === "limit" ? 1 : 0;
  if (!Number.isSafeInteger(value) || value < min || value > 10_000) {
    return { diagnostic: error(line, `${name} must be between ${min} and 10000`) };
  }
  return { value };
};

const SEARCH_QUOTED_RE = /^'((?:\\.|[^'\\])*)'/;

const parseSearch = (
  body: string,
  line: number,
  column: number,
): { item?: { q: string; fields: DslQualifiedRef[]; span: DslSourceSpan }; diagnostic?: DslParseDiagnostic } => {
  const match = body.match(SEARCH_QUOTED_RE);
  if (!match) return { diagnostic: error(line, "search expects quoted text, e.g. search 'open'") };
  const q = match[1]!.replace(/\\(.)/g, "$1");
  if (q.trim().length === 0) return { diagnostic: error(line, "search text cannot be empty") };

  const rest = body.slice(match[0].length).trim();
  const fields: DslQualifiedRef[] = [];
  if (rest) {
    const inMatch = rest.match(/^in\s+/i);
    if (!inMatch) return { diagnostic: error(line, `unexpected "${rest}" after search text; use: search 'text' in field1, field2`) };
    let parts: TopLevelPart[];
    const fieldList = rest.slice(inMatch[0].length).trim();
    const fieldListColumn =
      column + body.indexOf(rest) + inMatch[0].length + (rest.slice(inMatch[0].length).match(/^\s*/)?.[0].length ?? 0);
    try {
      parts = splitTopLevelParts(fieldList);
    } catch (e) {
      return { diagnostic: error(line, e instanceof Error ? e.message : String(e)) };
    }
    for (const part of parts) {
      const ref = parseRef(part.text, line, fieldListColumn + part.start);
      if (!ref)
        return {
          diagnostic:
            legacyHashRefDiagnostic(part.text, line, fieldListColumn + part.start) ?? error(line, `invalid search field "${part.text}"`),
        };
      fields.push(ref);
    }
  }
  return { item: { q, fields, span: sourceSpan(line, column, body) } };
};

type Clause =
  | { kind: "from"; body: string }
  | { kind: "select"; body: string }
  | { kind: "where"; body: string }
  | { kind: "join"; body: string }
  | { kind: "group"; body: string }
  | { kind: "aggregate"; body: string }
  | { kind: "having"; body: string }
  | { kind: "sort"; body: string }
  | { kind: "search"; body: string }
  | { kind: "limit"; body: string }
  | { kind: "offset"; body: string }
  | { kind: "includeDeleted" }
  | { kind: "deletedOnly" }
  | { kind: "invalid"; message: string };

const readClause = (line: string): Clause | null => {
  const trimmed = line.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "include deleted") return { kind: "includeDeleted" };
  if (lower === "deleted only") return { kind: "deletedOnly" };
  if (lower.startsWith("from ")) return { kind: "from", body: trimmed.slice(5).trim() };
  if (lower.startsWith("select ")) return { kind: "select", body: trimmed.slice(7).trim() };
  if (lower.startsWith("where ")) return { kind: "where", body: trimmed.slice(6).trim() };
  if (lower.startsWith("left join ") || lower.startsWith("join ")) return { kind: "join", body: trimmed };
  if (lower.startsWith("group by ")) return { kind: "group", body: trimmed.slice(9).trim() };
  if (lower.startsWith("aggregate ")) return { kind: "aggregate", body: trimmed.slice(10).trim() };
  if (lower.startsWith("having ")) return { kind: "having", body: trimmed.slice(7).trim() };
  if (lower.startsWith("sort ")) return { kind: "sort", body: trimmed.slice(5).trim() };
  if (lower.startsWith("search ")) return { kind: "search", body: trimmed.slice(7).trim() };
  if (lower.startsWith("limit ")) return { kind: "limit", body: trimmed.slice(6).trim() };
  if (lower.startsWith("offset ")) return { kind: "offset", body: trimmed.slice(7).trim() };
  if (lower.startsWith("skip ")) return { kind: "invalid", message: 'use "offset" instead of "skip"' };
  return null;
};

export const parseGridsQueryDsl = (source: string): DslParseResult => {
  const ast = emptyAst();
  const diagnostics: DslParseDiagnostic[] = [];
  const seenSingleton = new Set<"from" | "where" | "having" | "limit" | "offset" | "search" | "includeDeleted" | "deletedOnly">();
  const availableJoinScopes = new Set<string>();

  const pushSingletonError = (
    kind: "from" | "where" | "having" | "limit" | "offset" | "search" | "includeDeleted" | "deletedOnly",
    line: number,
    column: number,
  ): boolean => {
    if (!seenSingleton.has(kind)) {
      seenSingleton.add(kind);
      return false;
    }
    diagnostics.push(error(line, `duplicate ${kind} clause`, column));
    return true;
  };

  source.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNo = index + 1;
    const { clauses, attachedCommentColumn } = splitInlineClauses(rawLine);
    if (attachedCommentColumn) {
      diagnostics.push(
        error(
          lineNo,
          'comment marker "--" must be preceded by whitespace; write " --" for a comment or use spaces around subtraction',
          attachedCommentColumn,
          2,
        ),
      );
    }
    if (clauses.length === 0) return;
    for (const segment of clauses) {
      const line = segment.text;
      const column = segment.column;
      const clause = readClause(line);
      const bodyColumn = "body" in (clause ?? {}) ? column + line.indexOf((clause as Extract<Clause, { body: string }>).body) : column;
      if (!clause) {
        diagnostics.push(error(lineNo, "unknown clause", column, line.length));
        continue;
      }
      if (clause.kind === "invalid") {
        diagnostics.push(error(lineNo, clause.message, column, line.length));
        continue;
      }

      if (clause.kind === "from") {
        if (pushSingletonError("from", lineNo, column)) continue;
        const parsed = parseFromSource(clause.body, lineNo, bodyColumn);
        if (parsed.diagnostic) {
          diagnostics.push(atColumn(parsed.diagnostic, column));
          continue;
        }
        if (parsed.alias && availableJoinScopes.has(aliasKey(parsed.alias))) {
          diagnostics.push(error(lineNo, `duplicate join alias "${parsed.alias}"`, column));
          continue;
        }
        ast.source = parsed.source;
        if (parsed.alias) {
          ast.sourceAlias = parsed.alias;
          availableJoinScopes.add(aliasKey(parsed.alias));
        }
        continue;
      }

      if (clause.kind === "select") {
        const parsed = parseCommaItems(clause.body, lineNo, bodyColumn, parseSelectItem);
        ast.select.push(...parsed.items);
        diagnostics.push(...parsed.diagnostics.map((diagnostic) => atColumn(diagnostic, column)));
        continue;
      }

      if (clause.kind === "where") {
        if (pushSingletonError("where", lineNo, column)) continue;
        const parsed = parseExpression(clause.body, lineNo, bodyColumn);
        if (parsed.ok)
          ast.where = { expression: parsed.expression, source: parsed.source, span: sourceSpan(lineNo, bodyColumn, clause.body) };
        else diagnostics.push(atColumn(parsed.diagnostic, column));
        continue;
      }

      if (clause.kind === "join") {
        const parsed = parseJoin(clause.body, lineNo, bodyColumn);
        if (parsed.item) {
          const scopeError = validateJoinScopes(parsed.item, availableJoinScopes, lineNo);
          if (scopeError) diagnostics.push(atColumn(scopeError, column));
          else {
            ast.joins.push(parsed.item);
            availableJoinScopes.add(aliasKey(parsed.item.alias));
          }
        }
        if (parsed.diagnostic) diagnostics.push(atColumn(parsed.diagnostic, column));
        continue;
      }

      if (clause.kind === "group") {
        const parsed = parseCommaItems(clause.body, lineNo, bodyColumn, parseGroupItem);
        ast.groupBy.push(...parsed.items);
        diagnostics.push(...parsed.diagnostics.map((diagnostic) => atColumn(diagnostic, column)));
        continue;
      }

      if (clause.kind === "aggregate") {
        const parsed = parseCommaItems(clause.body, lineNo, bodyColumn, parseAggregateItem);
        ast.aggregations.push(...parsed.items);
        diagnostics.push(...parsed.diagnostics.map((diagnostic) => atColumn(diagnostic, column)));
        continue;
      }

      if (clause.kind === "having") {
        if (pushSingletonError("having", lineNo, column)) continue;
        const parsed = parseExpression(clause.body, lineNo, bodyColumn);
        if (parsed.ok)
          ast.having = { expression: parsed.expression, source: parsed.source, span: sourceSpan(lineNo, bodyColumn, clause.body) };
        else diagnostics.push(atColumn(parsed.diagnostic, column));
        continue;
      }

      if (clause.kind === "sort") {
        const parsed = parseCommaItems(clause.body, lineNo, bodyColumn, parseSortItem);
        ast.sort.push(...parsed.items);
        diagnostics.push(...parsed.diagnostics.map((diagnostic) => atColumn(diagnostic, column)));
        continue;
      }

      if (clause.kind === "search") {
        if (pushSingletonError("search", lineNo, column)) continue;
        const parsed = parseSearch(clause.body, lineNo, bodyColumn);
        if (parsed.diagnostic) diagnostics.push(atColumn(parsed.diagnostic, column));
        else if (parsed.item) ast.search = parsed.item;
        continue;
      }

      if (clause.kind === "limit") {
        if (pushSingletonError("limit", lineNo, column)) continue;
        const parsed = parseBoundedIntegerClause("limit", clause.body, lineNo);
        if (parsed.diagnostic) diagnostics.push(atColumn(parsed.diagnostic, column));
        else ast.limit = parsed.value;
        continue;
      }

      if (clause.kind === "offset") {
        if (pushSingletonError("offset", lineNo, column)) continue;
        const parsed = parseBoundedIntegerClause("offset", clause.body, lineNo);
        if (parsed.diagnostic) diagnostics.push(atColumn(parsed.diagnostic, column));
        else ast.offset = parsed.value;
        continue;
      }

      if (clause.kind === "includeDeleted") {
        if (pushSingletonError("includeDeleted", lineNo, column)) continue;
        if (ast.deletedOnly) diagnostics.push(error(lineNo, `"include deleted" and "deleted only" cannot be combined`, column));
        else ast.includeDeleted = true;
        continue;
      }

      if (clause.kind === "deletedOnly") {
        if (pushSingletonError("deletedOnly", lineNo, column)) continue;
        if (ast.includeDeleted) diagnostics.push(error(lineNo, `"include deleted" and "deleted only" cannot be combined`, column));
        else ast.deletedOnly = true;
      }
    }
  });

  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, ast };
};
