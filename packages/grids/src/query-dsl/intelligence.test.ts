import { describe, expect, test } from "bun:test";
import type { Field } from "../service/types";
import { hydrateDslViewQueries } from "../service/gql-resolver-context";
import { buildDslQueryIntelligence } from "./intelligence";
import { parseGridsQueryDsl } from "./parser";
import { resolveDslQueryToQueryPlan } from "./resolver";
import type { DslResolverContext, DslTableSource, DslViewSource } from "./resolver";

const table = (id: string, shortId: string, name: string): DslTableSource => ({
  kind: "table",
  id,
  shortId,
  name,
});

const field = (tableId: string, id: string, shortId: string, name: string, type: string, config: Record<string, unknown> = {}): Field => ({
  id,
  shortId,
  tableId,
  name,
  description: null,
  icon: null,
  type,
  config,
  position: Number(shortId.replace(/\D/g, "")) || 0,
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

const orders = table("orders", "ORD01", "Orders");
const customers = table("customers", "CUS01", "Customers");
const accounts = table("accounts", "ACC01", "Accounts");
const transactions = table("transactions", "TRN01", "Transactions");

const amount = field(orders.id, "amount", "AMT01", "Amount", "number");
const orderedAt = field(orders.id, "ordered_at", "DAT01", "Ordered at", "date");
const stage = field(orders.id, "stage", "STG01", "Stage", "select", {
  options: [
    { id: "open", label: "Open" },
    { id: "closed", label: "Closed" },
  ],
});
const customerLink = field(orders.id, "customer", "CST01", "Customer", "relation", { targetTableId: customers.id });
const customerName = field(customers.id, "name", "NAM01", "Name", "text");
const accountName = field(accounts.id, "account_name", "ACN01", "Name", "text");
const transactionAmount = field(transactions.id, "transaction_amount", "TAM01", "Amount", "number");

const revenueView: DslViewSource = {
  kind: "view",
  id: "revenue-view",
  shortId: "REV01",
  tableId: orders.id,
  name: "Revenue by customer",
  query: {
    groupBy: [{ fieldId: customerLink.id }],
    aggregations: [{ fieldId: amount.id, agg: "sum", label: "revenue" }],
  },
};

const ctx = (overrides: Partial<DslResolverContext> = {}): DslResolverContext => ({
  currentTable: orders,
  tables: [orders, customers, accounts, transactions],
  views: [revenueView],
  fieldsByTableId: {
    [orders.id]: [amount, orderedAt, stage, customerLink],
    [customers.id]: [customerName],
    [accounts.id]: [accountName],
    [transactions.id]: [transactionAmount],
  },
  ...overrides,
});

const labels = (query: string, context = ctx()) =>
  buildDslQueryIntelligence({ query, caret: query.length, ctx: context }).map((item) => item.label);

test("summary joins suggest view sources and only their derived columns", () => {
  const prefix = 'from table Customers as parent\nleft join view "Revenue by customer" as paid on paid.Customer = parent.id\n';
  expect(labels("from table Customers\nleft join ")).toContain("view");
  expect(labels("from table Customers\njoin ")).not.toContain("view");
  expect(labels("from table Customers\nleft join view ")).toContain(revenueView.name);
  for (const clause of ["select paid.", "sort paid.", "where paid.", "select formula(paid."]) {
    const suggestions = labels(prefix + clause);
    expect(suggestions).toContain("revenue");
    expect(suggestions).not.toContain("Amount");
    expect(suggestions).not.toContain("Stage");
  }
  expect(labels('from table Customers as parent\nleft join view "Revenue by customer" as paid on paid.')).toEqual(["Customer"]);
  expect(item(prefix + "select ", "revenue")?.insertText).toBe("paid.revenue");
});

test("summary completions include hydrated formula aggregates but omit inaccessible source fields", () => {
  // Hydration validates persisted RecordQuery IDs, unlike token-only fixtures.
  const source = table("00000000-0000-4000-8000-000000000001", "Orders", "Orders");
  const target = table("00000000-0000-4000-8000-000000000002", "Custmr", "Customers");
  const context = ctx({ tables: [source, target], fieldsByTableId: {
    [source.id]: [field(source.id, "00000000-0000-4000-8000-000000000003", "Amount", "Amount", "number"),
      field(source.id, "00000000-0000-4000-8000-000000000004", "Link01", "Customer", "relation", { targetTableId: target.id })],
    [target.id]: [],
  } });
  const querySource = "from table Orders\ngroup by Customer\naggregate sum(formula(Amount * 2)) as doubled";
  const parsed = parseGridsQueryDsl(querySource);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed));
  const resolved = resolveDslQueryToQueryPlan(parsed.ast, context);
  if (!resolved.ok) throw new Error(JSON.stringify(resolved));
  context.views = hydrateDslViewQueries({ ...context, views: [{ ...revenueView,
    tableId: source.id, source: querySource, query: {} }] });
  expect(context.views).toHaveLength(1);
  const query = 'from table Customers as parent\nleft join view "Revenue by customer" as paid on paid.Customer = parent.id\nselect paid.';
  expect(labels(query, context)).toContain("doubled");
  expect(labels(query, { ...context, tables: [target] })).not.toContain("doubled");
  expect(labels(query, { ...context, views: [] })).toEqual([]);
});

const labelsForCurrentSource = (query: string, currentSource: { kind: "table"; tableId: string } | { kind: "view"; viewId: string }) =>
  buildDslQueryIntelligence({ query, caret: query.length, ctx: ctx(), currentSource }).map((item) => item.label);

const item = (query: string, label: string, context = ctx()) =>
  buildDslQueryIntelligence({ query, caret: query.length, ctx: context }).find((candidate) => candidate.label === label);

const contextItems = (query: string) =>
  buildDslQueryIntelligence({
    query,
    caret: query.length,
    ctx: ctx(),
    contextKeys: ["auth.id", "params.record_id", "page.id", "time.today"],
  });

describe("GQL query intelligence", () => {
  test("suggests only explicitly available context references", () => {
    expect(labels("where @")).not.toContain("@auth.id");

    const auth = contextItems("where @au").find((candidate) => candidate.label === "@auth.id");
    expect(auth?.textEdit).toEqual({ start: "where ".length, end: "where @au".length, text: "@auth.id" });

    const param = contextItems("where Amount = @params.").find((candidate) => candidate.label === "@params.record_id");
    expect(param?.textEdit).toEqual({
      start: "where Amount = ".length,
      end: "where Amount = @params.".length,
      text: "@params.record_id",
    });
    expect(contextItems("where @params.").map((candidate) => candidate.label)).not.toContain("@params.other");
  });

  test("suggests only typed sources after from and never offers untyped source refs", () => {
    expect(labels("from ")).toEqual(expect.arrayContaining(["table", "view"]));
    expect(labels("from Or")).not.toContain("Orders");
    expect(labels("from table ")).toEqual(expect.arrayContaining(["Orders", "Customers"]));
    expect(labels("from view ")).toContain("Revenue by customer");
  });

  test("stops suggesting sources once a from source is complete", () => {
    const suggestions = labels("from table Orders w");

    expect(suggestions).toContain("where");
    expect(suggestions).not.toContain("Orders");
    expect(suggestions).not.toContain("Customers");
    expect(item("from table Orders w", "where")?.textEdit).toMatchObject({
      start: "from table Orders ".length,
      end: "from table Orders w".length,
      text: "\nwhere ",
    });
  });

  test("treats same-line clause typing after a source as canonical newline insertion", () => {
    const query = "from table Orders where ";
    const amountSuggestion = item(query, "Amount");
    const suggestions = labels(query);

    expect(suggestions[0]).toBe("Amount");
    expect(suggestions).toContain("Stage");
    expect(suggestions).not.toContain("Orders");
    expect(amountSuggestion?.textEdit).toMatchObject({
      start: "from table Orders ".length,
      end: query.length,
      text: "\nwhere Amount",
    });
  });

  test("suggests source aliases before leaving the from clause", () => {
    const aliasQuery = "from table Orders as ";
    const nextClauseQuery = "from table Orders as orders w";

    expect(labels("from table Orders")).toContain("as");
    expect(labels("from table Orders")).not.toContain("Customers");
    expect(item("from table Orders a", "as")?.textEdit).toMatchObject({
      start: "from table Orders ".length,
      end: "from table Orders a".length,
      text: "as ",
    });
    expect(item(aliasQuery, "orders")?.textEdit).toMatchObject({
      start: aliasQuery.length,
      end: aliasQuery.length,
      text: "orders",
    });
    expect(labels(aliasQuery)).not.toContain("where");
    expect(item(nextClauseQuery, "where")?.textEdit).toMatchObject({
      start: "from table Orders as orders ".length,
      end: nextClauseQuery.length,
      text: "\nwhere ",
    });
    expect(labels("from table Orders as 1")).toEqual([]);
  });

  test("suggests predicate operators after a completed operand", () => {
    const suggestions = labels("from table Orders\nwhere Amount ");

    expect(suggestions).toContain("=");
    expect(suggestions).toContain(">");
    expect(suggestions).not.toContain("Orders");
    expect(suggestions).not.toContain("Amount");
  });

  test("suggests boolean continuation after a completed comparison predicate", () => {
    const suggestions = labels("from table Orders\nwhere Amount = 10 ");

    expect(suggestions).toContain("and");
    expect(suggestions).toContain("or");
    expect(suggestions).not.toContain("=");
  });

  test("returns to predicate operands after a comparison operator", () => {
    const suggestions = labels("from table Orders\nwhere Amount = ");

    expect(suggestions).toContain("Amount");
    expect(suggestions).toContain("Stage");
    expect(suggestions).not.toContain("Orders");
  });

  test("uses an explicit from source instead of the current table scope", () => {
    const context = ctx({ currentTable: accounts });
    const suggestions = labels("from table Transactions\nselect ", context);

    expect(suggestions).toContain("Amount");
    expect(item("from table Transactions\nselect ", "Amount", context)?.detail).toContain("TAM01");
    expect(item("from table Transactions\nselect ", "Name", context)).toBeUndefined();
  });

  test("uses implicit current table and view sources when no from clause is present", () => {
    expect(labelsForCurrentSource("select ", { kind: "table", tableId: transactions.id })).toContain("Amount");
    expect(labelsForCurrentSource("select ", { kind: "view", viewId: revenueView.id })).toEqual(
      expect.arrayContaining(["Customer", "revenue"]),
    );
  });

  test("keeps select field and formula alias slots distinct", () => {
    expect(labels("from table Orders\nselect Amount ")).toContain("as");
    expect(labels("from table Orders\nselect Amount ")).not.toContain("Stage");
    expect(item("from table Orders\nselect Amount w", "where")?.textEdit).toMatchObject({
      start: "from table Orders\nselect Amount ".length,
      end: "from table Orders\nselect Amount w".length,
      text: "\nwhere ",
    });
    expect(item("from table Orders\nselect formula(Amount + 1) ", "as")?.textEdit.text).toBe("as ");
    expect(item("from table Orders\nselect formula(Amount + 1) as ", "formula_result")?.textEdit.text).toBe("formula_result");
    expect(labels("from table Orders\nselect formula(Amount + 1) as 1")).toEqual([]);
    expect(labels("from table Orders\nselect Amount, ")).toContain("Stage");
  });

  test("suggests fields for the scoped join alias", () => {
    const query = "from table Orders\njoin table Customers as customer on Customer = customer.id\nselect customer.";
    const suggestions = labels(query);

    expect(suggestions).toContain("Name");
    expect(suggestions).not.toContain("Amount");
    expect(item(query, "Name")?.textEdit).toMatchObject({ text: "Name", start: query.length, end: query.length });
  });

  test("suggests join structure after a completed join source", () => {
    const query = "from table Orders\njoin table Customers ";
    const suggestions = labels(query);

    expect(labels("from table Orders\njoin table Customers")).toContain("as");
    expect(labels("from table Orders\njoin table Customers")).not.toContain("Accounts");
    expect(suggestions).toContain("as");
    expect(suggestions).not.toContain("Orders");
    expect(suggestions).not.toContain("Customers");
    expect(item(query, "as")?.textEdit).toMatchObject({
      start: query.length,
      end: query.length,
      text: "as ",
    });
  });

  test("suggests join alias and on slots in order", () => {
    const aliasQuery = "from table Orders\njoin table Customers as ";
    const onQuery = "from table Orders\njoin table Customers as customer ";

    expect(item(aliasQuery, "customers")?.textEdit).toMatchObject({
      start: aliasQuery.length,
      end: aliasQuery.length,
      text: "customers",
    });
    expect(labels(aliasQuery)).not.toContain("Orders");
    expect(item(onQuery, "on")?.textEdit).toMatchObject({
      start: onQuery.length,
      end: onQuery.length,
      text: "on ",
    });
  });

  test("suggests join equality slots instead of stale field lists", () => {
    const equalsQuery = "from table Orders\njoin table Customers as customer on Customer ";
    const rightQuery = "from table Orders\njoin table Customers as customer on Customer = ";
    const nextClauseQuery = "from table Orders\njoin table Customers as customer on Customer = customer.id w";

    expect(labels(equalsQuery)).toContain("=");
    expect(labels(equalsQuery)).not.toContain("Amount");
    expect(labels(rightQuery)).toContain("Name");
    expect(item(nextClauseQuery, "where")?.textEdit).toMatchObject({
      start: "from table Orders\njoin table Customers as customer on Customer = customer.id ".length,
      end: nextClauseQuery.length,
      text: "\nwhere ",
    });
  });

  test("keeps group-by field and date granularity slots distinct", () => {
    expect(labels("from table Orders\ngroup by ")).toContain("Stage");
    expect(labels("from table Orders\ngroup by ")).not.toContain("day");
    expect(labels('from table Orders\ngroup by "Ordered at" ')).toContain("by");
    expect(labels('from table Orders\ngroup by "Ordered at" b')).toContain("by");
    expect(labels('from table Orders\ngroup by "Ordered at" by ')).toContain("month");
    expect(item("from table Orders\ngroup by Stage w", "where")?.textEdit).toMatchObject({
      start: "from table Orders\ngroup by Stage ".length,
      end: "from table Orders\ngroup by Stage w".length,
      text: "\nwhere ",
    });
  });

  test("suggests aggregate aliases after completed aggregate calls", () => {
    const asQuery = "from table Orders\ngroup by Stage\naggregate sum(Amount) ";
    const aliasQuery = "from table Orders\ngroup by Stage\naggregate sum(Amount) as ";
    const nextClauseQuery = "from table Orders\ngroup by Stage\naggregate sum(Amount) as total s";

    expect(labels(asQuery)).toContain("as");
    expect(labels(asQuery)).not.toContain("sum");
    expect(item(aliasQuery, "sum_amount")?.textEdit).toMatchObject({
      start: aliasQuery.length,
      end: aliasQuery.length,
      text: "sum_amount",
    });
    expect(item(nextClauseQuery, "sort")?.textEdit).toMatchObject({
      start: "from table Orders\ngroup by Stage\naggregate sum(Amount) as total ".length,
      end: nextClauseQuery.length,
      text: "\nsort ",
    });
    expect(labels("from table Orders\ngroup by Stage\naggregate sum(Amount) as 1")).toEqual([]);
  });

  test("suggests search field scoping only after quoted search text", () => {
    expect(item("from table Orders\nsearch ", "quoted search text")?.textEdit.text).toBe("''");
    expect(labels("from table Orders\nsearch 'open' ")).toContain("in");
    expect(labels("from table Orders\nsearch 'open' in ")).toContain("Stage");
    expect(item("from table Orders\nsearch 'open' in Stage w", "where")?.textEdit).toMatchObject({
      start: "from table Orders\nsearch 'open' in Stage ".length,
      end: "from table Orders\nsearch 'open' in Stage w".length,
      text: "\nwhere ",
    });
  });

  test("keeps sort, numeric, and trash clause completions inside their grammar slots", () => {
    const sortDone = "from table Orders\nsort Amount asc nulls first s";
    const limitDone = "from table Orders\nlimit 10 s";

    expect(item("from table Orders\nsort Amount asc nulls first ", "sort")?.textEdit.text).toBe("\nsort ");
    expect(item(sortDone, "sort")?.textEdit).toMatchObject({
      start: "from table Orders\nsort Amount asc nulls first ".length,
      end: sortDone.length,
      text: "\nsort ",
    });
    expect(labels("from table Orders\nlimit ")).toEqual([]);
    expect(item(limitDone, "sort")?.textEdit).toMatchObject({
      start: "from table Orders\nlimit 10 ".length,
      end: limitDone.length,
      text: "\nsort ",
    });
    expect(item("from table Orders\ninclude ", "deleted")?.textEdit.text).toBe("deleted");
    expect(item("from table Orders\ndeleted ", "only")?.textEdit.text).toBe("only");
  });

  test("suggests GQL predicate helpers in where clauses", () => {
    expect(labels("from table Orders\nwhere ico")).toContain("icontains");
    expect(item("from table Orders\nwhere one", "oneof")?.textEdit.text).toBe("oneof(");
  });

  test("suggests aggregate aliases for having and grouped sort", () => {
    const prefix = "from table Orders\ngroup by Stage\naggregate sum(Amount) as total";

    expect(labels(`${prefix}\nhaving `)).toContain("total");
    expect(labels(`${prefix}\nsort `)).toContain("total");
  });

  test("suggests derived saved-view output columns instead of raw source fields", () => {
    const suggestions = labels('from view "Revenue by customer"\nselect ');

    expect(suggestions).toEqual(expect.arrayContaining(["Customer", "revenue"]));
    expect(suggestions).not.toContain("Amount");
  });

  test("does not suggest sources or fields omitted from the permission-shaped context", () => {
    const context = ctx({
      tables: [orders],
      views: [],
      fieldsByTableId: {
        [orders.id]: [amount, stage],
      },
    });

    expect(labels("from table ", context)).toEqual(["Orders"]);
    expect(labels("from table Orders\njoin table ", context)).not.toContain("Customers");
    expect(labels("from table Orders\nselect ", context)).not.toContain("Customer");
  });
});
