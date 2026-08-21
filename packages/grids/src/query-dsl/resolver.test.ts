import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import type { RecordQuery } from "../contracts";
import type { FormulaSqlExpression } from "../service/formula-sql-compiler";
import { dslPreviewDiagnosticForCompilerError, resolveDslPreviewLimit } from "./preview";
import { isDslAggregateOnlyPlan, resolveDslQueryToQueryPlan, resolveDslQueryToRecordQuery } from "./resolver";
import {
  amountFieldId,
  attachmentFieldId,
  costFieldId,
  createdAtField,
  createdAtFieldId,
  createdByField,
  ctx,
  customerFieldId,
  customerFields,
  customerLinkFieldId,
  customerNameFieldId,
  customerRegionFieldId,
  customerScoreFieldId,
  customers,
  field,
  fields,
  normalizedSql,
  normalizedSqlParts,
  orderedAtFieldId,
  orders,
  paidFieldId,
  parseOk,
  statusFieldId,
} from "./resolver-fixtures";
import {
  compileDslAggregateQueryPlanToSql,
  compileDslDerivedViewSourcePlanToSql,
  compileDslGroupedQueryPlanToSql,
  compileDslQueryPlanToSql,
} from "./sql-compiler";

describe("resolveDslQueryToRecordQuery", () => {
  test("resolves a table DSL query into the canonical RecordQuery shape", () => {
    const ast = parseOk(`
      from table Orders
      select customer, amount as net, formula(amount * 1.19) as gross
      where status = 'open' and amount > 100
      sort net desc
      limit 50
    `);

    const result = resolveDslQueryToRecordQuery(ast, ctx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.tableId).toBe(orders.id);
    expect(result.plan.query).toEqual({
      filter: {
        op: "AND",
        filters: [
          { fieldId: statusFieldId, op: "is", value: "open" },
          { fieldId: amountFieldId, op: ">", value: 100 },
        ],
      },
      columns: [
        { fieldId: customerFieldId },
        { fieldId: amountFieldId, label: "net" },
        { kind: "computed", id: expect.stringMatching(/^computed_[A-Za-z0-9]{5,32}$/), label: "gross", expression: "amount * 1.19" },
      ],
      sort: [{ fieldId: amountFieldId, direction: "desc" }],
      limit: 50,
    });
  });

  test("resolves readable table and field names to stable ids", () => {
    const ast = parseOk(`
      from table Orders
      select Customer, Amount as net, formula(Amount * 1.19) as gross
      where Status = 'open' and "Ordered at" > '2026-01-01'
      sort net desc
    `);

    const result = resolveDslQueryToRecordQuery(ast, ctx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.tableId).toBe(orders.id);
    expect(result.plan.query.filter).toEqual({
      op: "AND",
      filters: [
        { fieldId: statusFieldId, op: "is", value: "open" },
        { fieldId: orderedAtFieldId, op: "after", value: "2026-01-01" },
      ],
    });
    expect(result.plan.query.columns).toEqual([
      { fieldId: customerFieldId },
      { fieldId: amountFieldId, label: "net" },
      { kind: "computed", id: expect.stringMatching(/^computed_[A-Za-z0-9]{5,32}$/), label: "gross", expression: "Amount * 1.19" },
    ]);
    expect(result.plan.query.sort).toEqual([{ fieldId: amountFieldId, direction: "desc" }]);
  });

  test("uses the current table when from is omitted", () => {
    const result = resolveDslQueryToRecordQuery(parseOk(`select amount`), ctx());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.source).toEqual(orders);
  });

  test("binds public record ids separately from internal user metadata ids", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const otherUserId = "22222222-2222-4222-8222-222222222222";
    const recordId = "REC001";
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        where record.id = '${recordId}' and oneof(record.createdBy, '${userId}', '${otherUserId}') and record.updatedBy = '${userId}'
        sort record.createdAt desc
      `),
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.query.recordMeta).toBeUndefined();
    expect(result.plan.wherePredicate).toEqual({
      kind: "and",
      parts: [
        { kind: "publicRecordIds", ids: [recordId] },
        { kind: "recordMeta", meta: { users: { createdBy: [userId, otherUserId] } } },
        { kind: "recordMeta", meta: { users: { updatedBy: [userId] } } },
      ],
    });
    expect(result.plan.query.sort).toEqual([{ source: "record", key: "createdAt", direction: "desc" }]);
  });

  test("rejects RecordQuery conversion for view sources that need scoped preview semantics", () => {
    const viewQuery: RecordQuery = {
      filter: { fieldId: paidFieldId, op: "=", value: true },
      sort: [{ fieldId: orderedAtFieldId, direction: "desc" }],
      limit: 25,
    };
    const ast = parseOk(`
      from view Paid
      select customer
      limit 5
    `);

    const result = resolveDslQueryToRecordQuery(
      ast,
      ctx({
        views: [
          {
            kind: "view",
            id: "33333333-3333-4333-8333-333333333333",
            shortId: "Paid",
            name: "Paid orders",
            tableId: orders.id,
            query: viewQuery,
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((d) => d.message)).toEqual([
        "view sources with limit/scope semantics cannot be represented by the records-table runtime yet",
      ]);
    }
  });

  test("keeps a view source filter as a hard scope when DSL adds a filter", () => {
    const viewFilter = { fieldId: paidFieldId, op: "=", value: true } as const;
    const ast = parseOk(`
      from view Paid
      where status = 'open'
    `);

    const result = resolveDslQueryToRecordQuery(
      ast,
      ctx({
        views: [
          {
            kind: "view",
            id: "33333333-3333-4333-8333-333333333333",
            shortId: "Paid",
            name: "Paid orders",
            tableId: orders.id,
            query: { filter: viewFilter },
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.query.filter).toEqual({
      op: "AND",
      filters: [viewFilter, { fieldId: statusFieldId, op: "is", value: "open" }],
    });
  });

  test("resolves group-by and aggregations without inventing SQL", () => {
    const ast = parseOk(`
      group by ordered_at by month
      aggregate sum(amount) as revenue, count(*) as rows
    `);

    const result = resolveDslQueryToRecordQuery(ast, ctx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.query.groupBy).toEqual([{ fieldId: orderedAtFieldId, granularity: "month" }]);
    expect(result.plan.query.aggregations).toEqual([
      { fieldId: amountFieldId, agg: "sum", label: "revenue" },
      { fieldId: "*", agg: "count", label: "rows" },
    ]);
  });

  test("rejects sources the caller did not expose to the resolver", () => {
    const result = resolveDslQueryToRecordQuery(parseOk(`from table Secret`), ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(['source "Secret" is not available']);
  });

  test("typed sources do not guess between tables and views with the same ref", () => {
    const result = resolveDslQueryToRecordQuery(
      parseOk(`from table Orders`),
      ctx({
        views: [
          {
            kind: "view",
            id: "33333333-3333-4333-8333-333333333333",
            shortId: "Orders",
            name: "Orders view",
            tableId: orders.id,
            query: {},
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.tableId).toBe(orders.id);
  });

  test("rejects duplicate select aliases before RecordQuery validation", () => {
    const ast = parseOk(`select customer as label, formula(amount * 2) as label`);

    const result = resolveDslQueryToRecordQuery(ast, ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(['duplicate select alias "label"']);
  });

  test("rejects duplicate field aliases before alias-based sorting can become ambiguous", () => {
    const result = resolveDslQueryToRecordQuery(parseOk(`select amount as value, cost as value`), ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(['duplicate select alias "value"']);
  });

  test("generates stable distinct computed ids for aliases that normalize similarly", () => {
    const result = resolveDslQueryToRecordQuery(parseOk(`select formula(amount * 2) as a, formula(amount * 3) as a_`), ctx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const computedIds = result.plan.query.columns
      ?.map((column) => ("kind" in column && column.kind === "computed" ? column.id : null))
      .filter(Boolean);
    expect(computedIds).toHaveLength(2);
    expect(new Set(computedIds).size).toBe(2);
  });

  test("rejects unknown field refs with a direct diagnostic", () => {
    const result = resolveDslQueryToRecordQuery(parseOk(`where missing = 'x'`), ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(['unknown field "missing"']);
  });

  test("query plan reports source positions for semantic field diagnostics", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`where missing > 1
sort missing desc`),
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual({ message: 'unknown field "missing"', line: 1, column: 7, length: 7 });
    expect(result.diagnostics).toContainEqual({ message: 'unknown field "missing"', line: 2, column: 6, length: 7 });
  });

  test("allows count(*) but rejects other aggregate functions over *", () => {
    const result = resolveDslQueryToRecordQuery(parseOk(`group by status\naggregate sum(*) as total`), ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(['aggregate "sum" cannot use *']);
  });

  test("rejects aggregate-only RecordQuery because preview renders a synthetic aggregate row", () => {
    const result = resolveDslQueryToRecordQuery(parseOk(`aggregate sum(amount) as revenue`), ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((d) => d.message)).toContain(
        "aggregate-only queries cannot be represented by the records-table runtime yet; add group by or use preview",
      );
    }
  });

  test("query plan still supports aggregate-only previews", () => {
    const median = resolveDslQueryToRecordQuery(parseOk(`aggregate median(amount) as middle`), ctx());
    expect(median.ok).toBe(false);
    if (!median.ok) {
      expect(median.diagnostics.map((d) => d.message)).toContain(
        "aggregate-only queries cannot be represented by the records-table runtime yet; add group by or use preview",
      );
    }

    const latest = resolveDslQueryToQueryPlan(parseOk(`aggregate latest(ordered_at) as latest_order`), ctx());
    expect(latest.ok).toBe(true);
    if (latest.ok) expect(latest.plan.query.aggregations).toEqual([{ fieldId: orderedAtFieldId, agg: "latest", label: "latest_order" }]);
  });

  test("rejects RecordQuery grouped shapes that the group compiler cannot run", () => {
    const textSum = resolveDslQueryToRecordQuery(parseOk(`group by status\naggregate sum(customer) as total`), ctx());
    expect(textSum.ok).toBe(false);
    if (!textSum.ok) expect(textSum.diagnostics.map((d) => d.message)).toEqual(['agg "sum" not compatible with field type "text"']);

    // Grouped median / earliest / latest are now first-class (C12).
    const median = resolveDslQueryToRecordQuery(parseOk(`group by status\naggregate median(amount) as middle`), ctx());
    expect(median.ok).toBe(true);
    if (median.ok) expect(median.plan.query.aggregations).toEqual([{ fieldId: amountFieldId, agg: "median", label: "middle" }]);

    const latest = resolveDslQueryToRecordQuery(parseOk(`group by status\naggregate latest(ordered_at) as last_order`), ctx());
    expect(latest.ok).toBe(true);
    if (latest.ok) expect(latest.plan.query.aggregations).toEqual([{ fieldId: orderedAtFieldId, agg: "latest", label: "last_order" }]);

    const fileField = field({ id: attachmentFieldId, shortId: "files", name: "Files", type: "file", position: 8 });
    const fileGroup = resolveDslQueryToRecordQuery(
      parseOk(`group by files`),
      ctx({ fieldsByTableId: { ...ctx().fieldsByTableId, [orders.id]: [...fields, fileField] } }),
    );
    expect(fileGroup.ok).toBe(false);
    if (!fileGroup.ok) expect(fileGroup.diagnostics.map((d) => d.message)).toEqual(['field "Files" (type "file") is not groupable']);
  });

  test("rejects RecordQuery conversion for a preview-valid query that uses formula aggregates", () => {
    // Valid in preview (grouped formula aggregate); not yet expressible as a
    // RecordQuery runtime — the single resolver flags it at the save boundary.
    const ast = parseOk(`
      from table Orders
      group by Status
      aggregate avg(formula(amount - cost)) as margin
    `);

    const viewResult = resolveDslQueryToRecordQuery(ast, ctx());
    const planResult = resolveDslQueryToQueryPlan(ast, ctx());

    expect(planResult.ok).toBe(true);
    expect(viewResult.ok).toBe(false);
    if (!viewResult.ok) {
      expect(viewResult.diagnostics.map((d) => d.message)).toEqual([
        "formula aggregates cannot be represented by the records-table runtime yet",
      ]);
    }
  });

  test("rejects RecordQuery conversion for a query that uses relation joins", () => {
    const ast = parseOk(`
      join table Custs as c on customer_link = c.id
      select amount, c.name as customer_name
    `);

    const viewResult = resolveDslQueryToRecordQuery(ast, ctx());
    expect(viewResult.ok).toBe(false);
    if (!viewResult.ok) {
      expect(viewResult.diagnostics.map((d) => d.message)).toEqual([
        "queries with relation joins cannot be represented by the records-table runtime yet",
      ]);
    }
  });

  test("rejects RecordQuery computed selects that cannot compile to SQL", () => {
    const result = resolveDslQueryToRecordQuery(parseOk(`select formula(customer_link) as linked`), ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((d) => d.message)).toEqual([
        'select "linked": Field Customer link (relation) cannot be compiled into SQL formulas yet',
      ]);
    }
  });

  test("rejects formula filters instead of silently running them client-side", () => {
    const ast = parseOk(`where amount > cost * 1.10`);

    const result = resolveDslQueryToRecordQuery(ast, ctx());

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics.map((d) => d.message)).toEqual([
        "this where clause uses a formula, NOT, or cross-field comparison and cannot be represented as a RecordQuery filter yet",
      ]);
  });

  test("rejects sorting by computed aliases because RecordQuery cannot sort them yet", () => {
    const ast = parseOk(`
      select formula(amount * 2) as doubled
      sort doubled desc
    `);

    const result = resolveDslQueryToRecordQuery(ast, ctx());

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics.map((d) => d.message)).toEqual(['sort by computed alias "doubled" is not supported by RecordQuery yet']);
  });

  test("query plan accepts sorting by computed select aliases without changing RecordQuery behavior", () => {
    const ast = parseOk(`
      select formula(amount * 2) as doubled
      sort doubled desc
    `);

    const viewResult = resolveDslQueryToRecordQuery(ast, ctx());
    const planResult = resolveDslQueryToQueryPlan(ast, ctx());

    expect(viewResult.ok).toBe(false);
    if (!viewResult.ok)
      expect(viewResult.diagnostics.map((d) => d.message)).toEqual([
        'sort by computed alias "doubled" is not supported by RecordQuery yet',
      ]);
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) return;
    expect(planResult.plan.query.sort).toBeUndefined();
    expect(planResult.plan.sqlSort).toEqual([{ kind: "computed", alias: "doubled", direction: "desc" }]);
  });

  test("rejects non-zero offset when compiling to RecordQuery", () => {
    const result = resolveDslQueryToRecordQuery(parseOk(`select amount\noffset 10`), ctx());

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics.map((d) => d.message)).toEqual(["offset cannot be represented by the records-table runtime yet"]);
  });

  test("allows no-op offset when compiling to RecordQuery", () => {
    const result = resolveDslQueryToRecordQuery(parseOk(`select amount\noffset 0`), ctx());

    expect(result.ok).toBe(true);
  });

  test("query plan accepts SQL-valid formula where predicates without changing RecordQuery behavior", () => {
    const ast = parseOk(`where amount > cost * 1.10`);

    const viewResult = resolveDslQueryToRecordQuery(ast, ctx());
    const planResult = resolveDslQueryToQueryPlan(ast, ctx());

    expect(viewResult.ok).toBe(false);
    if (!viewResult.ok)
      expect(viewResult.diagnostics.map((d) => d.message)).toEqual([
        "this where clause uses a formula, NOT, or cross-field comparison and cannot be represented as a RecordQuery filter yet",
      ]);
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) return;
    expect(planResult.plan.query.filter).toBeUndefined();
    expect(planResult.plan.wherePredicate).toMatchObject({ kind: "formula" });
  });

  test("query plan rejects formula select expressions that cannot compile to SQL", () => {
    const result = resolveDslQueryToQueryPlan(parseOk(`select formula(customer_link) as linked`), ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((d) => d.message)).toEqual([
        'select "linked": Field Customer link (relation) cannot be compiled into SQL formulas yet',
      ]);
    }
  });

  test("query plan scopes view source search and record metadata", () => {
    const resolved = resolveDslQueryToQueryPlan(
      parseOk(`
        from view Mine
        select amount
      `),
      ctx({
        views: [
          {
            kind: "view",
            id: "33333333-3333-4333-8333-333333333333",
            shortId: "Mine",
            name: "Scoped view",
            tableId: orders.id,
            query: {
              search: { q: "open" },
              recordMeta: { users: { createdBy: ["11111111-1111-4111-8111-111111111111"] } },
            },
          },
        ],
      }),
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.plan.viewSourceQuery).toMatchObject({
      search: { q: "open" },
      recordMeta: { users: { createdBy: ["11111111-1111-4111-8111-111111111111"] } },
    });
    expect(resolved.plan.query.search).toBeUndefined();
    expect(resolved.plan.query.recordMeta).toBeUndefined();
  });

  test("query plan scopes row-shaped view source sort and limit", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        from view Top
        select amount
      `),
      ctx({
        views: [
          {
            kind: "view",
            id: "33333333-3333-4333-8333-333333333333",
            shortId: "Top",
            name: "Top orders",
            tableId: orders.id,
            query: { sort: [{ fieldId: amountFieldId, direction: "desc" }], limit: 10 },
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.viewSourceQuery).toEqual({ sort: [{ fieldId: amountFieldId, direction: "desc" }], limit: 10 });
    expect(result.plan.query.sort).toEqual([{ fieldId: amountFieldId, direction: "desc" }]);
    expect(result.plan.query.limit).toBe(10);
  });

  test("query plan resolves grouped saved views as derived sources", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        from view Summary
        select "Ordered at (month)", revenue
        where revenue > 10
        sort revenue desc
        limit 5
      `),
      ctx({
        views: [
          {
            kind: "view",
            id: "33333333-3333-4333-8333-333333333333",
            shortId: "Summary",
            name: "Monthly summary",
            tableId: orders.id,
            query: {
              groupBy: [{ fieldId: orderedAtFieldId, granularity: "month" }],
              aggregations: [{ fieldId: amountFieldId, agg: "sum", label: "revenue" }],
            },
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.derivedViewSource?.columns.map((column) => ({ key: column.key, label: column.label }))).toEqual([
      { key: "gk_0", label: "Ordered at (month)" },
      { key: `${amountFieldId}__sum`, label: "revenue" },
    ]);
    expect(result.plan.derivedViewSource?.outputColumns.map((column) => column.key)).toEqual(["gk_0", `${amountFieldId}__sum`]);
    expect(result.plan.derivedViewSource?.sort.map((sort) => sort.column.key)).toEqual([`${amountFieldId}__sum`]);
    expect(result.plan.query.limit).toBe(5);
  });

  test("query plan enforces one case-insensitive namespace for derived output aliases", () => {
    const context = ctx({
      views: [
        {
          kind: "view",
          id: "33333333-3333-4333-8333-333333333333",
          shortId: "Summary",
          name: "Monthly summary",
          tableId: orders.id,
          query: {
            groupBy: [{ fieldId: orderedAtFieldId, granularity: "month" }],
            aggregations: [{ fieldId: amountFieldId, agg: "sum", label: "revenue" }],
          },
        },
      ],
    });

    const duplicate = resolveDslQueryToQueryPlan(
      parseOk(`from view Summary\nselect revenue as value, "Ordered at (month)" as VALUE`),
      context,
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.diagnostics.map((item) => item.message)).toEqual(['duplicate select alias "VALUE"']);

    const sourceCollision = resolveDslQueryToQueryPlan(parseOk(`from view Summary\nselect "Ordered at (month)" as revenue`), context);
    expect(sourceCollision.ok).toBe(false);
    if (!sourceCollision.ok)
      expect(sourceCollision.diagnostics.map((item) => item.message)).toEqual(['select alias "revenue" conflicts with a derived column']);
  });

  test("query plan sorts derived and joined output aliases", () => {
    const summaryContext = ctx({
      views: [
        {
          kind: "view",
          id: "33333333-3333-4333-8333-333333333333",
          shortId: "Summary",
          name: "Monthly summary",
          tableId: orders.id,
          query: {
            groupBy: [{ fieldId: orderedAtFieldId, granularity: "month" }],
            aggregations: [{ fieldId: amountFieldId, agg: "sum", label: "revenue" }],
          },
        },
      ],
    });
    const derived = resolveDslQueryToQueryPlan(parseOk(`from view Summary\nselect revenue as total\nsort TOTAL desc`), summaryContext);
    expect(derived.ok).toBe(true);
    if (derived.ok) {
      expect(derived.plan.derivedViewSource?.sort).toEqual([
        expect.objectContaining({ column: expect.objectContaining({ key: `${amountFieldId}__sum`, label: "total" }), direction: "desc" }),
      ]);
    }

    const joinedContext = ctx({
      views: [
        {
          kind: "view",
          id: "33333333-3333-4333-8333-333333333333",
          shortId: "ByCust",
          name: "Revenue by customer",
          tableId: orders.id,
          query: {
            groupBy: [{ fieldId: customerLinkFieldId }],
            aggregations: [{ fieldId: amountFieldId, agg: "sum", label: "revenue" }],
          },
        },
      ],
    });
    const joined = resolveDslQueryToQueryPlan(
      parseOk(`
        from view ByCust
        join table Custs as customer on customer_link = customer.id
        select customer.name as customer_name
        sort CUSTOMER_NAME asc
      `),
      joinedContext,
    );
    expect(joined.ok).toBe(true);
    if (joined.ok) {
      expect(joined.plan.derivedViewSource?.joinedSort).toEqual([
        { kind: "joinedField", joinAlias: "customer", tableId: customers.id, fieldId: customerNameFieldId, direction: "asc" },
      ]);
    }

    const duplicateAcrossOutputs = resolveDslQueryToQueryPlan(
      parseOk(`
        from view ByCust
        join table Custs as customer on customer_link = customer.id
        select revenue as value, customer.name as VALUE
      `),
      joinedContext,
    );
    expect(duplicateAcrossOutputs.ok).toBe(false);
    if (!duplicateAcrossOutputs.ok) {
      expect(duplicateAcrossOutputs.diagnostics.map((item) => item.message)).toEqual(['duplicate select alias "VALUE"']);
    }
  });

  test("query plan resolves aggregate-only saved views as one-row derived sources", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        from view Totals
        select rows, revenue
        where revenue > 0
      `),
      ctx({
        views: [
          {
            kind: "view",
            id: "33333333-3333-4333-8333-333333333333",
            shortId: "Totals",
            name: "Totals",
            tableId: orders.id,
            query: {
              aggregations: [
                { fieldId: "*", agg: "count", label: "rows" },
                { fieldId: amountFieldId, agg: "sum", label: "revenue" },
              ],
            },
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.derivedViewSource?.columns.map((column) => ({ key: column.key, label: column.label }))).toEqual([
      { key: "*__count", label: "rows" },
      { key: `${amountFieldId}__sum`, label: "revenue" },
    ]);
    expect(result.plan.derivedViewSource?.where?.source).toBe("revenue > 0");
  });

  test("query plan resolves search over derived view output", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        from view Summary
        search 'alice' in Customer
        select Customer, revenue
      `),
      ctx({
        views: [
          {
            kind: "view",
            id: "33333333-3333-4333-8333-333333333333",
            shortId: "Summary",
            name: "Status summary",
            tableId: orders.id,
            query: {
              groupBy: [{ fieldId: customerFieldId }],
              aggregations: [{ fieldId: amountFieldId, agg: "sum", label: "revenue" }],
            },
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.derivedViewSource?.search?.q).toBe("alice");
    expect(result.plan.derivedViewSource?.search?.columns.map((column) => column.key)).toEqual(["gk_0"]);
  });

  test("query plan resolves grouped and aggregate derived view output", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        from view Summary
        group by Status
        aggregate sum(revenue) as total_revenue, count(*) as rows
        having total_revenue > 10
        sort total_revenue desc nulls last
        limit 5
      `),
      ctx({
        views: [
          {
            kind: "view",
            id: "33333333-3333-4333-8333-333333333333",
            shortId: "Summary",
            name: "Status summary",
            tableId: orders.id,
            query: {
              groupBy: [{ fieldId: statusFieldId }],
              aggregations: [{ fieldId: amountFieldId, agg: "sum", label: "revenue" }],
            },
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.plan.derivedViewSource?.groupBy?.map((group) => ({
        key: group.key,
        column: group.kind === "derived" ? group.column.key : group.fieldId,
      })),
    ).toEqual([{ key: "gk_0", column: "gk_0" }]);
    expect(result.plan.derivedViewSource?.aggregations?.map((aggregation) => ({ key: aggregation.key, label: aggregation.label }))).toEqual(
      [
        { key: `${amountFieldId}__sum__sum`, label: "total_revenue" },
        { key: "*__count", label: "rows" },
      ],
    );
    expect(result.plan.derivedViewSource?.having?.source).toBe("total_revenue > 10");
    expect(result.plan.derivedViewSource?.groupSort).toEqual([{ key: `${amountFieldId}__sum__sum`, direction: "desc", nullsFirst: false }]);
  });

  test("query plan resolves derived relation output joins", () => {
    const context = ctx({
      views: [
        {
          kind: "view",
          id: "33333333-3333-4333-8333-333333333333",
          shortId: "ByCust",
          name: "Revenue by customer",
          tableId: orders.id,
          query: {
            groupBy: [{ fieldId: customerLinkFieldId }],
            aggregations: [{ fieldId: amountFieldId, agg: "sum", label: "revenue" }],
          },
        },
      ],
    });

    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        from view ByCust
        join table Custs as customer on customer_link = customer.id
        select customer_link, revenue, customer.name as customer_name
        sort customer.name asc
      `),
      context,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.derivedViewSource?.columns.find((column) => column.key === "gk_0")).toMatchObject({
      label: "Customer link",
      type: "relation",
      targetTableId: customers.id,
      sqlType: "text",
    });
    expect(result.plan.derivedViewSource?.joins).toEqual([
      expect.objectContaining({ alias: "customer", tableId: customers.id, column: expect.objectContaining({ key: "gk_0" }) }),
    ]);
    expect(result.plan.derivedViewSource?.joinedColumns).toEqual([
      { joinAlias: "customer", tableId: customers.id, fieldId: customerNameFieldId, label: "customer_name" },
    ]);
    expect(result.plan.derivedViewSource?.joinedSort).toEqual([
      { kind: "joinedField", joinAlias: "customer", tableId: customers.id, fieldId: customerNameFieldId, direction: "asc" },
    ]);

    const compiled = compileDslDerivedViewSourcePlanToSql(result.plan, { fieldsByTableId: context.fieldsByTableId });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const sqlText = normalizedSql(compiled.query.sql);
    expect(sqlText).toContain("JOIN grids.records dj0");
    expect(sqlText).toContain('dj0.id = (d."gk_0")::uuid');
    expect(sqlText).toContain("dj0.data->>");
    expect(compiled.query.columns.map((column) => column.label)).toEqual(["Customer link", "revenue", "customer_name"]);
  });

  test("query plan resolves derived joined predicates and regrouping", () => {
    const context = ctx({
      views: [
        {
          kind: "view",
          id: "33333333-3333-4333-8333-333333333333",
          shortId: "ByCust",
          name: "Revenue by customer",
          tableId: orders.id,
          query: {
            groupBy: [{ fieldId: customerLinkFieldId }],
            aggregations: [{ fieldId: amountFieldId, agg: "sum", label: "revenue" }],
          },
        },
      ],
    });

    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        from view ByCust
        join table Custs as customer on customer_link = customer.id
        search 'alice' in customer.name
        where customer.score > 5 and revenue > 1
        group by customer.name
        aggregate sum(revenue) as total_revenue, avg(customer.score) as avg_score, sum(formula(revenue + customer.score)) as weighted
        having total_revenue > 10
        sort total_revenue desc
      `),
      context,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.derivedViewSource?.joinedSearch).toEqual([
      { q: "alice", tableId: customers.id, joinAlias: "customer", fieldIds: [customerNameFieldId] },
    ]);
    expect(result.plan.derivedViewSource?.where?.source).toBe("customer.score > 5 and revenue > 1");
    expect(result.plan.derivedViewSource?.groupBy).toEqual([
      expect.objectContaining({ kind: "joined", key: "gk_0", joinAlias: "customer", tableId: customers.id, fieldId: customerNameFieldId }),
    ]);
    expect(result.plan.derivedViewSource?.aggregations).toEqual([
      expect.objectContaining({ key: `${amountFieldId}__sum__sum`, label: "total_revenue" }),
      expect.objectContaining({ key: `${customerScoreFieldId}__avg`, label: "avg_score", joinAlias: "customer" }),
    ]);
    expect(result.plan.derivedViewSource?.formulaAggregations).toEqual([
      expect.objectContaining({ id: "weighted", ref: "weighted", source: "revenue + customer.score", agg: "sum" }),
    ]);
    expect(result.plan.derivedViewSource?.having?.source).toBe("total_revenue > 10");
    expect(result.plan.derivedViewSource?.groupSort).toEqual([{ key: `${amountFieldId}__sum__sum`, direction: "desc" }]);

    const compiled = compileDslDerivedViewSourcePlanToSql(result.plan, { fieldsByTableId: context.fieldsByTableId });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const sqlText = normalizedSql(compiled.query.sql);
    expect(sqlText).toContain("JOIN grids.records dj0");
    expect(sqlText).toContain("GROUP BY 1");
    expect(sqlText).toContain("HAVING");
    expect(compiled.query.columns.map((column) => column.label)).toEqual(["Name", "# records", "total_revenue", "avg_score", "weighted"]);
  });

  test("query plan rejects derived aggregate aliases that collide with derived refs", () => {
    const context = ctx({
      views: [
        {
          kind: "view",
          id: "33333333-3333-4333-8333-333333333333",
          shortId: "ByCust",
          name: "Revenue by customer",
          tableId: orders.id,
          query: {
            groupBy: [{ fieldId: customerLinkFieldId }],
            aggregations: [{ fieldId: amountFieldId, agg: "sum", label: "revenue" }],
          },
        },
      ],
    });

    const groupCollision = resolveDslQueryToQueryPlan(
      parseOk(`
        from view ByCust
        group by customer_link
        aggregate sum(revenue) as customer_link
      `),
      context,
    );
    expect(groupCollision.ok).toBe(false);
    if (!groupCollision.ok)
      expect(groupCollision.diagnostics.map((d) => d.message)).toContain('aggregate alias "customer_link" conflicts with a derived column');

    const derivedColumnCollision = resolveDslQueryToQueryPlan(parseOk(`from view ByCust\naggregate sum(revenue) as revenue`), context);
    expect(derivedColumnCollision.ok).toBe(false);
    if (!derivedColumnCollision.ok)
      expect(derivedColumnCollision.diagnostics.map((d) => d.message)).toContain(
        'aggregate alias "revenue" conflicts with a derived column',
      );
  });

  test("query plan rejects unsupported derived view source shapes", () => {
    const context = ctx({
      views: [
        {
          kind: "view",
          id: "33333333-3333-4333-8333-333333333333",
          shortId: "Summary",
          name: "Monthly summary",
          tableId: orders.id,
          query: {
            groupBy: [{ fieldId: orderedAtFieldId, granularity: "month" }],
            aggregations: [{ fieldId: amountFieldId, agg: "sum", label: "revenue" }],
          },
        },
        {
          kind: "view",
          id: "77777777-7777-4777-8777-777777777777",
          shortId: "ByCust",
          name: "Revenue by customer",
          tableId: orders.id,
          query: {
            groupBy: [{ fieldId: customerLinkFieldId }],
            aggregations: [{ fieldId: amountFieldId, agg: "sum", label: "revenue" }],
          },
        },
      ],
    });

    const selectedGroup = resolveDslQueryToQueryPlan(parseOk(`from view Summary\nselect revenue\ngroup by revenue`), context);
    expect(selectedGroup.ok).toBe(false);
    if (!selectedGroup.ok) {
      expect(selectedGroup.diagnostics.map((d) => d.message)).toContain(
        "grouped derived view source queries use group and aggregate output, not select columns",
      );
    }

    const joined = resolveDslQueryToQueryPlan(
      parseOk(`from view Summary\njoin table Customers as customer on gk_0 = customer.id`),
      context,
    );
    expect(joined.ok).toBe(false);
    if (!joined.ok) {
      expect(joined.diagnostics.map((d) => d.message)).toContain(
        'derived column "Ordered at (month)" is not a relation record id and cannot be joined',
      );
    }

    const aggregateSort = resolveDslQueryToQueryPlan(parseOk(`from view ByCust\naggregate sum(revenue) as total\nsort total`), context);
    expect(aggregateSort.ok).toBe(false);
    if (!aggregateSort.ok) {
      expect(aggregateSort.diagnostics.map((d) => d.message)).toContain("aggregate-only derived view source queries cannot sort");
    }
  });

  test("query plan rejects formula where predicates that cannot compile to SQL", () => {
    const missing = resolveDslQueryToQueryPlan(parseOk(`where missing > cost * 1.10`), ctx());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.diagnostics.map((d) => d.message)).toEqual(['where: Unknown formula field reference "missing"']);

    // Relation `=` is now a first-class structured predicate; an invalid public id
    // gets a clear, relation-specific error instead of a formula fallback.
    const relation = resolveDslQueryToQueryPlan(parseOk(`where customer_link = 'abc'`), ctx());
    expect(relation.ok).toBe(false);
    if (!relation.ok) {
      expect(relation.diagnostics.map((d) => d.message)).toEqual(['"Customer link" is a relation; compare it to a public record id']);
    }
  });

  test("query plan rejects non-boolean formula where predicates", () => {
    const result = resolveDslQueryToQueryPlan(parseOk(`where amount + 1`), ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(["where condition must be a true/false expression"]);
  });

  test("query plan accepts having predicates over aggregate aliases", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        group by ordered_at by month
        aggregate sum(amount) as revenue, count(*) as rows
        having revenue > 100 and rows >= 2
      `),
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.formulaHaving).toMatchObject({
      kind: "formula",
      source: "revenue > 100 and rows >= 2",
      sqlType: "boolean",
      aggregateRefs: [
        { ref: "revenue", fieldId: amountFieldId, agg: "sum" },
        { ref: "rows", fieldId: "*", agg: "count" },
      ],
    });
  });

  test("query plan accepts formula aggregate arguments and having over their aliases", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        group by ordered_at by month
        aggregate sum(formula(amount - cost)) as margin
        having margin > 10
      `),
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.query.aggregations).toBeUndefined();
    expect(result.plan.formulaAggregations).toHaveLength(1);
    expect(result.plan.formulaAggregations?.[0]).toMatchObject({
      kind: "formula",
      id: "margin",
      ref: "margin",
      agg: "sum",
      source: "amount - cost",
      sqlType: "numeric",
    });
    expect(result.plan.formulaHaving?.aggregateRefs).toMatchObject([
      {
        kind: "formula",
        id: "margin",
        ref: "margin",
        agg: "sum",
      },
    ]);
  });

  test("query plan rejects incompatible formula aggregate arguments", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        group by ordered_at by month
        aggregate sum(formula(CONCAT(customer, 'x'))) as bad
      `),
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(['agg "sum" not compatible with formula type "text"']);
  });

  test("query plan rejects formula aggregate aliases before SQL alias generation", () => {
    const alias = "a".repeat(51);
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        group by ordered_at by month
        aggregate sum(formula(amount - cost)) as ${alias}
      `),
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((d) => d.message)).toEqual([`formula aggregate alias "${alias}" must be 50 characters or less`]);
    }
  });

  test("query plan rejects incompatible normal aggregate arguments before runtime compilation", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        group by ordered_at by month
        aggregate sum(customer) as total
      `),
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(['agg "sum" not compatible with field type "text"']);
  });

  test("query plan types system timestamp aggregates without treating system users as datetimes", () => {
    const context = ctx({ fieldsByTableId: { ...ctx().fieldsByTableId, [orders.id]: [...fields, createdAtField, createdByField] } });
    const timestamp = resolveDslQueryToQueryPlan(
      parseOk(`
        group by status
        aggregate latest(created_at) as last_created
      `),
      context,
    );
    expect(timestamp.ok).toBe(true);
    if (!timestamp.ok) return;

    const compiled = compileDslGroupedQueryPlanToSql(timestamp.plan, { fieldsByTableId: context.fieldsByTableId });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.query.columns.find((column) => column.key === `${createdAtFieldId}__latest`)).toMatchObject({
      kind: "aggregate",
      sqlType: "datetime",
    });

    const user = resolveDslQueryToQueryPlan(
      parseOk(`
        group by status
        aggregate latest(created_by) as last_user
      `),
      context,
    );
    expect(user.ok).toBe(false);
    if (!user.ok) expect(user.diagnostics.map((d) => d.message)).toEqual(['agg "latest" not compatible with field type "created_by"']);
  });

  test("query plan rejects having predicates over unknown aggregate aliases", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        group by ordered_at by month
        aggregate sum(amount) as revenue
        having missing > 100
      `),
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(['having formula: Unknown formula field reference "missing"']);
  });

  test("query plan rejects duplicate aggregate aliases before having can resolve ambiguously", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        group by ordered_at by month
        aggregate sum(amount) as metric, count(*) as metric
        having metric > 1
      `),
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toContain('duplicate aggregate alias "metric"');
  });

  test("query plan rejects aggregate aliases that differ only by case", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        group by ordered_at by month
        aggregate sum(amount) as Metric, count(*) as metric
        sort metric desc
      `),
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toContain('duplicate aggregate alias "metric"');
  });

  test("query plan rejects aggregate aliases that collide with visible refs", () => {
    const groupCollision = resolveDslQueryToQueryPlan(
      parseOk(`
        group by status
        aggregate sum(amount) as Status
        sort Status desc
      `),
      ctx(),
    );
    expect(groupCollision.ok).toBe(false);
    if (!groupCollision.ok)
      expect(groupCollision.diagnostics.map((d) => d.message)).toContain('aggregate alias "Status" conflicts with a group field');

    const sourceFieldCollision = resolveDslQueryToQueryPlan(parseOk(`aggregate sum(amount) as Status`), ctx());
    expect(sourceFieldCollision.ok).toBe(false);
    if (!sourceFieldCollision.ok)
      expect(sourceFieldCollision.diagnostics.map((d) => d.message)).toContain('aggregate alias "Status" conflicts with a source field');

    const joinAliasCollision = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        aggregate sum(amount) as customer
      `),
      ctx(),
    );
    expect(joinAliasCollision.ok).toBe(false);
    if (!joinAliasCollision.ok)
      expect(joinAliasCollision.diagnostics.map((d) => d.message)).toContain(
        'aggregate alias "customer" conflicts with an existing output alias',
      );
  });

  test("rejects duplicate aggregate output keys even when aliases differ", () => {
    const saved = resolveDslQueryToRecordQuery(
      parseOk(`
        group by ordered_at by month
        aggregate sum(amount) as revenue, sum(amount) as total
      `),
      ctx(),
    );
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.diagnostics.map((d) => d.message)).toContain('duplicate aggregate output for "Amount" with "sum"');

    const preview = resolveDslQueryToQueryPlan(
      parseOk(`
        group by ordered_at by month
        aggregate sum(amount) as revenue, sum(amount) as total
      `),
      ctx(),
    );
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.diagnostics.map((d) => d.message)).toContain('duplicate aggregate output for "Amount" with "sum"');
  });

  test("query plan rejects having without an effective grouped query", () => {
    const result = resolveDslQueryToQueryPlan(parseOk(`having true`), ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(["having requires a grouped query"]);
  });

  test("query plan resolves aggregate-only output for preview", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        where status = 'open'
        aggregate count(*) as rows, sum(amount) as revenue
      `),
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.query.filter).toEqual({ fieldId: statusFieldId, op: "is", value: "open" });
    expect(result.plan.query.groupBy).toBeUndefined();
    expect(result.plan.query.aggregations).toEqual([
      { fieldId: "*", agg: "count", label: "rows" },
      { fieldId: amountFieldId, agg: "sum", label: "revenue" },
    ]);
  });

  test("query plan resolves aggregate-only relation joins through the SQL grouped path", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        aggregate sum(customer.score) as total_score, sum(formula(amount + customer.score)) as weighted
      `),
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.query.aggregations).toBeUndefined();
    expect(result.plan.sqlGroupBy).toEqual([]);
    expect(result.plan.sqlAggregations).toEqual([
      { fieldId: customerScoreFieldId, tableId: customers.id, joinAlias: "customer", agg: "sum", label: "total_score" },
    ]);
    expect(result.plan.formulaAggregations?.map((aggregation) => aggregation.id)).toEqual(["weighted"]);
    expect(isDslAggregateOnlyPlan(result.plan)).toBe(true);

    const compiled = compileDslGroupedQueryPlanToSql(result.plan, { fieldsByTableId: ctx().fieldsByTableId });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const text = normalizedSql(compiled.query.sql);
    expect(text).toContain("JOIN grids.record_links");
    expect(text).not.toContain("GROUP BY");
    expect(compiled.query.columns.map((column) => column.key)).toEqual([`${customerScoreFieldId}__sum`, "weighted__sum"]);
  });

  test("aggregate-only plan classification follows the output shape", () => {
    const simple = resolveDslQueryToQueryPlan(parseOk(`aggregate count(*) as rows`), ctx());
    const joined = resolveDslQueryToQueryPlan(
      parseOk(`join table Custs as customer on customer_link = customer.id\naggregate sum(customer.score) as total_score`),
      ctx(),
    );
    const grouped = resolveDslQueryToQueryPlan(parseOk(`group by status\naggregate count(*) as rows`), ctx());

    expect(simple.ok && isDslAggregateOnlyPlan(simple.plan)).toBe(true);
    expect(joined.ok && isDslAggregateOnlyPlan(joined.plan)).toBe(true);
    expect(grouped.ok && isDslAggregateOnlyPlan(grouped.plan)).toBe(false);
  });

  test("query plan rejects ambiguous aggregate-only shapes", () => {
    const selected = resolveDslQueryToQueryPlan(parseOk(`select customer\naggregate count(*) as rows`), ctx());
    expect(selected.ok).toBe(false);
    if (!selected.ok) expect(selected.diagnostics.map((d) => d.message)).toContain("aggregate-only DSL queries cannot select row fields");

    const sorted = resolveDslQueryToQueryPlan(parseOk(`aggregate count(*) as rows\nsort rows desc`), ctx());
    expect(sorted.ok).toBe(false);
    if (!sorted.ok) expect(sorted.diagnostics.map((d) => d.message)).toContain("aggregate-only DSL queries cannot sort");

    const formulaAggregate = resolveDslQueryToQueryPlan(parseOk(`aggregate sum(formula(amount - cost)) as margin`), ctx());
    expect(formulaAggregate.ok).toBe(true);
    if (formulaAggregate.ok) expect(formulaAggregate.plan.formulaAggregations?.map((aggregation) => aggregation.id)).toEqual(["margin"]);
  });

  test("query plan maps grouped sort to group key direction and group aggregate sort", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        group by ordered_at by month
        aggregate sum(amount) as revenue
        sort ordered_at asc, revenue desc
      `),
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.query.groupBy).toEqual([{ fieldId: orderedAtFieldId, granularity: "month", direction: "asc" }]);
    expect(result.plan.query.groupSort).toEqual([{ fieldId: amountFieldId, agg: "sum", direction: "desc" }]);
    expect(result.plan.query.sort).toBeUndefined();
    expect(result.plan.sqlSort).toBeUndefined();
  });

  test("query plan preserves grouped null ordering", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        group by ordered_at by month
        aggregate sum(amount) as revenue
        sort ordered_at asc nulls first, revenue desc nulls first
      `),
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.query.groupBy).toEqual([{ fieldId: orderedAtFieldId, granularity: "month", direction: "asc", nullsFirst: true }]);
    expect(result.plan.query.groupSort).toEqual([{ fieldId: amountFieldId, agg: "sum", direction: "desc", nullsFirst: true }]);

    const compiled = compileDslGroupedQueryPlanToSql(result.plan, { fieldsByTableId: ctx().fieldsByTableId });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(normalizedSql(compiled.query.sql)).toContain('DESC NULLS FIRST, "gk_0" ASC NULLS FIRST');
  });

  test("query plan rejects grouped sort targets that cannot be represented by grouped SQL", () => {
    const missingGroup = resolveDslQueryToQueryPlan(
      parseOk(`
        group by ordered_at by month
        aggregate sum(amount) as revenue
        sort status asc
      `),
      ctx(),
    );
    expect(missingGroup.ok).toBe(false);
    if (!missingGroup.ok) {
      expect(missingGroup.diagnostics.map((d) => d.message)).toEqual(['grouped sort field "Status" must also be in group by']);
    }
  });

  test("query plan maps grouped formula aggregate sort aliases to groupSort", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        group by ordered_at by month
        aggregate sum(formula(amount - cost)) as margin
        sort margin desc
      `),
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.query.groupSort).toBeUndefined();
    expect(result.plan.formulaGroupSort).toEqual([{ fieldId: "margin", agg: "sum", direction: "desc" }]);
  });

  test("query plan preserves grouped formula aggregate null ordering", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        group by ordered_at by month
        aggregate sum(formula(amount - cost)) as margin
        sort margin desc nulls first
      `),
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.formulaGroupSort).toEqual([{ fieldId: "margin", agg: "sum", direction: "desc", nullsFirst: true }]);
  });

  test("query plan accepts relation-safe joins and joined select columns", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        select amount, customer.name as customer_name
      `),
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.joins).toMatchObject([
      {
        mode: "inner",
        alias: "customer",
        tableId: customers.id,
        fromScope: null,
        fromTableId: orders.id,
        relationFieldId: customerLinkFieldId,
        depth: 1,
      },
    ]);
    expect(result.plan.query.columns).toEqual([{ fieldId: amountFieldId }]);
    expect(result.plan.joinedColumns).toEqual([
      { joinAlias: "customer", tableId: customers.id, fieldId: customerNameFieldId, label: "customer_name" },
    ]);
  });

  test("query plan treats source aliases as the base table scope", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        from table Orders as o
        select o.amount as revenue
        sort o.amount desc
      `),
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.query.columns).toEqual([{ fieldId: amountFieldId, label: "revenue" }]);
    expect(result.plan.query.sort).toEqual([{ fieldId: amountFieldId, direction: "desc" }]);
    expect(result.plan.sqlSort).toEqual([{ kind: "field", fieldId: amountFieldId, direction: "desc" }]);
  });

  test("query plan supports self-joins through an explicit source alias", () => {
    const parentOrderFieldId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9";
    const scopedCtx = ctx({
      fieldsByTableId: {
        ...ctx().fieldsByTableId,
        [orders.id]: [
          ...fields,
          field({
            id: parentOrderFieldId,
            shortId: "parent_order",
            name: "Parent order",
            type: "relation",
            position: 8,
            config: { targetTableId: orders.id },
          }),
        ],
      },
    });
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        from table Orders as o
        join table Orders as parent on o.parent_order = parent.id
        select o.amount, parent.amount as parent_amount
      `),
      scopedCtx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.joins).toMatchObject([
      {
        alias: "parent",
        tableId: orders.id,
        fromScope: null,
        fromTableId: orders.id,
        relationFieldId: parentOrderFieldId,
      },
    ]);

    const compiled = compileDslQueryPlanToSql(result.plan, { fieldsByTableId: scopedCtx.fieldsByTableId });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.query.joinAliases).toEqual({ parent: "jq0" });
    const sqlText = normalizedSql(compiled.query.sql);
    expect(sqlText).toContain("jql0.from_record_id = r.id");
    expect(sqlText).toContain("jq0.table_id =");
  });

  test("query plan supports reverse relation joins", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        from table Custs as c
        join table Orders as order on order.customer_link = c.id
        select c.name as customer_name, order.amount as amount
        sort order.amount asc
      `),
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.joins).toMatchObject([
      {
        alias: "order",
        direction: "reverse",
        tableId: orders.id,
        fromScope: null,
        fromTableId: customers.id,
        relationFieldId: customerLinkFieldId,
      },
    ]);

    const compiled = compileDslQueryPlanToSql(result.plan, { fieldsByTableId: ctx().fieldsByTableId });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.query.joinAliases).toEqual({ order: "jq0" });
    const sqlText = normalizedSql(compiled.query.sql);
    expect(sqlText).toContain("jql0.to_record_id = r.id");
    expect(sqlText).toContain("jq0.id = jql0.from_record_id");
  });

  test("query plan rejects duplicate join aliases", () => {
    const ast = parseOk(`
        join table Custs as customer on customer_link = customer.id
        join table Custs as duplicate on customer_link = duplicate.id
      `);
    ast.joins[1]!.alias = "customer";
    ast.joins[1]!.on.right.scope = "customer";
    const result = resolveDslQueryToQueryPlan(ast, ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toContain('duplicate join alias "customer"');
  });

  test("query plan rejects select aliases that collide with join aliases", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        select amount as customer
      `),
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(['duplicate select alias "customer"']);
  });

  test("query plan rejects case-folded select alias collisions", () => {
    const duplicateSelect = resolveDslQueryToQueryPlan(parseOk(`select amount as Value, cost as value`), ctx());
    expect(duplicateSelect.ok).toBe(false);
    if (!duplicateSelect.ok) expect(duplicateSelect.diagnostics.map((d) => d.message)).toEqual(['duplicate select alias "value"']);

    const joinCollision = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        select amount as Customer
      `),
      ctx(),
    );
    expect(joinCollision.ok).toBe(false);
    if (!joinCollision.ok) expect(joinCollision.diagnostics.map((d) => d.message)).toEqual(['duplicate select alias "Customer"']);
  });

  test("query plan rejects join predicates that do not use the join alias on one side", () => {
    const ast = parseOk(`join table Custs as customer on customer_link = customer.id`);
    ast.joins[0]!.on.right.scope = undefined;
    ast.joins[0]!.on.right.ref = "customer_link";
    const result = resolveDslQueryToQueryPlan(ast, ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((d) => d.message)).toEqual(['join "customer" must compare one relation field to customer.id']);
    }
  });

  test("query plan matches join aliases case-insensitively", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as Customer on customer_link = customer.id
        select customer.name as customer_name
      `),
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.joins).toEqual([expect.objectContaining({ alias: "Customer", tableId: customers.id, fromScope: null })]);
    expect(result.plan.joinedColumns).toEqual([
      { joinAlias: "Customer", tableId: customers.id, fieldId: customerNameFieldId, label: "customer_name" },
    ]);
  });

  test("query plan accepts sorting by joined select aliases", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        select customer.name as customer_name
        sort customer_name asc
      `),
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.sqlSort).toEqual([{ kind: "joined", alias: "customer_name", direction: "asc" }]);
  });

  test("query plan accepts sorting by scoped joined fields without selecting them", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        select amount
        sort customer.name asc
      `),
      ctx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.query.sort).toBeUndefined();
    expect(result.plan.sqlSort).toEqual([
      { kind: "joinedField", joinAlias: "customer", tableId: customers.id, fieldId: customerNameFieldId, direction: "asc" },
    ]);
  });

  test("query plan accepts scoped joined fields inside row formula expressions", () => {
    const ast = parseOk(`
      join table Custs as customer on customer_link = customer.id
      select formula(amount + customer.score) as weighted
      where customer.score > cost
      sort weighted desc
    `);

    const result = resolveDslQueryToQueryPlan(ast, ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.query.columns).toEqual([
      {
        kind: "computed",
        id: expect.stringMatching(/^computed_[A-Za-z0-9]{5,32}$/),
        label: "weighted",
        expression: "amount + customer.score",
      },
    ]);
    expect(result.plan.wherePredicate).toMatchObject({ kind: "formula" });
    expect(result.plan.sqlSort).toEqual([{ kind: "computed", alias: "weighted", direction: "desc" }]);

    const compiled = compileDslQueryPlanToSql(result.plan, { fieldsByTableId: ctx().fieldsByTableId });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const sqlText = normalizedSql(compiled.query.sql);
    expect(sqlText).toContain("grids.canonical_numeric(r.data->>");
    expect(sqlText).toContain("grids.canonical_numeric(jq0.data->>");
  });

  test("query plan rejects unsupported scoped formula refs with direct diagnostics", () => {
    const unknownScope = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        select formula(account.name) as bad
      `),
      ctx(),
    );
    expect(unknownScope.ok).toBe(false);
    if (!unknownScope.ok) expect(unknownScope.diagnostics.map((d) => d.message)).toEqual(['select "bad": Unknown formula scope "account"']);

    const relationValue = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        select formula(customer.region) as bad
      `),
      ctx(),
    );
    expect(relationValue.ok).toBe(false);
    if (!relationValue.ok)
      expect(relationValue.diagnostics.map((d) => d.message)).toEqual([
        'select "bad": Field "customer.region" (relation) cannot be used as a scalar formula value',
      ]);
  });

  test("compile-view rejects scoped computed formulas instead of persisting GQL-only refs", () => {
    const result = resolveDslQueryToRecordQuery(
      parseOk(`
        from table Orders as o
        select formula(o.amount * 2) as doubled
      `),
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((d) => d.message)).toEqual([
        "computed formulas with scoped field refs cannot be represented by the records-table runtime yet",
      ]);
    }
  });

  test("query plan rejects join targets that are not exposed to the resolver", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`join table Custs as customer on customer_link = customer.id`),
      ctx({ tables: [orders] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(['source "Custs" is not available']);
  });

  test("query plan rejects relation field output when the target table is not readable", () => {
    const lookupField = field({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa20",
      shortId: "customer_name",
      name: "Customer name",
      type: "lookup",
      position: 8,
      config: { relationFieldId: customerLinkFieldId, targetFieldId: customerNameFieldId },
    });
    const unreadableTarget = ctx({
      tables: [orders],
      fieldsByTableId: { [orders.id]: [...fields, lookupField] },
    });

    const selected = resolveDslQueryToQueryPlan(parseOk(`select customer_link`), unreadableTarget);
    expect(selected.ok).toBe(false);
    if (!selected.ok) {
      expect(selected.diagnostics.map((d) => d.message)).toEqual(['relation field "Customer link" target table is not available']);
    }

    const grouped = resolveDslQueryToQueryPlan(parseOk(`group by customer_link\naggregate count(*) as rows`), unreadableTarget);
    expect(grouped.ok).toBe(false);
    if (!grouped.ok) {
      expect(grouped.diagnostics.map((d) => d.message)).toEqual(['relation field "Customer link" target table is not available']);
    }

    const selectedLookup = resolveDslQueryToQueryPlan(parseOk(`select customer_name`), unreadableTarget);
    expect(selectedLookup.ok).toBe(false);
    if (!selectedLookup.ok) {
      expect(selectedLookup.diagnostics.map((d) => d.message)).toEqual(['lookup field "Customer name" target table is not available']);
    }
  });

  test("query plan omits unreadable relation fields from implicit row output", () => {
    const lookupField = field({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa20",
      shortId: "customer_name",
      name: "Customer name",
      type: "lookup",
      position: 8,
      config: { relationFieldId: customerLinkFieldId, targetFieldId: customerNameFieldId },
    });
    const unreadableTarget = ctx({
      tables: [orders],
      fieldsByTableId: { [orders.id]: [...fields, lookupField] },
    });
    const resolved = resolveDslQueryToQueryPlan(parseOk(`limit 10`), unreadableTarget);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.plan.query.columns?.map((column) => ("fieldId" in column ? column.fieldId : column.id))).toEqual([
      customerFieldId,
      amountFieldId,
      costFieldId,
      statusFieldId,
      orderedAtFieldId,
      paidFieldId,
    ]);
  });

  test("query plan rejects arbitrary joins that do not start from a relation field", () => {
    const result = resolveDslQueryToQueryPlan(parseOk(`join table Custs as customer on customer = customer.id`), ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(['join "customer" must start from a relation field']);
  });

  test("query plan rejects joins whose target table does not match the relation field", () => {
    const result = resolveDslQueryToQueryPlan(parseOk(`join table Regs as region on customer_link = region.id`), ctx());

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics.map((d) => d.message)).toEqual(['join "region" target table does not match the relation field']);
  });

  test("query plan rejects joins against non-record-id target refs", () => {
    const result = resolveDslQueryToQueryPlan(parseOk(`join table Custs as customer on customer_link = customer.name`), ctx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(['join "customer" must target customer.id']);
  });

  test("query plan caps join count and join depth", () => {
    const tooMany = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as c1 on customer_link = c1.id
        join table Custs as c2 on customer_link = c2.id
        join table Custs as c3 on customer_link = c3.id
        join table Custs as c4 on customer_link = c4.id
        join table Custs as c5 on customer_link = c5.id
        join table Custs as c6 on customer_link = c6.id
      `),
      ctx(),
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.diagnostics.map((d) => d.message)).toContain("query can join at most 5 tables");

    const tooDeep = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        join table Regs as region on customer.region = region.id
        join table Cities as city on region.city = city.id
        join table Cntrs as country on city.country = country.id
      `),
      ctx(),
    );
    expect(tooDeep.ok).toBe(false);
    if (!tooDeep.ok) expect(tooDeep.diagnostics.map((d) => d.message)).toContain("join depth exceeds 3");
  });

  test("SQL compiler turns relation-safe joins into row-query metadata", () => {
    const resolved = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        select amount, customer.name as customer_name, formula(amount - cost) as margin
        where amount > cost * 1.10
        sort amount desc, customer_name asc
        limit 25
        offset 10
      `),
      ctx(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const compiled = compileDslQueryPlanToSql(resolved.plan, {
      fieldsByTableId: ctx().fieldsByTableId,
      timeZone: "Europe/Berlin",
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.query.limit).toBe(25);
    expect(compiled.query.offset).toBe(10);
    expect(compiled.query.joinAliases).toEqual({ customer: "jq0" });
    expect(compiled.query.columns).toEqual([
      {
        key: "q_col_0",
        label: "Amount",
        tableId: orders.id,
        fieldId: amountFieldId,
        type: "number",
        sqlType: "numeric",
      },
      {
        key: "q_col_1",
        label: "customer_name",
        tableId: customers.id,
        fieldId: customerNameFieldId,
        joinAlias: "customer",
        type: "text",
        sqlType: "text",
      },
      {
        key: "q_col_2",
        label: "margin",
        tableId: "",
        type: "formula",
        sqlType: "numeric",
      },
    ]);
    expect(typeof compiled.query.sql).toBe("object");
    const text = normalizedSql(compiled.query.sql);
    expect(text).toContain("ORDER BY grids.canonical_numeric(r.data->>");
    expect(text).toContain(" DESC NULLS LAST, jq0.data->>");
    expect(text).toContain(" ASC NULLS LAST, r.id DESC NULLS LAST, jq0.id DESC NULLS LAST");
  });

  test("SQL compiler can cap relation join fanout for preview queries", () => {
    const resolved = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        select amount, customer.name as customer_name
      `),
      ctx(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const compiled = compileDslQueryPlanToSql(resolved.plan, {
      fieldsByTableId: ctx().fieldsByTableId,
      joinFanoutLimit: 50,
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const { text, values } = normalizedSqlParts(compiled.query.sql);
    expect(text).toContain("JOIN LATERAL");
    expect(text).toContain("FROM grids.record_links _dsl_link");
    expect(text).toContain("ORDER BY _dsl_link.to_record_id");
    expect(values).toContain(50);
  });

  test("SQL compiler accepts computed alias sorts and preserves mixed sort order in metadata", () => {
    const resolved = resolveDslQueryToQueryPlan(
      parseOk(`
        select amount, formula(amount - cost) as margin
        sort margin desc, amount asc
      `),
      ctx(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.plan.query.sort).toEqual([{ fieldId: amountFieldId, direction: "asc" }]);
    expect(resolved.plan.sqlSort).toEqual([
      { kind: "computed", alias: "margin", direction: "desc" },
      { kind: "field", fieldId: amountFieldId, direction: "asc" },
    ]);

    const compiled = compileDslQueryPlanToSql(resolved.plan, {
      fieldsByTableId: ctx().fieldsByTableId,
      timeZone: "Europe/Berlin",
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.query.columns.map((column) => column.label)).toEqual(["Amount", "margin"]);
    const text = normalizedSql(compiled.query.sql);
    expect(text).toContain("ORDER BY ((grids.canonical_numeric");
    expect(text).toContain("DESC NULLS LAST, grids.canonical_numeric");
    expect(text).toContain("ASC NULLS LAST, r.id DESC NULLS LAST");
  });

  test("SQL compiler accepts scoped joined field sorts without selecting the sorted field", () => {
    const resolved = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        select amount
        sort customer.name asc
      `),
      ctx(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const compiled = compileDslQueryPlanToSql(resolved.plan, {
      fieldsByTableId: ctx().fieldsByTableId,
      timeZone: "Europe/Berlin",
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.query.columns.map((column) => column.label)).toEqual(["Amount"]);
    const text = normalizedSql(compiled.query.sql);
    expect(text).toContain("ORDER BY jq0.data->>");
    expect(text).toContain("ASC NULLS LAST");
  });

  test("SQL compiler accepts joined rows with base literal filters", () => {
    const resolved = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        select amount, customer.name as customer_name
        where amount > 10
      `),
      ctx(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const compiled = compileDslQueryPlanToSql(resolved.plan, {
      fieldsByTableId: ctx().fieldsByTableId,
      timeZone: "Europe/Berlin",
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.query.joinAliases).toEqual({ customer: "jq0" });
    expect(compiled.query.columns.map((column) => column.label)).toEqual(["Amount", "customer_name"]);
  });

  test("SQL compiler selects SQL-projectable formula fields", () => {
    const formulaField = field({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
      shortId: "total",
      name: "Total",
      type: "formula",
      position: 9,
      config: { expression: "amount - cost" },
    });
    const resolved = resolveDslQueryToQueryPlan(
      parseOk(`select total`),
      ctx({ fieldsByTableId: { ...ctx().fieldsByTableId, [orders.id]: [...fields, formulaField] } }),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const compiled = compileDslQueryPlanToSql(resolved.plan, {
      fieldsByTableId: { ...ctx().fieldsByTableId, [orders.id]: [...fields, formulaField] },
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.query.columns).toEqual([
      {
        key: "q_col_0",
        label: "Total",
        tableId: orders.id,
        fieldId: formulaField.id,
        type: "formula",
        sqlType: "numeric",
      },
    ]);
    const text = normalizedSql(compiled.query.sql);
    expect(text).toContain("AS q_col_0");
    expect(text).toContain("grids.canonical_numeric");
  });

  test("SQL compiler rejects formula field selects without a SQL-projectable expression", () => {
    const formulaField = field({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
      shortId: "total",
      name: "Total",
      type: "formula",
      position: 9,
    });
    const resolved = resolveDslQueryToQueryPlan(
      parseOk(`select total`),
      ctx({ fieldsByTableId: { ...ctx().fieldsByTableId, [orders.id]: [...fields, formulaField] } }),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const compiled = compileDslQueryPlanToSql(resolved.plan, {
      fieldsByTableId: { ...ctx().fieldsByTableId, [orders.id]: [...fields, formulaField] },
    });

    expect(compiled).toEqual({ ok: false, error: 'formula field "Total" has no expression' });
  });

  test("SQL compiler includes projectable formula fields and skips file fields for implicit default selects", () => {
    const formulaField = field({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
      shortId: "total",
      name: "Total",
      type: "formula",
      position: 9,
      config: { expression: "amount - cost" },
    });
    const fileField = field({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10",
      shortId: "files",
      name: "Files",
      type: "file",
      position: 10,
    });
    const fieldsByTableId = { ...ctx().fieldsByTableId, [orders.id]: [...fields, formulaField, fileField] };
    const resolved = resolveDslQueryToQueryPlan(parseOk(`limit 10`), ctx({ fieldsByTableId }));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const compiled = compileDslQueryPlanToSql(resolved.plan, { fieldsByTableId });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.query.columns.map((column) => column.label)).toEqual([
      "Customer",
      "Amount",
      "Cost",
      "Status",
      "Ordered at",
      "Paid",
      "Customer link",
      "Total",
    ]);
  });

  test("source-only queries keep their default projection when limit is inline", () => {
    const resolved = resolveDslQueryToQueryPlan(parseOk(`from table Orders limit 2`), ctx());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const compiled = compileDslQueryPlanToSql(resolved.plan, { fieldsByTableId: ctx().fieldsByTableId });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.query.limit).toBe(2);
    expect(compiled.query.columns.map((column) => column.label)).toEqual([
      "Customer",
      "Amount",
      "Cost",
      "Status",
      "Ordered at",
      "Paid",
      "Customer link",
    ]);
  });

  test("source-only view queries keep their default projection when limit is inline", () => {
    const context = ctx({
      views: [
        {
          kind: "view",
          id: "33333333-3333-4333-8333-333333333333",
          shortId: "AllOrders",
          name: "All orders",
          tableId: orders.id,
          query: {},
        },
      ],
    });
    const resolved = resolveDslQueryToQueryPlan(parseOk(`from view "All orders" limit 2`), context);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const compiled = compileDslQueryPlanToSql(resolved.plan, { fieldsByTableId: context.fieldsByTableId });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.query.limit).toBe(2);
    expect(compiled.query.columns.map((column) => column.label)).toEqual([
      "Customer",
      "Amount",
      "Cost",
      "Status",
      "Ordered at",
      "Paid",
      "Customer link",
    ]);
  });

  test("SQL compiler clamps limits and rejects grouped row execution", () => {
    const resolved = resolveDslQueryToQueryPlan(
      parseOk(`
        select amount
        limit 25
        offset 100
      `),
      ctx(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    resolved.plan.offset = 10001;

    const compiled = compileDslQueryPlanToSql(resolved.plan, {
      fieldsByTableId: ctx().fieldsByTableId,
      limit: 99_999,
    });

    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.query.limit).toBe(10_000);
      expect(compiled.query.offset).toBe(10_000);
    }

    const grouped = resolveDslQueryToQueryPlan(
      parseOk(`
        group by ordered_at by month
        aggregate sum(amount) as revenue
      `),
      ctx(),
    );
    expect(grouped.ok).toBe(true);
    if (!grouped.ok) return;
    const groupedCompiled = compileDslQueryPlanToSql(grouped.plan, { fieldsByTableId: ctx().fieldsByTableId });
    expect(groupedCompiled).toEqual({ ok: false, error: "grouped DSL query execution is not compiled by the row-query compiler yet" });
  });

  test("SQL compiler includes record metadata filters in row queries", () => {
    const recordId = "REC001";
    const resolved = resolveDslQueryToQueryPlan(
      parseOk(`
        select amount
        where record.id = '${recordId}'
      `),
      ctx(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const compiled = compileDslQueryPlanToSql(resolved.plan, { fieldsByTableId: ctx().fieldsByTableId });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const { text, values } = normalizedSqlParts(compiled.query.sql);
    expect(text).toContain("r.short_id = ANY");
    expect(values.some((value) => String(value).includes(recordId))).toBe(true);
  });

  test("aggregate-only SQL compiler emits one aggregate result row", () => {
    const resolved = resolveDslQueryToQueryPlan(
      parseOk(`
        where amount > cost
        aggregate count(*) as rows, sum(amount) as revenue, latest(ordered_at) as last_order, sum(formula(amount - cost)) as margin
      `),
      ctx(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const compiled = compileDslAggregateQueryPlanToSql(resolved.plan, {
      fieldsByTableId: ctx().fieldsByTableId,
      timeZone: "Europe/Berlin",
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.query.limit).toBe(1);
    expect(compiled.query.offset).toBe(0);
    expect(compiled.query.columns).toEqual([
      { key: "*__count", label: "rows", fieldId: "*", agg: "count", sqlType: "numeric" },
      { key: `${amountFieldId}__sum`, label: "revenue", fieldId: amountFieldId, agg: "sum", sqlType: "numeric" },
      { key: `${orderedAtFieldId}__latest`, label: "last_order", fieldId: orderedAtFieldId, agg: "latest", sqlType: "date" },
      { key: "margin__sum", label: "margin", fieldId: "margin", agg: "sum", sqlType: "numeric" },
    ]);
    const { text, values } = normalizedSqlParts(compiled.query.sql);
    expect(text).toContain("SELECT jsonb_build_object");
    expect(text).toContain("COUNT(*)");
    expect(text).toContain("SUM(");
    expect(text).toContain("grids.canonical_date");
    expect(values).toContain("margin__sum");
    expect(text).toContain("r.table_id =");
    expect(text).toContain("r.deleted_at IS NULL");
  });

  test("aggregate-only SQL compiler aggregates the full matching set", () => {
    const resolved = resolveDslQueryToQueryPlan(
      parseOk(`
        where amount > cost
        aggregate sum(amount) as revenue
      `),
      ctx(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const compiled = compileDslAggregateQueryPlanToSql(resolved.plan, {
      fieldsByTableId: ctx().fieldsByTableId,
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const { text, values } = normalizedSqlParts(compiled.query.sql);
    expect(text).toContain("FROM grids.records r");
    expect(text).not.toContain("SELECT r.*");
    expect(text).not.toContain("ORDER BY r.id ASC");
    expect(values).not.toContain(5000);
  });

  test("aggregate-only SQL compiler accepts formula-only aggregate output", () => {
    const resolved = resolveDslQueryToQueryPlan(
      parseOk(`
        where amount > cost
        aggregate sum(formula(amount - cost)) as margin
      `),
      ctx(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const compiled = compileDslAggregateQueryPlanToSql(resolved.plan, {
      fieldsByTableId: ctx().fieldsByTableId,
      timeZone: "Europe/Berlin",
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.query.columns).toEqual([{ key: "margin__sum", label: "margin", fieldId: "margin", agg: "sum", sqlType: "numeric" }]);
    const { text, values } = normalizedSqlParts(compiled.query.sql);
    expect(text).toContain("SELECT jsonb_build_object");
    expect(text).toContain("SUM(");
    expect(values).toContain("margin__sum");
  });

  test("preview limit keeps DSL limits inside the preview contract", () => {
    const resolved = resolveDslQueryToQueryPlan(parseOk("limit 9999"), ctx());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    expect(resolveDslPreviewLimit(resolved.plan, undefined)).toBe(500);
    expect(resolveDslPreviewLimit(resolved.plan, 25)).toBe(25);
  });

  test("grouped SQL compiler delegates grouped DSL plans to the group compiler", () => {
    const resolved = resolveDslQueryToQueryPlan(
      parseOk(`
        where amount > cost * 1.10
        group by ordered_at by month
        aggregate sum(formula(amount - cost)) as margin
        having margin > 100
        sort margin desc
        limit 12
        offset 2
      `),
      ctx(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const compiled = compileDslGroupedQueryPlanToSql(resolved.plan, {
      fieldsByTableId: ctx().fieldsByTableId,
      timeZone: "Europe/Berlin",
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.query.limit).toBe(12);
    expect(compiled.query.offset).toBe(2);
    expect(compiled.query.cursorable).toBe(true);
    expect(typeof compiled.query.cursorValuesFromRow).toBe("function");
    expect(compiled.query.columns).toEqual([
      {
        kind: "group",
        key: "gk_0",
        label: "Ordered at",
        fieldId: orderedAtFieldId,
        tableId: orders.id,
        type: "date",
        sqlType: "date",
      },
      {
        kind: "aggregate",
        key: "margin__sum",
        label: "margin",
        fieldId: "margin",
        agg: "sum",
        sqlType: "numeric",
      },
    ]);
    expect(typeof compiled.query.sql).toBe("object");
    expect(normalizedSql(compiled.query.sql)).toContain('ORDER BY "margin__sum" DESC NULLS LAST, "gk_0" ASC NULLS LAST');
  });

  test("grouped SQL compiler aggregates the full matching set", () => {
    const resolved = resolveDslQueryToQueryPlan(
      parseOk(`
        group by ordered_at by month
        aggregate sum(amount) as revenue
      `),
      ctx(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const compiled = compileDslGroupedQueryPlanToSql(resolved.plan, {
      fieldsByTableId: ctx().fieldsByTableId,
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const { text, values } = normalizedSqlParts(compiled.query.sql);
    expect(text).toContain("FROM grids.records r");
    expect(text).not.toContain("SELECT r.*");
    expect(text).not.toContain("ORDER BY r.id ASC");
    expect(values).not.toContain(5000);
  });

  test("grouped SQL compiler keeps group and aggregate output metadata typed", () => {
    const resolved = resolveDslQueryToQueryPlan(
      parseOk(`
        group by status, customer_link
        aggregate min(customer) as first_customer, max(ordered_at) as latest_order
      `),
      ctx(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const compiled = compileDslGroupedQueryPlanToSql(resolved.plan, {
      fieldsByTableId: ctx().fieldsByTableId,
      timeZone: "Europe/Berlin",
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const groupedSql = normalizedSql(compiled.query.sql);
    expect(groupedSql).toContain("->>0");
    expect(groupedSql).not.toContain("jsonb_array_elements_text");
    expect(compiled.query.columns).toEqual([
      {
        kind: "group",
        key: "gk_0",
        label: "Status",
        fieldId: statusFieldId,
        tableId: orders.id,
        type: "select",
        sqlType: "text",
      },
      {
        kind: "group",
        key: "gk_1",
        label: "Customer link",
        fieldId: customerLinkFieldId,
        tableId: orders.id,
        type: "relation",
        sqlType: "text",
      },
      {
        kind: "aggregate",
        key: `${customerFieldId}__min`,
        label: "first_customer",
        fieldId: customerFieldId,
        agg: "min",
        sqlType: "text",
      },
      {
        kind: "aggregate",
        key: `${orderedAtFieldId}__max`,
        label: "latest_order",
        fieldId: orderedAtFieldId,
        agg: "max",
        sqlType: "date",
      },
    ]);
  });

  test("grouped SQL compiler rejects select output but supports relation joins", () => {
    const selected = resolveDslQueryToQueryPlan(
      parseOk(`
        select amount
        group by ordered_at by month
        aggregate sum(amount) as revenue
      `),
      ctx(),
    );
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(compileDslGroupedQueryPlanToSql(selected.plan, { fieldsByTableId: ctx().fieldsByTableId })).toEqual({
        ok: false,
        error: "grouped DSL queries use group and aggregate output, not select columns",
      });
    }

    const groupedByJoin = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        group by customer.name
        aggregate sum(amount) as revenue
        sort customer.name desc, revenue desc
      `),
      ctx(),
    );
    expect(groupedByJoin.ok).toBe(true);
    if (!groupedByJoin.ok) return;
    expect(groupedByJoin.plan.sqlGroupBy).toEqual([
      { fieldId: customerNameFieldId, tableId: customers.id, joinAlias: "customer", label: "Name", direction: "desc" },
    ]);
    expect(groupedByJoin.plan.sqlAggregations).toEqual([{ fieldId: amountFieldId, tableId: orders.id, agg: "sum", label: "revenue" }]);
    expect(groupedByJoin.plan.sqlGroupSort).toEqual([{ fieldId: amountFieldId, agg: "sum", direction: "desc" }]);
    const groupedByJoinSql = compileDslGroupedQueryPlanToSql(groupedByJoin.plan, { fieldsByTableId: ctx().fieldsByTableId });
    expect(groupedByJoinSql.ok).toBe(true);
    if (!groupedByJoinSql.ok) return;
    expect(normalizedSql(groupedByJoinSql.query.sql)).toContain("GROUP BY 1");
    const groupedByJoinText = normalizedSql(groupedByJoinSql.query.sql);
    expect(groupedByJoinText).toContain(`ORDER BY "${amountFieldId}__sum" DESC NULLS LAST, "gk_0" DESC NULLS LAST`);

    const joinedAggregate = resolveDslQueryToQueryPlan(
      parseOk(`
        from table Custs as c
        join table Orders as order on order.customer_link = c.id
        group by c.name
        aggregate sum(order.amount) as revenue
        sort revenue desc
      `),
      ctx(),
    );
    expect(joinedAggregate.ok).toBe(true);
    if (!joinedAggregate.ok) return;
    expect(joinedAggregate.plan.sqlAggregations).toEqual([
      { fieldId: amountFieldId, tableId: orders.id, joinAlias: "order", agg: "sum", label: "revenue" },
    ]);
    expect(joinedAggregate.plan.sqlGroupSort).toEqual([{ fieldId: amountFieldId, agg: "sum", direction: "desc" }]);
    const joinedAggregateSql = compileDslGroupedQueryPlanToSql(joinedAggregate.plan, { fieldsByTableId: ctx().fieldsByTableId });
    expect(joinedAggregateSql.ok).toBe(true);
    if (!joinedAggregateSql.ok) return;
    expect(normalizedSql(joinedAggregateSql.query.sql)).toContain("SUM(grids.canonical_numeric(jq0.data->>");

    const joinedFormulaAggregate = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        group by customer.name
        aggregate sum(formula(amount + customer.score)) as margin
        having margin > 0
        sort margin desc
      `),
      ctx(),
    );
    expect(joinedFormulaAggregate.ok).toBe(true);
    if (!joinedFormulaAggregate.ok) return;
    expect(joinedFormulaAggregate.plan.formulaAggregations).toMatchObject([
      {
        kind: "formula",
        id: "margin",
        ref: "margin",
        agg: "sum",
        source: "amount + customer.score",
        sqlType: "numeric",
      },
    ]);
    expect(joinedFormulaAggregate.plan.sqlGroupSort).toEqual([{ fieldId: "margin", agg: "sum", direction: "desc" }]);
    const joinedFormulaAggregateSql = compileDslGroupedQueryPlanToSql(joinedFormulaAggregate.plan, {
      fieldsByTableId: ctx().fieldsByTableId,
    });
    expect(joinedFormulaAggregateSql.ok).toBe(true);
    if (!joinedFormulaAggregateSql.ok) return;
    const joinedFormulaAggregateSqlText = normalizedSql(joinedFormulaAggregateSql.query.sql);
    expect(joinedFormulaAggregateSqlText).toContain('"margin__sum"');
    expect(joinedFormulaAggregateSqlText).toContain("grids.canonical_numeric(jq0.data->>");
    expect(joinedFormulaAggregateSqlText).toContain('ORDER BY "margin__sum" DESC NULLS LAST, "gk_0" ASC NULLS LAST');
  });

  test("grouped relation joins reject sort targets outside grouped output", () => {
    const result = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        group by customer.name
        aggregate sum(amount) as revenue
        sort amount desc
      `),
      ctx(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(['grouped sort field "Amount" must also be in group by']);
  });

  test("grouped relation joins support exploded and computed joined group fields with guardrails", () => {
    const customerTierFieldId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9";
    const customerTagsFieldId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4";
    const customerFormulaFieldId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5";
    const customerLookupFieldId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6";
    const customerRollupFieldId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7";
    const customerBadFormulaFieldId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb8";
    const context = ctx({
      fieldsByTableId: {
        ...ctx().fieldsByTableId,
        [customers.id]: [
          ...customerFields,
          field({
            id: customerTierFieldId,
            tableId: customers.id,
            shortId: "tier",
            name: "Tier",
            type: "select",
            config: { multiple: false, options: [{ id: "gold", label: "Gold" }] },
            position: 3,
          }),
          field({
            id: customerTagsFieldId,
            tableId: customers.id,
            shortId: "tags",
            name: "Tags",
            type: "select",
            config: { multiple: true, options: [{ id: "vip", label: "VIP" }] },
            position: 4,
          }),
          field({
            id: customerFormulaFieldId,
            tableId: customers.id,
            shortId: "score_x2",
            name: "Score x2",
            type: "formula",
            config: { expression: "score * 2" },
            position: 5,
          }),
          field({
            id: customerBadFormulaFieldId,
            tableId: customers.id,
            shortId: "bad_formula",
            name: "Bad formula",
            type: "formula",
            config: { expression: "tags" },
            position: 6,
          }),
          field({
            id: customerLookupFieldId,
            tableId: customers.id,
            shortId: "lookup_total",
            name: "Lookup total",
            type: "lookup",
            config: { relationFieldId: customerRegionFieldId },
            position: 7,
          }),
          field({
            id: customerRollupFieldId,
            tableId: customers.id,
            shortId: "rollup_total",
            name: "Rollup total",
            type: "rollup",
            config: { relationFieldId: customerRegionFieldId },
            position: 8,
          }),
        ],
      },
    });
    const joinedComputedSql = new Map<string, Map<string, FormulaSqlExpression>>([
      [
        "customer",
        new Map([
          [customerLookupFieldId, { sql: sql`(SELECT 7)`, type: "numeric" }],
          [customerRollupFieldId, { sql: sql`(SELECT 11)`, type: "numeric" }],
        ]),
      ],
    ]);

    const relation = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        group by customer.region
        aggregate count(*) as rows
      `),
      context,
    );
    expect(relation.ok).toBe(true);
    if (!relation.ok) return;
    expect(relation.plan.sqlGroupBy).toEqual([
      { fieldId: customerRegionFieldId, tableId: customers.id, joinAlias: "customer", label: "Region" },
    ]);
    const relationSql = compileDslGroupedQueryPlanToSql(relation.plan, { fieldsByTableId: context.fieldsByTableId });
    expect(relationSql.ok).toBe(true);
    if (!relationSql.ok) return;
    expect(normalizedSql(relationSql.query.sql)).toContain("JOIN grids.record_links jg_rl_0");

    const singleSelect = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        group by customer.tier
        aggregate count(*) as rows
      `),
      context,
    );
    expect(singleSelect.ok).toBe(true);
    if (!singleSelect.ok) return;
    const singleSelectSql = compileDslGroupedQueryPlanToSql(singleSelect.plan, { fieldsByTableId: context.fieldsByTableId });
    expect(singleSelectSql.ok).toBe(true);
    if (!singleSelectSql.ok) return;
    const singleSelectText = normalizedSql(singleSelectSql.query.sql);
    expect(singleSelectText).toContain("->>0");
    expect(singleSelectText).not.toContain("jsonb_array_elements_text");

    const multiSelect = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        group by customer.tags
        aggregate count(*) as rows
      `),
      context,
    );
    expect(multiSelect.ok).toBe(true);
    if (!multiSelect.ok) return;
    expect(multiSelect.plan.sqlGroupBy).toEqual([
      { fieldId: customerTagsFieldId, tableId: customers.id, joinAlias: "customer", label: "Tags" },
    ]);
    const multiSelectSql = compileDslGroupedQueryPlanToSql(multiSelect.plan, { fieldsByTableId: context.fieldsByTableId });
    expect(multiSelectSql.ok).toBe(true);
    if (!multiSelectSql.ok) return;
    expect(normalizedSql(multiSelectSql.query.sql)).toContain("CROSS JOIN LATERAL jsonb_array_elements_text");

    const formula = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        group by customer.score_x2
        aggregate count(*) as rows
      `),
      context,
    );
    expect(formula.ok).toBe(true);
    if (!formula.ok) return;
    const formulaSql = compileDslGroupedQueryPlanToSql(formula.plan, { fieldsByTableId: context.fieldsByTableId });
    expect(formulaSql.ok).toBe(true);
    if (!formulaSql.ok) return;
    expect(normalizedSql(formulaSql.query.sql)).toContain("grids.canonical_numeric(jq0.data->>");

    const lookup = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        group by customer.lookup_total
        aggregate count(*) as rows
      `),
      context,
    );
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    const lookupSql = compileDslGroupedQueryPlanToSql(lookup.plan, {
      fieldsByTableId: context.fieldsByTableId,
      computedFieldSqlByJoinAlias: joinedComputedSql,
    });
    expect(lookupSql.ok).toBe(true);
    if (!lookupSql.ok) return;
    expect(normalizedSql(lookupSql.query.sql)).toContain("(SELECT 7) AS gk_0");

    const rollup = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        group by customer.rollup_total
        aggregate count(*) as rows
      `),
      context,
    );
    expect(rollup.ok).toBe(true);
    if (!rollup.ok) return;
    const rollupSql = compileDslGroupedQueryPlanToSql(rollup.plan, {
      fieldsByTableId: context.fieldsByTableId,
      computedFieldSqlByJoinAlias: joinedComputedSql,
    });
    expect(rollupSql.ok).toBe(true);
    if (!rollupSql.ok) return;
    expect(normalizedSql(rollupSql.query.sql)).toContain("(SELECT 11) AS gk_0");

    const nullsFirst = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        group by customer.lookup_total
        aggregate count(*) as rows
        sort customer.lookup_total desc nulls first
      `),
      context,
    );
    expect(nullsFirst.ok).toBe(true);
    if (!nullsFirst.ok) return;
    const nullsFirstSql = compileDslGroupedQueryPlanToSql(nullsFirst.plan, {
      fieldsByTableId: context.fieldsByTableId,
      computedFieldSqlByJoinAlias: joinedComputedSql,
    });
    expect(nullsFirstSql.ok).toBe(true);
    if (!nullsFirstSql.ok) return;
    expect(normalizedSql(nullsFirstSql.query.sql)).toContain('ORDER BY "gk_0" DESC NULLS FIRST');

    const joinedSelect = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        select customer.lookup_total as lookup_value
      `),
      context,
    );
    expect(joinedSelect.ok).toBe(true);
    if (!joinedSelect.ok) return;
    const joinedSelectSql = compileDslQueryPlanToSql(joinedSelect.plan, {
      fieldsByTableId: context.fieldsByTableId,
      computedFieldSqlByJoinAlias: joinedComputedSql,
    });
    expect(joinedSelectSql.ok).toBe(true);
    if (!joinedSelectSql.ok) return;
    expect(normalizedSql(joinedSelectSql.query.sql)).toContain("(SELECT 7) AS q_col_0");

    const joinedSort = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        select customer.name
        sort customer.rollup_total desc nulls first
      `),
      context,
    );
    expect(joinedSort.ok).toBe(true);
    if (!joinedSort.ok) return;
    const joinedSortSql = compileDslQueryPlanToSql(joinedSort.plan, {
      fieldsByTableId: context.fieldsByTableId,
      computedFieldSqlByJoinAlias: joinedComputedSql,
    });
    expect(joinedSortSql.ok).toBe(true);
    if (!joinedSortSql.ok) return;
    expect(normalizedSql(joinedSortSql.query.sql)).toContain("ORDER BY (SELECT 11) DESC NULLS FIRST");

    const joinedFormula = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        select formula(customer.lookup_total + customer.rollup_total) as joined_total
      `),
      context,
    );
    expect(joinedFormula.ok).toBe(true);
    if (!joinedFormula.ok) return;
    const joinedFormulaSql = compileDslQueryPlanToSql(joinedFormula.plan, {
      fieldsByTableId: context.fieldsByTableId,
      computedFieldSqlByJoinAlias: joinedComputedSql,
    });
    expect(joinedFormulaSql.ok).toBe(true);
    if (!joinedFormulaSql.ok) return;
    const joinedFormulaText = normalizedSql(joinedFormulaSql.query.sql);
    expect(joinedFormulaText).toContain("(SELECT 7)");
    expect(joinedFormulaText).toContain("(SELECT 11)");

    const joinedComputedAggregate = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        group by customer.name
        aggregate sum(customer.rollup_total) as joined_total
        sort joined_total desc
      `),
      context,
    );
    expect(joinedComputedAggregate.ok).toBe(true);
    if (!joinedComputedAggregate.ok) return;
    const joinedComputedAggregateSql = compileDslGroupedQueryPlanToSql(joinedComputedAggregate.plan, {
      fieldsByTableId: context.fieldsByTableId,
      computedFieldSqlByJoinAlias: joinedComputedSql,
    });
    expect(joinedComputedAggregateSql.ok).toBe(true);
    if (!joinedComputedAggregateSql.ok) return;
    const joinedComputedAggregateText = normalizedSql(joinedComputedAggregateSql.query.sql);
    expect(joinedComputedAggregateText).toContain("(SELECT 11)");
    expect(joinedComputedAggregateText).toContain('"joined_total__sum"');

    const missingLookupSql = compileDslGroupedQueryPlanToSql(lookup.plan, { fieldsByTableId: context.fieldsByTableId });
    expect(missingLookupSql).toEqual({
      ok: false,
      error: 'field "Lookup total" (type "lookup") is not available in this query',
    });
    if (!missingLookupSql.ok) {
      expect(dslPreviewDiagnosticForCompilerError(lookup.plan, missingLookupSql.error)).toEqual({
        message: missingLookupSql.error,
        line: 3,
        column: 18,
        length: 21,
      });
      expect(dslPreviewDiagnosticForCompilerError(lookup.plan, "unexpected compiler failure")).toEqual({
        message: "unexpected compiler failure",
      });
    }

    const defaultCount = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        group by customer.name
      `),
      context,
    );
    expect(defaultCount.ok).toBe(true);
    if (!defaultCount.ok) return;
    const defaultCountSql = compileDslGroupedQueryPlanToSql(defaultCount.plan, { fieldsByTableId: context.fieldsByTableId });
    expect(defaultCountSql.ok).toBe(true);
    if (!defaultCountSql.ok) return;
    expect(defaultCountSql.query.columns).toContainEqual({
      kind: "aggregate",
      key: "*__count",
      label: "*__count",
      fieldId: "*",
      agg: "count",
      sqlType: "numeric",
    });
    expect(normalizedSql(defaultCountSql.query.sql)).toContain('COUNT(*)::bigint AS "*__count"');

    const unreadableRelationTarget = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        group by customer.region
        aggregate count(*) as rows
      `),
      ctx({
        tables: [orders, customers],
        fieldsByTableId: {
          [orders.id]: fields,
          [customers.id]: context.fieldsByTableId[customers.id] ?? [],
        },
      }),
    );
    expect(unreadableRelationTarget.ok).toBe(false);
    if (!unreadableRelationTarget.ok) {
      expect(unreadableRelationTarget.diagnostics.map((d) => d.message)).toEqual(['relation field "Region" target table is not available']);
    }

    const nonProjectableComputed = resolveDslQueryToQueryPlan(
      parseOk(`
        join table Custs as customer on customer_link = customer.id
        group by customer.bad_formula
        aggregate count(*) as rows
      `),
      context,
    );
    expect(nonProjectableComputed.ok).toBe(true);
    if (!nonProjectableComputed.ok) return;
    const nonProjectableSql = compileDslGroupedQueryPlanToSql(nonProjectableComputed.plan, { fieldsByTableId: context.fieldsByTableId });
    expect(nonProjectableSql.ok).toBe(false);
    if (!nonProjectableSql.ok) expect(nonProjectableSql.error).toContain("cannot be compiled into SQL formulas yet");
  });
});
