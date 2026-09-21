import { describe, expect, test } from "bun:test";
import { GRID_FORMULA_FUNCTIONS } from "../formula/function-catalog";
import { hydrateDslViewQueries } from "../service/gql-resolver-context";
import type { Field } from "../service/types";
import { renderGqlAssistantContext, renderGqlAssistantSkill } from "./assistant-docs";
import { parseGridsQueryDsl } from "./parser";
import type { DslResolverContext } from "./resolver";

const table = { kind: "table" as const, id: "11111111-1111-4111-8111-111111111111", shortId: "ITEMS", name: "Items" };
const hiddenTableId = "22222222-2222-4222-8222-222222222222";

const field = (overrides: Partial<Field> & Pick<Field, "id" | "shortId" | "name" | "type">): Field => ({
  id: overrides.id,
  shortId: overrides.shortId,
  tableId: overrides.tableId ?? table.id,
  name: overrides.name,
  description: overrides.description ?? null,
  icon: overrides.icon ?? null,
  type: overrides.type,
  config: overrides.config ?? {},
  position: overrides.position ?? 0,
  required: overrides.required ?? false,
  presentable: overrides.presentable ?? false,
  hideInTable: overrides.hideInTable ?? false,
  defaultValue: overrides.defaultValue ?? null,
  indexed: overrides.indexed ?? false,
  uniqueConstraint: overrides.uniqueConstraint ?? false,
  deletedAt: overrides.deletedAt ?? null,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
});

const quantity = field({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  shortId: "QTY01",
  name: "Quantity",
  type: "number",
  description: "Available unit count.",
  position: 1,
});

const status = field({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  shortId: "STAT1",
  name: "Status",
  type: "select",
  position: 2,
  config: {
    options: [
      { id: "available", label: "Available" },
      { id: "loaned", label: "Loaned" },
    ],
  },
});

const hiddenRelation = field({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  shortId: "CAT01",
  name: "Category",
  type: "relation",
  position: 3,
  config: { targetTableId: hiddenTableId, cardinality: "single" },
});

const ctx = (): DslResolverContext => ({
  currentTable: table,
  tables: [table],
  views: [
    {
      kind: "view",
      id: "33333333-3333-4333-8333-333333333333",
      shortId: "STOCK",
      tableId: table.id,
      name: "Stock by status",
      source: "from table Items\ngroup by Status\naggregate sum(Quantity) as units",
      query: {
        groupBy: [{ fieldId: status.id, label: "Status" }],
        aggregations: [{ fieldId: quantity.id, agg: "sum", label: "units" }],
      },
    },
  ],
  fieldsByTableId: {
    [table.id]: [quantity, status, hiddenRelation],
  },
});

const gqlCodeBlocks = (markdown: string): string[] => {
  const blocks: string[] = [];
  const pattern = /```gql\n([\s\S]*?)\n```/g;
  for (const match of markdown.matchAll(pattern)) blocks.push(match[1]?.trim() ?? "");
  return blocks;
};

describe("GQL assistant docs", () => {
  test("skill explains independent totals and their access and null semantics", () => {
    const skill = renderGqlAssistantSkill();
    expect(skill).toContain("left join view PaymentTotals as payments on payments.Invoice = bill.id");
    expect(skill).toContain("missing groups return null");
    expect(skill).toContain("denied access is an error, never a zero balance");
    expect(skill).toContain("equal amounts can belong to different records");
  });

  test("context includes formula aggregates without promising unsupported from-view use", () => {
    const context = ctx();
    const target = { kind: "table" as const, id: hiddenTableId, shortId: "Parent", name: "Parents" };
    context.tables.push(target);
    context.fieldsByTableId[table.id]!.push(
      field({
        id: "33333333-3333-4333-8333-333333333333",
        shortId: "Link01",
        name: "Parent",
        type: "relation",
        config: { targetTableId: target.id },
      }),
    );
    context.views = hydrateDslViewQueries({
      ...context,
      views: [
        {
          kind: "view",
          id: "44444444-4444-4444-8444-444444444444",
          shortId: "Totals",
          name: "Totals",
          tableId: table.id,
          source: "from table Items\ngroup by Parent\naggregate sum(formula(Quantity * 2)) as doubled",
          query: {},
        },
      ],
    });
    expect(context.views).toHaveLength(1);
    const markdown = renderGqlAssistantContext({ base: { name: "Inventory", shortId: "INV01", description: null }, ctx: context });
    expect(markdown).toContain("`doubled`: aggregate sum sql:numeric");
    expect(markdown).toContain("Use with left join view `Totals`");
    expect(markdown).not.toContain("Use as: `from view Totals`");
  });

  test("skill explains the assistant contract and GQL guardrails", () => {
    const skill = renderGqlAssistantSkill();

    expect(skill).toContain("# Grids GQL Assistant Skill");
    expect(skill).toContain("Use only sources and fields listed in `context.md`.");
    expect(skill).toContain("```gql");
    expect(skill).toContain("from table ...");
    expect(skill).toContain(["from table ...", "join table ... as alias on ... = ...", "select ..."].join("\n"));
    expect(skill).toContain("from view Source");
    expect(skill).toContain("left join ...");
    expect(skill).toContain("select formula(expression) as alias");
    expect(skill).toContain("aggregate fn(formula(expression)) as alias");
    expect(skill).toContain("include deleted` includes live and deleted rows");
    expect(skill).toContain("`deleted only` returns only deleted rows");
  });

  test("skill documents GQL capabilities and intentional limits", () => {
    const skill = renderGqlAssistantSkill();

    expect(skill).toContain("## Capabilities");
    expect(skill).toContain("Read visible tables with `from table ...` and visible saved views with `from view ...`.");
    expect(skill).toContain("Query a visible Combined table with the same `from table ...` syntax.");
    expect(skill).toContain("do not infer or request its physical source tables");
    expect(skill).toContain("Physical source access is not required or implied.");
    expect(skill).toContain("Use a saved view as a source even when its parent table is not listed in `context.md`");
    expect(skill).toContain("Join related tables through relation fields");
    expect(skill).toContain("GQL execution happens on the server in SQL");

    expect(skill).toContain("## Limitations");
    expect(skill).toContain("GQL is not SQL");
    expect(skill).toContain("Joins are relation/id joins, not arbitrary SQL joins.");
    expect(skill).toContain("never write `items.Name = alias.Name`");
    expect(skill).toContain("If no relation field connects the records, ask the user to create or use a relation field before joining.");
    expect(skill).toContain("Do not ask the reader to obtain source-base access.");
    expect(skill).toContain("Derived or grouped saved views expose only their listed output columns.");
    expect(skill).toContain("do not wrap them in `formula(...)`");
    expect(skill).toContain("Do not generate `AND(...)`, `OR(...)`, or `NOT(...)` calls.");
    expect(skill).toContain("GQL does not support arbitrary JavaScript evaluation or assistant-side aggregation.");
    expect(skill).toContain("`include deleted` and `deleted only` are mutually exclusive.");
  });

  test("skill covers every formula function supported by the formula engine", () => {
    const skill = renderGqlAssistantSkill();
    // Engine/catalog parity belongs to formula/function-catalog.test.ts;
    // list reducers are evaluated separately from the scalar FN_LIBRARY.
    for (const fn of GRID_FORMULA_FUNCTIONS) {
      expect(skill).toContain(`\`${fn.signature}\``);
    }
    expect(skill).toContain("`STARTSWITH(text, prefix)`");
    expect(skill).toContain("`IENDSWITH(text, suffix)`");
    expect(skill).toContain("use `and`, `or`, and `not` operators");
  });

  test("skill executable GQL examples parse with the public parser", () => {
    const examples = gqlCodeBlocks(renderGqlAssistantSkill()).filter((block) => !block.includes("..."));

    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const result = parseGridsQueryDsl(example);
      expect(result.ok, example).toBe(true);
    }
  });

  test("context renders only the permission-shaped resolver context", () => {
    const markdown = renderGqlAssistantContext({
      base: { name: "Inventory", shortId: "INV01", description: "Equipment tracking." },
      ctx: ctx(),
      generatedAt: "2026-06-24T10:00:00.000Z",
    });

    expect(markdown).toContain("# Grids Schema Context");
    expect(markdown).toContain("Base: Inventory");
    expect(markdown).toContain("Use as: `from table Items`");
    expect(markdown).toContain("`Quantity`: number - Available unit count.");
    expect(markdown).toContain("`Status`: select [Available, Loaned]");
    expect(markdown).toContain("`Category`: relation");
    expect(markdown).not.toContain(hiddenTableId);
    expect(markdown).not.toContain("Hidden");
    expect(markdown).not.toContain("-> Categories");
  });

  test("context describes derived saved-view output columns", () => {
    const markdown = renderGqlAssistantContext({
      base: { name: "Inventory", shortId: "INV01", description: null },
      ctx: ctx(),
    });

    expect(markdown).toContain('Use as: `from view "Stock by status"`');
    expect(markdown).toContain("Shape: derived/grouped output");
    expect(markdown).toContain("`Status`: select sql:text");
    expect(markdown).toContain("`units`: aggregate sum sql:numeric");
  });
});
