import { describe, expect, test } from "bun:test";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import { ctx, orders, parseOk } from "../query-dsl/resolver-fixtures";
import { buildTrustedGqlResolverContext, hydrateDslViewQueries } from "./gql-resolver-context";

const baseId = "11111111-1111-4111-8111-111111111111";
const ordersTableId = "22222222-2222-4222-8222-222222222222";
const hiddenTableId = "33333333-3333-4333-8333-333333333333";
const hiddenFieldId = "44444444-4444-4444-8444-444444444444";

const table = (id: string, shortId: string, name: string) => ({
  id,
  shortId,
  baseId,
  kind: "stored" as const,
  name,
  description: null,
  icon: null,
  columns: [],
  displayConfig: { mode: "table" as const },
  auditPolicy: {},
  mutationPolicy: { mode: "all" as const },
  position: 0,
  disableDirectInsert: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const field = (tableId: string, id: string, shortId: string, name: string) => ({
  id,
  shortId,
  tableId,
  name,
  description: null,
  icon: null,
  type: "text",
  config: {},
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("buildTrustedGqlResolverContext", () => {
  test.each([
    "where amount > cost",
    "where not amount > 0",
    "join table Custs as customer on customer_link = customer.id\nwhere customer.name = 'Alice'",
    "offset 1",
    "aggregate sum(amount) as total",
  ])("cannot broaden a saved View whose source cannot be nested: %s", (clause) => {
    const context = ctx();
    const source = `from table Orders\n${clause}`;
    expect(resolveDslQueryToQueryPlan(parseOk(source), context).ok).toBe(true);
    const views = hydrateDslViewQueries({
      ...context,
      views: [
        {
          kind: "view",
          id: "33333333-3333-4333-8333-333333333333",
          shortId: "Profit",
          name: "Profit",
          tableId: orders.id,
          source,
          query: {},
        },
      ],
    });
    const referenced = resolveDslQueryToQueryPlan(parseOk("from view Profit\nselect amount"), { ...context, views });
    expect(referenced.ok).toBe(false);
    if (!referenced.ok) expect(referenced.diagnostics[0]?.message).toContain('source "Profit" is not available');
  });

  test("preserves the complete filter of a supported saved View", () => {
    const context = ctx();
    const views = hydrateDslViewQueries({
      ...context,
      views: [
        {
          kind: "view",
          id: "33333333-3333-4333-8333-333333333333",
          shortId: "Profit",
          name: "Profit",
          tableId: orders.id,
          source: "from table Orders\nwhere amount > 0",
          query: {},
        },
      ],
    });
    const referenced = resolveDslQueryToQueryPlan(parseOk("from view Profit\nselect amount"), { ...context, views });
    expect(referenced.ok).toBe(true);
    if (referenced.ok) expect(referenced.plan.query.filter).toEqual(views[0]?.query.filter);
    expect(views[0]?.query.filter).toBeDefined();
  });

  test("exposes all base tables for service-level document and Grids App renderers", async () => {
    const parsed = parseGridsQueryDsl("from table Hidden\nselect Secret");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const ctx = await buildTrustedGqlResolverContext(
      {
        baseId,
        ast: parsed.ast,
        purpose: "document-template-render",
      },
      {
        listTablesByBase: async (requestedBaseId: string) =>
          requestedBaseId === baseId ? [table(ordersTableId, "Orders", "Orders"), table(hiddenTableId, "Hidden", "Hidden")] : [],
        listFieldsByTables: async (tableIds: readonly string[]) =>
          new Map(
            tableIds.map((tableId) => [
              tableId,
              tableId === hiddenTableId ? [field(hiddenTableId, hiddenFieldId, "Secret", "Secret")] : [],
            ]),
          ),
        listViewsByBase: async () => [],
      },
    );
    const resolved = resolveDslQueryToQueryPlan(parsed.ast, ctx);

    expect(ctx.tables.map((source) => source.name)).toEqual(["Orders", "Hidden"]);
    expect(ctx.fieldsByTableId[hiddenTableId]?.map((item) => item.name)).toEqual(["Secret"]);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.plan.tableId).toBe(hiddenTableId);
  });
});
