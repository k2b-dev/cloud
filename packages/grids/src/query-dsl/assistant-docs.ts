import { AGGREGATE_KINDS } from "../aggregate-catalog";
import type { Base } from "../contracts";
import { GRID_FORMULA_FUNCTIONS } from "../formula/function-catalog";
import { formatIdentifierRef } from "../ref-syntax";
import type { Field } from "../service/types";
import {
  type DslDerivedViewColumn,
  type DslResolverContext,
  type DslTableSource,
  type DslViewSource,
  derivedViewColumns,
} from "./resolver";

type AssistantBase = Pick<Base, "name" | "shortId" | "description">;

type GqlAssistantContextInput = {
  base: AssistantBase;
  ctx: DslResolverContext;
  generatedAt?: string;
};

const mdEscape = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ").trim();
const code = (value: string): string => `\`${value.replaceAll("`", "\\`")}\``;
const ref = (value: string): string => formatIdentifierRef(value);
const sourceRef = (kind: "table" | "view", name: string): string => `from ${kind} ${ref(name)}`;

const formulaFunctionLines = (): string[] => GRID_FORMULA_FUNCTIONS.map((fn) => `- ${code(fn.signature)}: ${mdEscape(fn.description)}`);
const aggregateNames = (): string => AGGREGATE_KINDS.map(code).join(", ");

const visibleTablesById = (ctx: DslResolverContext): Map<string, DslTableSource> => new Map(ctx.tables.map((table) => [table.id, table]));

const aliveFields = (fields: Field[]): Field[] => fields.filter((field) => !field.deletedAt).sort((a, b) => a.position - b.position);

const optionLabels = (field: Field): string[] => {
  const options = (field.config as { options?: unknown }).options;
  if (!Array.isArray(options)) return [];
  return options
    .map((option) =>
      option && typeof option === "object"
        ? ((option as { label?: unknown; id?: unknown }).label ?? (option as { id?: unknown }).id)
        : null,
    )
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
};

const fieldById = (ctx: DslResolverContext): Map<string, Field> =>
  new Map(Object.values(ctx.fieldsByTableId).flatMap((fields) => fields.map((field) => [field.id, field] as const)));

const relationTargetName = (field: Field, tables: Map<string, DslTableSource>): string | null => {
  if (field.type !== "relation") return null;
  const targetTableId = (field.config as { targetTableId?: unknown }).targetTableId;
  return typeof targetTableId === "string" ? (tables.get(targetTableId)?.name ?? null) : null;
};

const lookupTarget = (field: Field, fields: Map<string, Field>, tables: Map<string, DslTableSource>): string | null => {
  if (field.type !== "lookup" && field.type !== "rollup") return null;
  const config = field.config as { relationFieldId?: unknown; targetFieldId?: unknown; agg?: unknown };
  const relation = typeof config.relationFieldId === "string" ? fields.get(config.relationFieldId) : undefined;
  const target = typeof config.targetFieldId === "string" ? fields.get(config.targetFieldId) : undefined;
  if (!relation || !target) return null;
  const relationTarget = relationTargetName(relation, tables);
  const targetLabel = relationTarget ? `${relationTarget}.${target.name}` : target.name;
  return field.type === "rollup" && typeof config.agg === "string" ? `${config.agg} ${targetLabel}` : targetLabel;
};

const fieldTypeSummary = (field: Field, ctx: DslResolverContext): string => {
  const tables = visibleTablesById(ctx);
  const fields = fieldById(ctx);
  const options = optionLabels(field);
  const relation = relationTargetName(field, tables);
  const lookup = lookupTarget(field, fields, tables);
  const parts = [field.type];
  if (relation) parts.push(`-> ${relation}`);
  if (lookup) parts.push(`-> ${lookup}`);
  if (options.length > 0) parts.push(`[${options.map(mdEscape).join(", ")}]`);
  if (field.required) parts.push("required");
  return parts.join(" ");
};

const renderFieldRows = (fields: Field[], ctx: DslResolverContext): string[] =>
  fields.map((field) => {
    const description = field.description?.trim();
    return `- ${code(ref(field.name))}: ${mdEscape(fieldTypeSummary(field, ctx))}${description ? ` - ${mdEscape(description)}` : ""}`;
  });

const viewIsDerived = (view: DslViewSource): boolean => (view.query.groupBy?.length ?? 0) > 0 || (view.query.aggregations?.length ?? 0) > 0;

const derivedTypeSummary = (column: DslDerivedViewColumn, tables: Map<string, DslTableSource>): string => {
  const parts = [column.kind === "aggregate" ? `aggregate ${column.agg ?? ""}`.trim() : column.type];
  if (column.kind === "group" && column.targetTableId) {
    const target = tables.get(column.targetTableId);
    if (target) parts.push(`-> ${target.name}`);
  }
  if (column.sqlType && column.sqlType !== "unknown") parts.push(`sql:${column.sqlType}`);
  return parts.join(" ");
};

const renderViewFieldRows = (view: DslViewSource, ctx: DslResolverContext): string[] => {
  const sourceFields = aliveFields(ctx.fieldsByTableId[view.tableId] ?? []);
  if (!viewIsDerived(view)) return renderFieldRows(sourceFields, ctx);
  const columns = derivedViewColumns(view.query, sourceFields);
  if ("message" in columns) return [`- View output could not be described: ${mdEscape(columns.message)}`];
  const tables = visibleTablesById(ctx);
  return columns.map((column) => `- ${code(ref(column.label))}: ${mdEscape(derivedTypeSummary(column, tables))}`);
};

const renderTableSection = (table: DslTableSource, ctx: DslResolverContext): string[] => {
  const fields = aliveFields(ctx.fieldsByTableId[table.id] ?? []);
  return [
    `### Table: ${mdEscape(table.name)}`,
    "",
    `Use as: ${code(sourceRef("table", table.name))}`,
    `Fields: ${fields.length}`,
    "",
    ...renderFieldRows(fields, ctx),
    "",
  ];
};

const renderViewSection = (view: DslViewSource, ctx: DslResolverContext): string[] => {
  const parent = ctx.tables.find((table) => table.id === view.tableId);
  return [
    `### View: ${mdEscape(view.name)}`,
    "",
    `Use as: ${code(sourceRef("view", view.name))}`,
    `Parent table: ${parent ? mdEscape(parent.name) : "not listed in this context"}`,
    `Shape: ${viewIsDerived(view) ? "derived/grouped output" : "row-shaped saved view"}`,
    "",
    "Output fields:",
    ...renderViewFieldRows(view, ctx),
    "",
    "Rule: a listed view is a valid source. Do not assume access to its parent table unless that table is listed above.",
    "",
  ];
};

const relationLines = (ctx: DslResolverContext): string[] => {
  const tables = visibleTablesById(ctx);
  const lines: string[] = [];
  for (const table of ctx.tables) {
    for (const field of aliveFields(ctx.fieldsByTableId[table.id] ?? [])) {
      const target = relationTargetName(field, tables);
      if (target) lines.push(`- ${mdEscape(table.name)}.${mdEscape(field.name)} -> ${mdEscape(target)}`);
    }
  }
  return lines;
};

export const renderGqlAssistantSkill = (): string =>
  [
    "# Grids GQL Assistant Skill",
    "",
    "## Purpose",
    "Help users write correct Grids Query Language (GQL) queries for the visible schema in `context.md`.",
    "",
    "## Grids Overview",
    "- A base is one workspace.",
    "- Tables contain records.",
    "- A Combined table is a read-only table that publishes explicitly mapped fields from stored tables. In GQL it is used exactly like any other visible table.",
    "- A Combined-table reader needs permission only on the visible target. Physical source access is not required or implied.",
    "- Fields describe record values.",
    "- Views are saved GQL queries. A view can be used as a source with `from view ...`.",
    "- Grids Apps, charts, stats, cards, calendars, exports, and workflows consume saved Grids data and views.",
    "",
    "## Hard Rules",
    "- Use only sources and fields listed in `context.md`.",
    "- Never invent table names, field names, view names, select options, or relations.",
    "- GQL is read-only. Do not generate create, update, delete, insert, or schema changes.",
    "- GQL is not SQL. Do not generate SQL syntax such as `select ... from ...`, arbitrary join predicates, subqueries, CTEs, window functions, or raw SQL expressions.",
    '- If a name contains spaces or punctuation, quote it with double quotes, for example `"Line total"`.',
    "- Use single quotes for literal text values, for example `Status = 'Open'`.",
    "- Prefer explicit `from table ...` or `from view ...` in generated queries.",
    "- Do not use legacy `#field` references in GQL.",
    "- Do not let output aliases collide with source field names, group names, or other aliases.",
    "- In the face of ambiguity, do not guess. Ask a short clarifying question or provide clearly labeled alternatives.",
    "",
    "## Clause Order",
    "Use this order for readability:",
    "",
    "```gql",
    "from table ...",
    "join table ... as alias on ... = ...",
    "select ...",
    "where ...",
    "search ...",
    "group by ...",
    "aggregate ...",
    "having ...",
    "sort ...",
    "limit ...",
    "offset ...",
    "include deleted | deleted only",
    "```",
    "",
    "## Syntax Reference",
    "- Sources: `from table Source`, `from view Source`, optionally `as alias` for self-joins or clearer scoped refs.",
    "- Joins: `join table Source as alias on Relation = alias.id`; use `left join ...` to keep source rows without a match.",
    "- Select: `select Field`, `select Field as alias`, or `select formula(expression) as alias`. Formula select items always need an alias.",
    "- Where: `where expression`; write calculated predicates directly, without `formula(...)`.",
    "- Search: `search 'text'` or `search 'text' in Field, alias.Field`.",
    "- Group: `group by Field`; date fields can use `group by Field by day|week|month|quarter|year`.",
    "- Aggregate: `aggregate fn(Field) as alias`, `aggregate fn(*) as alias`, or `aggregate fn(formula(expression)) as alias`.",
    "- Having: `having expression`; aggregate aliases are available here.",
    "- Sort: `sort Field asc|desc`, `sort alias desc`, optionally `nulls first` or `nulls last`.",
    "- Result bounds: `limit 1..10000` caps the complete logical result; `offset 0..10000` skips an initial window. Clients page larger results with opaque cursors, not by rewriting the GQL.",
    "- Trash: `include deleted` includes live and deleted rows; `deleted only` returns only deleted rows. Do not combine them.",
    "- Comments: `-- comment` is allowed when the marker is preceded by whitespace. Semicolons can separate clauses on one line.",
    "",
    "## Capabilities",
    "- Read visible tables with `from table ...` and visible saved views with `from view ...`.",
    "- Query a visible Combined table with the same `from table ...` syntax. Its canonical fields are the complete exposed schema; do not infer or request its physical source tables.",
    "- Use a saved view as a source even when its parent table is not listed in `context.md`; the listed view output is the accessible schema.",
    "- Join related tables through relation fields with `join table ...` or `left join table ...`.",
    "- Select raw fields, joined fields, saved-view output columns, and calculated outputs with `select formula(...) as alias`.",
    "- Filter rows with `where`, text predicates, membership predicates, comparisons, boolean operators, and formula expressions.",
    "- Search across readable searchable fields with `search 'text'`, or constrain search with `search 'text' in Field, alias.Field`.",
    "- Group by groupable fields, including date buckets with `by day|week|month|quarter|year`.",
    `- Aggregate with ${aggregateNames()}.`,
    "- Filter grouped output with `having`, sort fields or aliases with `sort`, and bound the complete result with `limit`.",
    "- Include trashed rows explicitly with `include deleted` or return only trashed rows with `deleted only`.",
    "- Use all supported formula functions listed below inside GQL expression positions.",
    "- GQL execution happens on the server in SQL; do not ask the browser or assistant to post-process records to get the requested result.",
    "",
    "## Limitations",
    "- Joins are relation/id joins, not arbitrary SQL joins. Use `join table Target as alias on RelationField = alias.id`.",
    "- Do not join text, number, date, select, or formula fields directly, for example never write `items.Name = alias.Name`.",
    "- If no relation field connects the records, ask the user to create or use a relation field before joining.",
    "- A join target must be visible through the permission-shaped context, unless the user is querying a listed view whose output already grants access.",
    "- Combined tables are read-only publication boundaries. Their source bases, source tables, source fields, and source permissions are not implied by the canonical schema in `context.md`.",
    "- When a Combined table is listed, query its canonical fields. Do not ask the reader to obtain source-base access.",
    "- Derived or grouped saved views expose only their listed output columns. Do not use their parent-table fields unless the parent table is also listed as a source.",
    "- `where` and `having` take expressions directly; do not wrap them in `formula(...)`.",
    "- `select formula(...)` output must have an alias. Use a safe alias that does not collide with source fields or other aliases.",
    "- GQL expressions use `and`, `or`, and `not` operators. Do not generate `AND(...)`, `OR(...)`, or `NOT(...)` calls.",
    "- GQL does not support legacy `#field` references; use field names, quoted names, scoped refs, or stable `{fieldId}` refs.",
    "- GQL does not support arbitrary JavaScript evaluation or assistant-side aggregation. If a result cannot be expressed in GQL, say so.",
    "- `limit` is capped at 10000 and applies across all cursor pages. `offset` is capped at 10000. Add a deterministic `sort` when result order has business meaning.",
    "- `include deleted` and `deleted only` are mutually exclusive.",
    "- `context.md` contains schema only, not record values. Do not invent literal filter values unless the user supplied them or they are listed select options.",
    "",
    "## Common Patterns",
    "```gql",
    "from table Books",
    "select Title, Author, Price",
    "where Status = 'Available'",
    "sort Title asc",
    "limit 50",
    "```",
    "",
    "```gql",
    "from table Orders",
    "group by Status",
    "aggregate count(*) as orders, sum(Total) as revenue",
    "sort revenue desc",
    "```",
    "",
    "```gql",
    "from table Books",
    "join table Authors as author on Author = author.id",
    "select Title, author.Name as author_name",
    "where author.Country = 'United Kingdom'",
    "```",
    "",
    "## Operators And Helpers",
    "- Comparisons: `=`, `!=`, `>`, `>=`, `<`, `<=`.",
    "- Boolean logic: `and`, `or`, `not`, parentheses.",
    "- Membership: `oneof(Field, 'a', 'b')`, `noneof(Field, 'a', 'b')`.",
    "- Multi-value containment: `containsall(Field, 'a', 'b')`.",
    "- Text helpers: `contains`, `startswith`, `endswith`, `icontains`, `istartswith`, `iendswith`.",
    `- Aggregates: ${aggregateNames()}.`,
    "- Dates can be grouped by `day`, `week`, `month`, `quarter`, or `year`.",
    "- Sort defaults to ascending with nulls last; use `desc`, `nulls first`, or `nulls last` when needed.",
    "",
    "## Formula Expressions",
    "",
    "- Base row queries can select documentCount() as documents or latestDocumentAt('sepa-xml') as exportedAt, and filter with where documentCount('sepa-xml') = 0. These return a number and a nullable datetime. Formats: pdf, csv, json, xml, sepa-xml, datev-csv. Generic csv/xml exclude financial profiles; pdf includes e-invoice PDFs. They count unique issued Documents explicitly associated with the source record, not relation targets, payments, or failed runs. Metadata remains live after finalization. Not available in stored Formula fields, aggregates, having clauses, or Custom App queries.",
    "- `where`, `having`, `select formula(...) as alias`, and `aggregate fn(formula(...)) as alias` use the formula expression engine.",
    "- Use field names directly, quoted field names for spaces, scoped refs after joins such as `author.Name`, and stable refs like `{fieldId}`.",
    "- In GQL expressions, use `and`, `or`, and `not` operators instead of `AND(...)`, `OR(...)`, or `NOT(...)` calls.",
    "- Supported formula functions:",
    ...formulaFunctionLines(),
    "",
    "## Output Style",
    "- Return one best query first in a `gql` code block.",
    "- Then add a short explanation and any assumptions.",
    "- Keep queries readable: one clause per line for non-trivial queries.",
    "- Prefer clear aliases such as `total_quantity`, `revenue`, or `orders_count`.",
    "",
  ].join("\n");

export const renderGqlAssistantContext = (input: GqlAssistantContextInput): string => {
  const views = [...(input.ctx.views ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const tables = [...input.ctx.tables].sort((a, b) => a.name.localeCompare(b.name));
  const relations = relationLines(input.ctx);
  return [
    "# Grids Schema Context",
    "",
    `Base: ${input.base.name}`,
    `Base short id: ${input.base.shortId}`,
    ...(input.base.description ? [`Description: ${input.base.description}`] : []),
    ...(input.generatedAt ? [`Generated at: ${input.generatedAt}`] : []),
    "",
    "Data policy: schema only. This file contains no record values. Sources and fields are already filtered to what the current user may see.",
    "",
    "## Available Tables",
    "",
    ...(tables.length > 0
      ? tables.flatMap((table) => renderTableSection(table, input.ctx))
      : ["No tables are visible in this context.", ""]),
    "## Available Views",
    "",
    ...(views.length > 0 ? views.flatMap((view) => renderViewSection(view, input.ctx)) : ["No views are visible in this context.", ""]),
    "## Visible Relations",
    "",
    ...(relations.length > 0 ? relations : ["No visible relation targets are available."]),
    "",
    "## Assistant Instructions",
    "- Use `SKILL.md` for the GQL rules.",
    "- Use only the sources and fields in this file.",
    "- Prefer source names over IDs.",
    "- Ask when the user's request cannot be answered with the visible schema.",
    "",
  ].join("\n");
};
