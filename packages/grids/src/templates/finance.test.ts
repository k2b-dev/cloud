import { describe, expect, test } from "bun:test";
import { CustomAppDefinitionSchema } from "../custom-apps/contracts";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import { hydrateDslViewQueries } from "../service/gql-resolver-context";
import type { Field } from "../service/types";
import { createFinanceTemplate } from "./finance";
import { field, type GridTemplate } from "./types";

const blocks = (template: GridTemplate) =>
  template.customApps!.flatMap((app) =>
    app.definition.pages.flatMap((page) => page.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks))),
  );
const refKey = (value: unknown) => (value && typeof value === "object" && "key" in value ? value.key : undefined);

// Resolve resources to valid public IDs while leaving GQL as opaque text for schema validation.
const resolve = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === "object") {
    if ("$formula" in value) return "from table Test01";
    if ("$ref" in value) {
      const key = String("key" in value ? value.key : value.$ref);
      let hash = 0;
      for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      const id = hash.toString(36).padStart(6, "0").slice(-6);
      return value.$ref === "viewColumns" ? [id] : id;
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry)]));
  }
  return value;
};

describe("personal finance task paths", () => {
  for (const locale of ["en", "de"]) {
    test(`${locale}: one coherent app exposes spending, reconciliation, budgets and setup`, () => {
      const template = createFinanceTemplate(locale);
      expect(template.customApps).toHaveLength(1);
      CustomAppDefinitionSchema.parse(resolve({ ...template.customApps![0]!.definition, id: "App001", baseId: "Base01" }));
      expect(template.customApps![0]!.definition.pages.filter((page) => page.navigation.visible).map((page) => page.id)).toEqual([
        "overview",
        "transactions",
        "budgets",
        "setup",
      ]);
      const appBlocks = blocks(template);
      for (const block of appBlocks) {
        if ("formId" in block) expect(block.presentation?.kind).toBe("dialog");
      }
      expect(appBlocks.some((block) => "formId" in block && block.mode === "edit" && refKey(block.formId) === "edit_transaction")).toBe(
        true,
      );
      for (const id of ["w-income", "w-spend", "w-budget"]) {
        const block = appBlocks.find((block) => block.id === id);
        expect(JSON.stringify(block)).toContain("YEAR(TODAY())");
        expect(JSON.stringify(block)).toContain("MONTH(TODAY())");
      }
      expect(JSON.stringify(appBlocks.find((block) => block.id === "current-budgets"))).toContain("current_spending");
    });
  }

  test("entry does not demand email or falsely claim bank reconciliation", () => {
    const template = createFinanceTemplate();
    const transaction = template.tables.find((table) => table.key === "transactions")!;
    expect(transaction.fields.find((entry) => entry.key === "receipt_email")?.required).not.toBe(true);
    expect(transaction.fields.find((entry) => entry.key === "receipt_email")?.defaultValue).toBeUndefined();
    for (const key of ["log_expense", "log_income"]) {
      const inputs = template.forms!.find((form) => form.key === key)!.config.fields as Array<{
        kind: string;
        fieldId: unknown;
        value?: unknown;
        required?: boolean;
      }>;
      expect(inputs.find((input) => refKey(input.fieldId) === "transactions.cleared")).toEqual({
        kind: "form_value",
        fieldId: field("transactions.cleared"),
        value: false,
      });
      expect(inputs.find((input) => refKey(input.fieldId) === "transactions.receipt_email")?.required).not.toBe(true);
    }
    const workflow = template.workflows!.find((workflow) => workflow.key === "send_receipt")!.source;
    expect(workflow).not.toContain("Reconciled:");
    expect(workflow).toContain("exists: inputs.transaction.Receipt email");
    expect(workflow).toContain("Receipt delivery: [processing]");
    expect(workflow).toContain("Receipt delivery: [sent]");
  });

  test("budget actuals exclude income and transfers and constrain their calendar month", () => {
    const template = createFinanceTemplate();
    const source = JSON.stringify(template.views!.find((view) => view.key === "current_spending")!.source);
    expect(source).toContain("'expense'");
    expect(source).toContain("YEAR(TODAY())");
    expect(source).toContain("MONTH(TODAY())");
    expect(source).not.toContain("transactions.cleared");
  });
});

test("budget spending view remains available as a joined summary source", () => {
  const template = createFinanceTemplate();
  const tableId = "11111111-1111-4111-8111-111111111111";
  const categoryTableId = "22222222-2222-4222-8222-222222222222";
  const transactionTable = { kind: "table" as const, id: tableId, shortId: "TXNS01", name: "Transactions" };
  const definition = template.tables.find((entry) => entry.key === "transactions")!;
  const fields: Field[] = definition.fields
    .filter((entry) => ["date", "category", "type", "amount"].includes(entry.key))
    .map((entry, index) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`,
      shortId: `FIELD${index}`,
      tableId,
      name: entry.name,
      type: entry.type,
      description: null,
      icon: null,
      config: entry.key === "category" ? { targetTableId: categoryTableId, cardinality: "single" } : (entry.config ?? {}),
      position: index,
      required: false,
      presentable: false,
      hideInTable: false,
      defaultValue: null,
      indexed: false,
      uniqueConstraint: false,
      deletedAt: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    }));
  const sourceValue = template.views!.find((entry) => entry.key === "current_spending")!.source;
  if (!sourceValue || typeof sourceValue !== "object" || !("$formula" in sourceValue) || !Array.isArray(sourceValue.$formula))
    throw new Error("expected template formula");
  const source = sourceValue.$formula
    .map((part: unknown) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object" || !("$ref" in part) || !("key" in part)) throw new Error("expected template reference");
      if (part.$ref === "table") return "Transactions";
      const fieldDefinition = definition.fields.find((entry) => `transactions.${entry.key}` === part.key);
      if (!fieldDefinition) throw new Error("unknown transaction field");
      return fieldDefinition.name;
    })
    .join("");
  const hydrated = hydrateDslViewQueries({
    tables: [transactionTable, { kind: "table", id: categoryTableId, shortId: "CAT001", name: "Categories" }],
    fieldsByTableId: { [tableId]: fields, [categoryTableId]: [] },
    views: [{ kind: "view", id: "33333333-3333-4333-8333-333333333333", shortId: "VIEW01", name: "Spending", tableId, source, query: {} }],
  });
  expect(hydrated).toHaveLength(1);
  expect(hydrated[0]!.summaryFormulaAggregations).toHaveLength(1);
  expect(hydrated[0]!.query.groupBy).toHaveLength(1);
});

for (const locale of ["en", "de"]) {
  test(`${locale}: budget comparison uses valid, nonreserved aliases`, () => {
    const template = createFinanceTemplate(locale);
    const block = blocks(template).find((entry) => entry.id === "current-budgets");
    if (!block || !("source" in block) || !("query" in block.source)) throw new Error("expected query block");
    const value: unknown = block.source.query;
    if (!value || typeof value !== "object" || !("$formula" in value) || !Array.isArray(value.$formula))
      throw new Error("expected formula");
    const query = value.$formula.map((part: unknown) => (typeof part === "string" ? part : "Value01")).join("");
    const parsed = parseGridsQueryDsl(query);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(query).toContain("as Budget");
    expect(query).not.toContain("as Limit");
  });
}

for (const locale of ["en", "de"]) {
  test(`${locale}: budget comparison resolves independent category summaries`, () => {
    const template = createFinanceTemplate(locale);
    const refs = new Map<string, string>();
    const tables = template.tables.map((table, index) => {
      const shortId = `Table${index}`;
      refs.set(`table:${table.key}`, shortId);
      return { kind: "table" as const, id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, shortId, name: table.name };
    });
    const fieldsByTableId: Record<string, Field[]> = {};
    for (const [index, definition] of template.tables.entries()) {
      const table = tables[index]!;
      fieldsByTableId[table.id] = definition.fields
        .filter((field) => field.type !== "lookup")
        .map((field, position) => {
          const shortId = `F${index}${String(position).padStart(4, "0")}`;
          refs.set(`field:${definition.key}.${field.key}`, shortId);
          const target = field.config?.targetTableId;
          const targetKey = target && typeof target === "object" && "key" in target ? target.key : undefined;
          const targetIndex = template.tables.findIndex((entry) => entry.key === targetKey);
          return {
            id: `22222222-2222-4222-8222-${String(index * 100 + position).padStart(12, "0")}`,
            shortId,
            tableId: table.id,
            name: field.name,
            type: field.type,
            config: field.type === "relation" ? { targetTableId: tables[targetIndex]!.id, cardinality: "single" } : (field.config ?? {}),
            description: null,
            icon: null,
            position,
            required: false,
            presentable: false,
            hideInTable: false,
            defaultValue: null,
            indexed: false,
            uniqueConstraint: false,
            deletedAt: null,
            createdAt: "2026-09-01T00:00:00Z",
            updatedAt: "2026-09-01T00:00:00Z",
          };
        });
    }
    const render = (value: unknown): string => {
      if (!value || typeof value !== "object" || !("$formula" in value) || !Array.isArray(value.$formula))
        throw new Error("expected formula");
      return value.$formula
        .map((part: unknown) => {
          if (typeof part === "string") return part;
          if (!part || typeof part !== "object" || !("$ref" in part) || !("key" in part)) throw new Error("expected reference");
          const resolved = refs.get(`${part.$ref}:${part.key}`);
          if (!resolved) throw new Error("unknown reference");
          return resolved;
        })
        .join("");
    };
    const definitions = template.views!.filter((view) => ["current_spending", "current_budget_limits"].includes(view.key));
    const views = definitions.map((definition, index) => {
      const shortId = `View0${index}`;
      refs.set(`view:${definition.key}`, shortId);
      return {
        kind: "view" as const,
        id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
        shortId,
        name: definition.name,
        tableId: tables[template.tables.findIndex((table) => table.key === definition.table)]!.id,
        source: render(definition.source),
        query: {},
      };
    });
    const hydrated = hydrateDslViewQueries({ tables, views, fieldsByTableId });
    expect(hydrated).toHaveLength(2);
    const block = blocks(template).find((entry) => entry.id === "current-budgets");
    if (!block || !("source" in block) || !("query" in block.source)) throw new Error("expected comparison query");
    const parsed = parseGridsQueryDsl(render(block.source.query));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    const result = resolveDslQueryToQueryPlan(parsed.ast, { tables, views: hydrated, fieldsByTableId });
    expect(result.ok, JSON.stringify(result.ok ? null : result.diagnostics)).toBe(true);
  });
}
