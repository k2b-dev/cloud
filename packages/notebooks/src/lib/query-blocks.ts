export const QUERY_MAX_FILTERS = 32;
export const QUERY_MAX_COLUMNS = 16;
export const QUERY_MAX_LIMIT = 100;
export const QUERY_MAX_BLOCKS = 20;
export const QUERY_MAX_VALUES = 100;
export const QUERY_MAX_STRING_LENGTH = 2_000;

export type NotebookBlockDiagnosticCode =
  | "duplicate-key"
  | "invalid-field"
  | "invalid-type"
  | "missing-key"
  | "missing-value"
  | "too-many-items"
  | "unexpected-line"
  | "unknown-key"
  | "unclosed-block";

export type NotebookBlockDiagnostic = {
  code: NotebookBlockDiagnosticCode;
  line: number;
  path: string;
};

export type QueryScope = "notebook" | "children" | "descendants";
export type QueryMatch = "all" | "any";
export type QuerySystemField = "$title" | "$created" | "$updated" | "$tags";
export type QueryField = QuerySystemField | `${string}.${string}`;
export type QueryOperator =
  | "eq"
  | "ne"
  | "in"
  | "not-in"
  | "exists"
  | "missing"
  | "contains"
  | "starts-with"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains-any"
  | "contains-all";
export type QueryScalar = string | number | boolean;

export type QueryFilter = {
  field: QueryField;
  op: QueryOperator;
  value?: QueryScalar | QueryScalar[];
};

export type QueryBlock = {
  source: "notes";
  scope: QueryScope;
  match: QueryMatch;
  where: QueryFilter[];
  sort: {
    field: Exclude<QuerySystemField, "$tags">;
    direction: "asc" | "desc";
  };
  columns: QueryField[];
  limit: number;
  line: number;
};

export type TocBlock = {
  minDepth: number;
  maxDepth: number;
  line: number;
};

type Directive = {
  type: "query" | "toc";
  body: string[];
  line: number;
  closed: boolean;
  from: number;
  to: number;
};

type ParsedValue = QueryScalar | QueryScalar[];

const SYSTEM_FIELDS = new Set<QuerySystemField>(["$title", "$created", "$updated", "$tags"]);
const SORT_FIELDS = new Set<Exclude<QuerySystemField, "$tags">>(["$title", "$created", "$updated"]);
const OPERATORS = new Set<QueryOperator>([
  "eq",
  "ne",
  "in",
  "not-in",
  "exists",
  "missing",
  "contains",
  "starts-with",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains-any",
  "contains-all",
]);
const PROPERTY_FIELD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}\.[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const diagnostic = (code: NotebookBlockDiagnosticCode, line: number, path: string): NotebookBlockDiagnostic => ({
  code,
  line,
  path,
});

const directives = (md: string): Directive[] => {
  const lines = md.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const text of lines) {
    offsets.push(offset);
    offset += text.length + 1;
  }
  const found: Directive[] = [];
  let codeFence: { marker: string; length: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    const fence = trimmed.match(/^(`{3,}|~{3,})/);
    if (fence?.[1]) {
      const marker = fence[1][0]!;
      if (!codeFence) codeFence = { marker, length: fence[1].length };
      else if (marker === codeFence.marker && fence[1].length >= codeFence.length) codeFence = null;
      continue;
    }
    if (codeFence) continue;

    const opener = trimmed.match(/^:::(query|toc)\s*$/);
    if (!opener?.[1]) continue;
    const line = i + 1;
    const body: string[] = [];
    let closed = false;
    for (i = i + 1; i < lines.length; i++) {
      if (lines[i]!.trim() === ":::") {
        closed = true;
        break;
      }
      body.push(lines[i]!);
    }
    found.push({
      type: opener[1] as Directive["type"],
      body,
      line,
      closed,
      from: offsets[line - 1]!,
      to: closed ? offsets[i]! + lines[i]!.length : md.length,
    });
  }
  return found;
};

/** Source geometry only; query validation and result rendering stay server-owned. */
export const extractNotebookDirectiveRanges = (md: string): Array<Pick<Directive, "type" | "line" | "from" | "to" | "closed">> =>
  directives(md).map(({ type, line, from, to, closed }) => ({ type, line, from, to, closed }));

const parseScalar = (raw: string): QueryScalar | null => {
  const value = raw.trim();
  if (!value) return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" && parsed.length <= QUERY_MAX_STRING_LENGTH ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    const parsed = value.slice(1, -1).replace(/''/g, "'");
    return parsed.length <= QUERY_MAX_STRING_LENGTH ? parsed : null;
  }
  if (/^[\[\]{}&*!|>@`]/.test(value)) return null;
  return value.length <= QUERY_MAX_STRING_LENGTH ? value : null;
};

const splitInlineList = (raw: string): string[] | null => {
  const value = raw.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) return null;
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  const items: string[] = [];
  let quote: "'" | '"' | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]!;
    if ((char === "'" || char === '"') && (i === 0 || inner[i - 1] !== "\\")) {
      quote = quote === char ? null : (quote ?? char);
    } else if (char === "," && !quote) {
      items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (quote) return null;
  items.push(inner.slice(start));
  return items;
};

const parseValue = (raw: string): ParsedValue | null => {
  const list = splitInlineList(raw);
  if (list) {
    const values = list.map(parseScalar);
    return values.every((value): value is QueryScalar => value !== null) ? values : null;
  }
  return parseScalar(raw);
};

export const isQueryField = (value: unknown): value is QueryField =>
  typeof value === "string" && (SYSTEM_FIELDS.has(value as QuerySystemField) || PROPERTY_FIELD_RE.test(value));

const parseField = (raw: string): QueryField | null => {
  const value = raw.trim();
  return isQueryField(value) ? value : null;
};

const isQueryScalar = (value: unknown): value is QueryScalar =>
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "string" && value.length <= QUERY_MAX_STRING_LENGTH);

const isIsoInstant = (value: unknown): value is string =>
  typeof value === "string" && RFC3339_RE.test(value) && Number.isFinite(Date.parse(value));

export const isQueryFilter = (value: unknown): value is QueryFilter => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const filter = value as Record<string, unknown>;
  if (!Object.keys(filter).every((key) => ["field", "op", "value"].includes(key))) return false;
  if (!isQueryField(filter.field) || !OPERATORS.has(filter.op as QueryOperator)) return false;
  const field = filter.field;
  const op = filter.op as QueryOperator;
  const operand = filter.value;
  const hasValue = Object.hasOwn(filter, "value");
  const list = Array.isArray(operand) && operand.length > 0 && operand.length <= QUERY_MAX_VALUES && operand.every(isQueryScalar);
  const property = !SYSTEM_FIELDS.has(field as QuerySystemField);

  if (op === "exists" || op === "missing") return !hasValue && (property || field === "$tags");
  if (field === "$tags") {
    if (op === "contains") return typeof operand === "string";
    return (op === "contains-any" || op === "contains-all") && list && operand.every((item) => typeof item === "string");
  }
  if (field === "$title") {
    if (op === "eq" || op === "ne" || op === "contains" || op === "starts-with") return typeof operand === "string";
    return (op === "in" || op === "not-in") && list && operand.every((item) => typeof item === "string");
  }
  if (field === "$created" || field === "$updated") {
    if (op === "eq" || op === "ne") return isIsoInstant(operand);
    return (op === "in" || op === "not-in") && list && operand.every(isIsoInstant);
  }
  if ((op === "eq" || op === "ne") && isQueryScalar(operand)) return true;
  if ((op === "in" || op === "not-in" || op === "contains-any" || op === "contains-all") && list) return true;
  if ((op === "contains" || op === "starts-with") && typeof operand === "string") return true;
  return (op === "gt" || op === "gte" || op === "lt" || op === "lte") && typeof operand === "number" && Number.isFinite(operand);
};

type RawItem = { values: Map<string, { value: string; line: number }>; line: number };

const addValue = (
  target: Map<string, { value: string; line: number }>,
  key: string,
  value: string,
  line: number,
  path: string,
  diagnostics: NotebookBlockDiagnostic[],
) => {
  if (target.has(key)) diagnostics.push(diagnostic("duplicate-key", line, `${path}.${key}`));
  else target.set(key, { value, line });
};

const parseQuery = (directive: Directive): { block?: QueryBlock; diagnostics: NotebookBlockDiagnostic[] } => {
  const diagnostics: NotebookBlockDiagnostic[] = [];
  if (!directive.closed) diagnostics.push(diagnostic("unclosed-block", directive.line, "query"));
  const top = new Map<string, { value: string; line: number }>();
  const filters: RawItem[] = [];
  const sort = new Map<string, { value: string; line: number }>();
  const columns: Array<{ value: string; line: number }> = [];
  let section: "where" | "sort" | "columns" | null = null;
  let activeFilter: RawItem | null = null;

  directive.body.forEach((text, index) => {
    const line = directive.line + index + 1;
    if (!text.trim()) return;
    const topPair = text.match(/^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/);
    if (topPair?.[1] !== undefined) {
      const key = topPair[1];
      const value = topPair[2] ?? "";
      if (!["source", "scope", "match", "where", "sort", "columns", "limit"].includes(key)) {
        diagnostics.push(diagnostic("unknown-key", line, `query.${key}`));
        section = null;
        return;
      }
      if (["where", "sort", "columns"].includes(key)) {
        if (value.trim()) diagnostics.push(diagnostic("invalid-type", line, `query.${key}`));
        if (top.has(key)) diagnostics.push(diagnostic("duplicate-key", line, `query.${key}`));
        else top.set(key, { value, line });
        section = key as typeof section;
        activeFilter = null;
        return;
      }
      addValue(top, key, value, line, "query", diagnostics);
      section = null;
      activeFilter = null;
      return;
    }

    if (section === "where") {
      const first = text.match(/^\s{2}-\s+([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/);
      if (first?.[1]) {
        activeFilter = { values: new Map(), line };
        filters.push(activeFilter);
        addValue(activeFilter.values, first[1], first[2] ?? "", line, `query.where.${filters.length - 1}`, diagnostics);
        return;
      }
      const continuation = text.match(/^\s{4}([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/);
      if (activeFilter && continuation?.[1]) {
        addValue(activeFilter.values, continuation[1], continuation[2] ?? "", line, `query.where.${filters.length - 1}`, diagnostics);
        return;
      }
    } else if (section === "sort") {
      const pair = text.match(/^\s{2}([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/);
      if (pair?.[1]) {
        addValue(sort, pair[1], pair[2] ?? "", line, "query.sort", diagnostics);
        return;
      }
    } else if (section === "columns") {
      const item = text.match(/^\s{2}-\s+(.+)$/);
      if (item?.[1]) {
        columns.push({ value: item[1], line });
        return;
      }
    }
    diagnostics.push(diagnostic("unexpected-line", line, `query.${section ?? "root"}`));
  });

  const source = top.get("source");
  if (!source) diagnostics.push(diagnostic("missing-key", directive.line, "query.source"));
  else if (source.value !== "notes") diagnostics.push(diagnostic("invalid-type", source.line, "query.source"));

  const scopeEntry = top.get("scope");
  const scope = scopeEntry?.value || "notebook";
  if (!["notebook", "children", "descendants"].includes(scope)) {
    diagnostics.push(diagnostic("invalid-type", scopeEntry?.line ?? directive.line, "query.scope"));
  }
  const matchEntry = top.get("match");
  const match = matchEntry?.value || "all";
  if (!["all", "any"].includes(match)) diagnostics.push(diagnostic("invalid-type", matchEntry?.line ?? directive.line, "query.match"));

  const parsedFilters: QueryFilter[] = [];
  if (filters.length > QUERY_MAX_FILTERS) diagnostics.push(diagnostic("too-many-items", filters[QUERY_MAX_FILTERS]!.line, "query.where"));
  for (const [index, item] of filters.slice(0, QUERY_MAX_FILTERS).entries()) {
    const diagnosticsBeforeFilter = diagnostics.length;
    for (const [key, entry] of item.values) {
      if (!["field", "op", "value"].includes(key)) diagnostics.push(diagnostic("unknown-key", entry.line, `query.where.${index}.${key}`));
    }
    const rawField = item.values.get("field");
    const field = rawField ? parseField(rawField.value) : null;
    if (!rawField) diagnostics.push(diagnostic("missing-key", item.line, `query.where.${index}.field`));
    else if (!field) diagnostics.push(diagnostic("invalid-field", rawField.line, `query.where.${index}.field`));
    const rawOp = item.values.get("op");
    const op = rawOp?.value as QueryOperator | undefined;
    if (!rawOp) diagnostics.push(diagnostic("missing-key", item.line, `query.where.${index}.op`));
    else if (!OPERATORS.has(op!)) diagnostics.push(diagnostic("invalid-type", rawOp.line, `query.where.${index}.op`));
    const rawValue = item.values.get("value");
    const value = rawValue ? parseValue(rawValue.value) : null;
    const needsNoValue = op === "exists" || op === "missing";
    if (!needsNoValue && !rawValue) diagnostics.push(diagnostic("missing-value", item.line, `query.where.${index}.value`));
    else if (rawValue && (needsNoValue || value === null))
      diagnostics.push(diagnostic("invalid-type", rawValue.line, `query.where.${index}.value`));
    else if ((op === "gt" || op === "gte" || op === "lt" || op === "lte") && typeof value !== "number") {
      diagnostics.push(diagnostic("invalid-type", rawValue?.line ?? item.line, `query.where.${index}.value`));
    } else if (
      (op === "in" || op === "not-in" || op === "contains-any" || op === "contains-all") &&
      (!Array.isArray(value) || !value.length || value.length > QUERY_MAX_VALUES)
    ) {
      diagnostics.push(diagnostic("invalid-type", rawValue?.line ?? item.line, `query.where.${index}.value`));
    } else if ((op === "contains" || op === "starts-with") && typeof value !== "string") {
      diagnostics.push(diagnostic("invalid-type", rawValue?.line ?? item.line, `query.where.${index}.value`));
    }
    if (field && op && OPERATORS.has(op) && (needsNoValue || value !== null) && diagnostics.length === diagnosticsBeforeFilter) {
      const filter = needsNoValue ? { field, op } : { field, op, value: value! };
      if (isQueryFilter(filter)) parsedFilters.push(filter);
      else diagnostics.push(diagnostic("invalid-type", rawOp?.line ?? item.line, `query.where.${index}.op`));
    }
  }

  for (const [key, entry] of sort) {
    if (!["field", "direction"].includes(key)) diagnostics.push(diagnostic("unknown-key", entry.line, `query.sort.${key}`));
  }
  const sortFieldEntry = sort.get("field");
  const sortField = sortFieldEntry?.value || "$updated";
  if (!SORT_FIELDS.has(sortField as Exclude<QuerySystemField, "$tags">)) {
    diagnostics.push(diagnostic("invalid-field", sortFieldEntry?.line ?? directive.line, "query.sort.field"));
  }
  const directionEntry = sort.get("direction");
  const direction = directionEntry?.value || "desc";
  if (direction !== "asc" && direction !== "desc") {
    diagnostics.push(diagnostic("invalid-type", directionEntry?.line ?? directive.line, "query.sort.direction"));
  }

  if (columns.length > QUERY_MAX_COLUMNS) diagnostics.push(diagnostic("too-many-items", columns[QUERY_MAX_COLUMNS]!.line, "query.columns"));
  const parsedColumns: QueryField[] = [];
  const seenColumns = new Set<QueryField>();
  for (const [index, column] of columns.slice(0, QUERY_MAX_COLUMNS).entries()) {
    const field = parseField(column.value);
    if (!field) diagnostics.push(diagnostic("invalid-field", column.line, `query.columns.${index}`));
    else if (seenColumns.has(field)) diagnostics.push(diagnostic("duplicate-key", column.line, `query.columns.${index}`));
    else {
      seenColumns.add(field);
      parsedColumns.push(field);
    }
  }

  const limitEntry = top.get("limit");
  const limit = limitEntry ? Number(limitEntry.value) : 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_MAX_LIMIT) {
    diagnostics.push(diagnostic("invalid-type", limitEntry?.line ?? directive.line, "query.limit"));
  }

  if (diagnostics.length > 0) return { diagnostics };
  return {
    diagnostics,
    block: {
      source: "notes",
      scope: scope as QueryScope,
      match: match as QueryMatch,
      where: parsedFilters,
      sort: {
        field: sortField as Exclude<QuerySystemField, "$tags">,
        direction: direction as "asc" | "desc",
      },
      columns: parsedColumns,
      limit,
      line: directive.line,
    },
  };
};

const parseToc = (directive: Directive): { block?: TocBlock; diagnostics: NotebookBlockDiagnostic[] } => {
  const diagnostics: NotebookBlockDiagnostic[] = [];
  if (!directive.closed) diagnostics.push(diagnostic("unclosed-block", directive.line, "toc"));
  const values = new Map<string, { value: string; line: number }>();
  directive.body.forEach((text, index) => {
    const line = directive.line + index + 1;
    if (!text.trim()) return;
    const pair = text.match(/^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/);
    if (!pair?.[1]) {
      diagnostics.push(diagnostic("unexpected-line", line, "toc"));
      return;
    }
    if (!["min-depth", "max-depth"].includes(pair[1])) {
      diagnostics.push(diagnostic("unknown-key", line, `toc.${pair[1]}`));
      return;
    }
    addValue(values, pair[1], pair[2] ?? "", line, "toc", diagnostics);
  });
  const minEntry = values.get("min-depth");
  const maxEntry = values.get("max-depth");
  const minDepth = minEntry ? Number(minEntry.value) : 1;
  const maxDepth = maxEntry ? Number(maxEntry.value) : 6;
  if (!Number.isInteger(minDepth) || minDepth < 1 || minDepth > 6)
    diagnostics.push(diagnostic("invalid-type", minEntry?.line ?? directive.line, "toc.min-depth"));
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 6)
    diagnostics.push(diagnostic("invalid-type", maxEntry?.line ?? directive.line, "toc.max-depth"));
  if (Number.isInteger(minDepth) && Number.isInteger(maxDepth) && minDepth > maxDepth) {
    diagnostics.push(diagnostic("invalid-type", maxEntry?.line ?? directive.line, "toc.max-depth"));
  }
  return diagnostics.length > 0 ? { diagnostics } : { diagnostics, block: { minDepth, maxDepth, line: directive.line } };
};

export const parseNotebookQueryBlocks = (
  md: string | null | undefined,
): { blocks: QueryBlock[]; diagnostics: NotebookBlockDiagnostic[] } => {
  const blocks: QueryBlock[] = [];
  const diagnostics: NotebookBlockDiagnostic[] = [];
  const queryDirectives = directives(md ?? "").filter((entry) => entry.type === "query");
  if (queryDirectives.length > QUERY_MAX_BLOCKS) {
    diagnostics.push(diagnostic("too-many-items", queryDirectives[QUERY_MAX_BLOCKS]!.line, "query"));
  }
  for (const directive of queryDirectives.slice(0, QUERY_MAX_BLOCKS)) {
    const parsed = parseQuery(directive);
    if (parsed.block) blocks.push(parsed.block);
    diagnostics.push(...parsed.diagnostics);
  }
  return { blocks, diagnostics };
};

export const parseNotebookTocBlocks = (md: string | null | undefined): { blocks: TocBlock[]; diagnostics: NotebookBlockDiagnostic[] } => {
  const blocks: TocBlock[] = [];
  const diagnostics: NotebookBlockDiagnostic[] = [];
  for (const directive of directives(md ?? "").filter((entry) => entry.type === "toc")) {
    const parsed = parseToc(directive);
    if (parsed.block) blocks.push(parsed.block);
    diagnostics.push(...parsed.diagnostics);
  }
  return { blocks, diagnostics };
};
