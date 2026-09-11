import { describe, expect, test } from "bun:test";
import { FORMULA_LIMITS } from "../formula/parser";
import { parseGridsQueryDsl } from "./parser";

const withoutSpans = <T>(value: T): T => JSON.parse(JSON.stringify(value, (key, item) => (key === "span" ? undefined : item)));

describe("parseGridsQueryDsl", () => {
  test("surfaces formula complexity diagnostics in a query", () => {
    const source = `select formula(${Array(FORMULA_LIMITS.depth + 1)
      .fill("1")
      .join("+")}) as result`;
    const result = parseGridsQueryDsl(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.message).toContain("levels of nesting");
  });
  test.each([
    ["where IF(true, SUM(1, ), false)", 23],
    ["select formula(IF(true, SUM(1, ), 0)) as broken", 32],
    ["aggregate sum(formula(IF(true, SUM(1, ), 0))) as broken", 39],
    ["having IF(true, SUM(1, ), false)", 24],
  ])("maps nested formula diagnostics through the GQL clause offset: %s", (source, column) => {
    const result = parseGridsQueryDsl(source);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        {
          line: 1,
          column,
          length: 1,
          message: "unexpected token rparen",
        },
      ]);
    }
  });

  test("parses the first table query slice into typed AST data only", () => {
    const result = parseGridsQueryDsl(`
      from table Orders
      select Customer, Amount as net, formula(Amount * 1.19) as gross
      where Status = 'Open' and Amount > Cost * 1.10
      sort ordered_at desc, gross desc
      limit 50
      offset 10
    `);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(withoutSpans(result.ast.source)).toEqual({ kind: "table", ref: "Orders" });
    expect(result.ast.select).toHaveLength(3);
    expect(withoutSpans(result.ast.select[0])).toEqual({ kind: "field", field: { ref: "Customer" } });
    expect(withoutSpans(result.ast.select[1])).toEqual({ kind: "field", field: { ref: "Amount" }, alias: "net" });
    expect(result.ast.select[2]?.kind).toBe("formula");
    expect(result.ast.where?.source).toBe("Status = 'Open' and Amount > Cost * 1.10");
    expect(withoutSpans(result.ast.sort)).toEqual([
      { target: { ref: "ordered_at" }, direction: "desc" },
      { target: { ref: "gross" }, direction: "desc" },
    ]);
    expect(result.ast.limit).toBe(50);
    expect(result.ast.offset).toBe(10);
  });

  test("parses readable table and field names", () => {
    const result = parseGridsQueryDsl(`
      from table Orders
      select Customer, "Unit price" as price
      where Status = 'Open'
      sort "Ordered at" desc
    `);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(withoutSpans(result.ast.source)).toEqual({ kind: "table", ref: "Orders" });
    expect(withoutSpans(result.ast.select[0])).toEqual({ kind: "field", field: { ref: "Customer" } });
    expect(withoutSpans(result.ast.select[1])).toEqual({ kind: "field", field: { ref: "Unit price" }, alias: "price" });
    expect(result.ast.where?.source).toBe("Status = 'Open'");
    expect(withoutSpans(result.ast.sort)).toEqual([{ target: { ref: "Ordered at" }, direction: "desc" }]);
  });

  test("rejects skip as a removed offset alias", () => {
    const result = parseGridsQueryDsl("skip 20");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(['use "offset" instead of "skip"']);
  });

  test("parses multiple top-level clauses on one physical line with semicolons", () => {
    const result = parseGridsQueryDsl(
      `from table Orders; select Customer, formula(Amount * Quantity) as total; where Status = 'Open'; sort total desc; limit 20; offset 5`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(withoutSpans(result.ast.source)).toEqual({ kind: "table", ref: "Orders" });
    expect(result.ast.select).toHaveLength(2);
    expect(result.ast.select[1]?.kind).toBe("formula");
    expect(result.ast.where?.source).toBe("Status = 'Open'");
    expect(withoutSpans(result.ast.sort)).toEqual([{ target: { ref: "total" }, direction: "desc" }]);
    expect(result.ast.limit).toBe(20);
    expect(result.ast.offset).toBe(5);
  });

  test("parses an inline limit after a source-only query", () => {
    const sourceOnly = parseGridsQueryDsl(`from table Categories limit 2`);
    expect(sourceOnly.ok).toBe(true);
    if (!sourceOnly.ok) return;
    expect(withoutSpans(sourceOnly.ast.source)).toEqual({ kind: "table", ref: "Categories" });
    expect(sourceOnly.ast.select).toEqual([]);
    expect(sourceOnly.ast.limit).toBe(2);
  });

  test("keeps clause words inside quoted source names", () => {
    const result = parseGridsQueryDsl(`from table "Categories limit 2" limit 2`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(withoutSpans(result.ast.source)).toEqual({ kind: "table", ref: "Categories limit 2" });
    expect(result.ast.limit).toBe(2);
  });

  test("keeps clause words when they are source or field refs", () => {
    const result = parseGridsQueryDsl(`from table Limit
select Limit
where Search = 'open'
sort Sort asc
limit 2`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(withoutSpans(result.ast.source)).toEqual({ kind: "table", ref: "Limit" });
    expect(withoutSpans(result.ast.select)).toEqual([{ kind: "field", field: { ref: "Limit" } }]);
    expect(result.ast.where?.source).toBe("Search = 'open'");
    expect(withoutSpans(result.ast.sort)).toEqual([{ target: { ref: "Sort" }, direction: "asc" }]);
    expect(result.ast.limit).toBe(2);
  });

  test("keeps semicolons inside strings and formulas", () => {
    const result = parseGridsQueryDsl(`where CONTAINS(Notes, 'sort; this text') and Price <= Cost * 1.10; sort created_at desc`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ast.where?.source).toBe("CONTAINS(Notes, 'sort; this text') and Price <= Cost * 1.10");
    expect(withoutSpans(result.ast.sort)).toEqual([{ target: { ref: "created_at" }, direction: "desc" }]);
  });

  test("does not split clause-like formula call names", () => {
    const direct = parseGridsQueryDsl(`where SORT (Notes)`);
    expect(direct.ok).toBe(true);
    if (direct.ok) expect(direct.ast.where?.source).toBe("SORT (Notes)");

    const nested = parseGridsQueryDsl(`where Rank + SORT (Notes) > 0; sort created_at desc`);
    expect(nested.ok).toBe(true);
    if (!nested.ok) return;
    expect(nested.ast.where?.source).toBe("Rank + SORT (Notes) > 0");
    expect(withoutSpans(nested.ast.sort)).toEqual([{ target: { ref: "created_at" }, direction: "desc" }]);
  });

  test("parses inline relation joins before select clauses", () => {
    const result = parseGridsQueryDsl(
      `from table orders; left join table customers as customer on customer_id = customer.id; select id, customer.name as customer_name; limit 10`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ast.joins).toHaveLength(1);
    expect(withoutSpans(result.ast.select[1])).toEqual({
      kind: "field",
      field: { scope: "customer", ref: "name" },
      alias: "customer_name",
    });
    expect(result.ast.limit).toBe(10);
  });

  test("parses source aliases as base join scopes", () => {
    const result = parseGridsQueryDsl(
      `from table orders as o; left join table customers as customer on o.customer_id = customer.id; select o.id, customer.name as customer_name`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(withoutSpans(result.ast.source)).toEqual({ kind: "table", ref: "orders" });
    expect(result.ast.sourceAlias).toBe("o");
    expect(withoutSpans(result.ast.joins[0]?.on.left)).toEqual({ scope: "o", ref: "customer_id" });
    expect(withoutSpans(result.ast.select[0])).toEqual({ kind: "field", field: { scope: "o", ref: "id" } });
  });

  test("formula expressions accept underscore refs used by DSL field refs", () => {
    const result = parseGridsQueryDsl(`
      where ordered_at = '2026-06-09'
      select formula(customer_id + 1) as customer_rank
    `);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ast.where?.source).toBe("ordered_at = '2026-06-09'");
    expect(result.ast.select[0]?.kind).toBe("formula");
  });

  test("parses grouping, aggregates, having, and comments", () => {
    const result = parseGridsQueryDsl(`
      from table orders -- current table/view source can be resolved later
      group by ordered_at by month, category
      aggregate sum(Amount) as revenue, count(*) as rows, avg(formula(Amount - Cost)) as margin
      having revenue > 100
    `);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(withoutSpans(result.ast.source)).toEqual({ kind: "table", ref: "orders" });
    expect(withoutSpans(result.ast.groupBy)).toEqual([
      { field: { ref: "ordered_at" }, granularity: "month" },
      { field: { ref: "category" } },
    ]);
    expect(result.ast.aggregations.map((item) => [item.fn, item.alias])).toEqual([
      ["sum", "revenue"],
      ["count", "rows"],
      ["avg", "margin"],
    ]);
    expect(result.ast.aggregations[1]?.argument).toBe("*");
    expect(result.ast.having?.source).toBe("revenue > 100");
  });

  test("normalizes aggregate function casing", () => {
    const result = parseGridsQueryDsl(`
      aggregate SUM(Amount) as revenue, countUnique(Customer) as customers
    `);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ast.aggregations.map((item) => [item.fn, item.alias])).toEqual([
      ["sum", "revenue"],
      ["countUnique", "customers"],
    ]);
  });

  test("rejects redundant formula wrappers in where and having", () => {
    const wrapped = parseGridsQueryDsl(`where Price <= formula(Cost * 1.10)`);
    expect(wrapped.ok).toBe(false);
    if (!wrapped.ok)
      expect(wrapped.diagnostics.map((d) => d.message)).toContain(
        "where and having clauses already use formula syntax; write the expression directly without formula(...)",
      );

    const spacedWrapped = parseGridsQueryDsl(`where Price <= formula (Cost * 1.10)`);
    expect(spacedWrapped.ok).toBe(false);
    if (!spacedWrapped.ok)
      expect(spacedWrapped.diagnostics.map((d) => d.message)).toContain(
        "where and having clauses already use formula syntax; write the expression directly without formula(...)",
      );

    const functionName = parseGridsQueryDsl(`where MYFORMULA(#x) = 1`);
    expect(functionName.ok).toBe(false);
    if (!functionName.ok) expect(functionName.diagnostics.map((d) => d.message)[0]).toContain("legacy # field references");
  });

  test("rejects logical function calls in GQL expressions", () => {
    for (const [source, message] of [
      [`where AND(Status = 'Open', Amount > 0)`, `use "and" as an operator instead of "AND(...)" in GQL expressions`],
      [`where AND (Status = 'Open', Amount > 0)`, `use "and" as an operator instead of "AND(...)" in GQL expressions`],
      [`where OR(Status = 'Open', Status = 'Closed')`, `use "or" as an operator instead of "OR(...)" in GQL expressions`],
      [`where NOT(Paid)`, `use "not" as an operator instead of "NOT(...)" in GQL expressions`],
      [
        `select formula(IF(AND (Paid, Amount > 0), Amount, 0)) as value`,
        `use "and" as an operator instead of "AND(...)" in GQL expressions`,
      ],
    ] as const) {
      const result = parseGridsQueryDsl(source);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual([message]);
    }
  });

  test("rejects removed public syntax with replacement diagnostics", () => {
    const cases = [
      [`skip 5`, `use "offset" instead of "skip"`],
      [`sort Amount ascending`, `use "asc" instead of "ascending"`],
      [`sort Amount descending`, `use "desc" instead of "descending"`],
      [`where Amount > 0 && Cost > 0`, `use "and" instead of "&&" in GQL predicates`],
      [`where Amount > 0 || Cost > 0`, `use "or" instead of "||" in GQL predicates`],
      [`where !Paid`, `use "not" instead of "!" in GQL predicates`],
      [
        `having formula(revenue > 0)`,
        `where and having clauses already use formula syntax; write the expression directly without formula(...)`,
      ],
      [`from table #Orders`, `legacy # references are not valid in GQL`],
      [`select #Amount`, `legacy # references are not valid in GQL`],
      [`aggregate sum(#Amount) as revenue`, `legacy # references are not valid in GQL`],
      [`search 'open' in #Status`, `legacy # references are not valid in GQL`],
    ] as const;

    for (const [source, message] of cases) {
      const result = parseGridsQueryDsl(source);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics[0]?.message).toContain(message);
    }
  });

  test("parses parenthesized logical operands as operators", () => {
    const result = parseGridsQueryDsl(`where Amount > 0 and (Cost > 0 or not (Paid))`);

    expect(result.ok).toBe(true);
  });

  test("rejects aliases that collide with reserved expression operators", () => {
    const result = parseGridsQueryDsl(`
      select Amount as not
      select Cost as search
      aggregate sum(Amount) as ascending
    `);

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics.map((d) => d.message)).toEqual([
        'alias "not" is reserved',
        'alias "search" is reserved',
        'alias "ascending" is reserved',
      ]);
  });

  test("rejects untyped from sources instead of guessing table or view", () => {
    const result = parseGridsQueryDsl(`from Orders`);

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics).toContainEqual({
        line: 1,
        column: 1,
        message: 'from source must start with "table" or "view"',
      });
  });

  test("parses bounded join syntax without resolving permissions or SQL", () => {
    const result = parseGridsQueryDsl(`
      from table orders
      left join table customers as customer on customer_id = customer.id
      select id, customer.name as customer_name
    `);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(withoutSpans(result.ast.joins)).toEqual([
      {
        mode: "left",
        source: { kind: "table", ref: "customers" },
        alias: "customer",
        on: {
          left: { ref: "customer_id" },
          right: { scope: "customer", ref: "id" },
        },
      },
    ]);
    expect(withoutSpans(result.ast.select[1])).toEqual({
      kind: "field",
      field: { scope: "customer", ref: "name" },
      alias: "customer_name",
    });
  });

  test("parses join equality outside quoted identifiers on either side", () => {
    const leftQuoted = parseGridsQueryDsl(`
      from table orders as o
      join table customers as customer on o."external=id" = customer.id
    `);
    expect(leftQuoted.ok).toBe(true);
    if (leftQuoted.ok) {
      expect(withoutSpans(leftQuoted.ast.joins[0]?.on)).toEqual({
        left: { scope: "o", ref: "external=id" },
        right: { scope: "customer", ref: "id" },
      });
    }

    const rightQuoted = parseGridsQueryDsl(`
      from table orders as o
      join table customers as customer on o.customer_id = customer."external=id"
    `);
    expect(rightQuoted.ok).toBe(true);
    if (rightQuoted.ok) {
      expect(withoutSpans(rightQuoted.ast.joins[0]?.on)).toEqual({
        left: { scope: "o", ref: "customer_id" },
        right: { scope: "customer", ref: "external=id" },
      });
    }
  });

  test("rejects unsafe or ambiguous join scopes", () => {
    const bothUnscoped = parseGridsQueryDsl(`
      join table customers as customer on customer_id = id
    `);
    expect(bothUnscoped.ok).toBe(false);
    if (!bothUnscoped.ok)
      expect(bothUnscoped.diagnostics.map((d) => d.message)).toContain('join on must reference "customer" on exactly one side');

    const unknownScope = parseGridsQueryDsl(`
      join table customers as customer on orders.customer_id = customer.id
    `);
    expect(unknownScope.ok).toBe(false);
    if (!unknownScope.ok) expect(unknownScope.diagnostics.map((d) => d.message)).toContain('unknown join scope "orders"');

    const duplicate = parseGridsQueryDsl(`
      join table customers as customer on customer_id = customer.id
      join table regions as customer on region_id = customer.id
    `);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.diagnostics.map((d) => d.message)).toContain('duplicate join alias "customer"');

    const caseDuplicate = parseGridsQueryDsl(`
      from table orders as customer
      join table customers as Customer on customer.customer_id = Customer.id
    `);
    expect(caseDuplicate.ok).toBe(false);
    if (!caseDuplicate.ok) expect(caseDuplicate.diagnostics.map((d) => d.message)).toContain('duplicate join alias "Customer"');
  });

  test("reports diagnostics for invalid aliases, duplicate singleton clauses, and invalid limits", () => {
    const result = parseGridsQueryDsl(`
      from table a
      from table b
      select formula(Amount * 2)
      aggregate sum(Amount) as select
      limit 0
      skip nope
    `);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      "duplicate from clause",
      "formula select items need an alias",
      'alias "select" is reserved',
      "limit must be between 1 and 10000",
      'use "offset" instead of "skip"',
    ]);
  });

  test("reports diagnostic columns for standalone and inline clauses", () => {
    const standalone = parseGridsQueryDsl("  limit nope");
    expect(standalone.ok).toBe(false);
    if (!standalone.ok) {
      expect(standalone.diagnostics[0]).toMatchObject({
        line: 1,
        column: 3,
        message: "limit must be a positive integer",
      });
    }

    const inline = parseGridsQueryDsl("from table Orders; limit nope");
    expect(inline.ok).toBe(false);
    if (!inline.ok) {
      expect(inline.diagnostics[0]).toMatchObject({
        line: 1,
        column: 20,
        message: "limit must be a positive integer",
      });
    }
  });

  test("rejects duplicate offset clauses", () => {
    const result = parseGridsQueryDsl(`
      offset 5
      offset 10
    `);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toEqual(["duplicate offset clause"]);
  });

  test("rejects overlong source refs and trailing comma lists", () => {
    const source = parseGridsQueryDsl(`from table ${"a".repeat(201)}`);
    expect(source.ok).toBe(false);
    if (!source.ok) expect(source.diagnostics.map((d) => d.message)).toEqual(["invalid from source"]);

    for (const query of ["select #a,", "group by #a,", "aggregate sum(#a) as total,", "sort #a,"]) {
      const result = parseGridsQueryDsl(query);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.map((d) => d.message)).toContain("trailing comma");
    }
  });

  test("does not treat comment markers inside strings as comments", () => {
    const result = parseGridsQueryDsl(`where CONTAINS(Notes, '-- not a comment')`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ast.where?.source).toBe("CONTAINS(Notes, '-- not a comment')");
  });

  test("rejects comment markers attached to expression text", () => {
    const result = parseGridsQueryDsl(`
      -- whole-line comments stay valid
      where Amount--1
    `);

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics).toContainEqual({
        line: 3,
        column: 19,
        length: 2,
        message: 'comment marker "--" must be preceded by whitespace; write " --" for a comment or use spaces around subtraction',
      });
  });

  test("parses sort nulls first / nulls last modifiers", () => {
    const result = parseGridsQueryDsl(`sort Amount asc nulls first, Status desc nulls last, Cost desc`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(withoutSpans(result.ast.sort)).toEqual([
      { target: { ref: "Amount" }, direction: "asc", nullsFirst: true },
      { target: { ref: "Status" }, direction: "desc", nullsFirst: false },
      { target: { ref: "Cost" }, direction: "desc" },
    ]);
  });

  test("parses include deleted and deleted only flags", () => {
    const include = parseGridsQueryDsl(`from table orders\ninclude deleted`);
    expect(include.ok).toBe(true);
    if (include.ok) {
      expect(include.ast.includeDeleted).toBe(true);
      expect(include.ast.deletedOnly).toBeUndefined();
    }
    const trash = parseGridsQueryDsl(`from table orders\ndeleted only`);
    expect(trash.ok).toBe(true);
    if (trash.ok) expect(trash.ast.deletedOnly).toBe(true);
  });

  test("splits include deleted as a semicolon clause", () => {
    const result = parseGridsQueryDsl(`from table orders; include deleted`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ast.includeDeleted).toBe(true);
  });

  test("parses a search clause with optional field scope", () => {
    const plain = parseGridsQueryDsl(`search 'open'`);
    expect(plain.ok).toBe(true);
    if (plain.ok) expect(withoutSpans(plain.ast.search)).toEqual({ q: "open", fields: [] });

    const scoped = parseGridsQueryDsl(`search 'open' in Customer, "Order status"`);
    expect(scoped.ok).toBe(true);
    if (scoped.ok) expect(withoutSpans(scoped.ast.search)).toEqual({ q: "open", fields: [{ ref: "Customer" }, { ref: "Order status" }] });
  });

  test("rejects a search clause without quoted text", () => {
    const result = parseGridsQueryDsl(`search open`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.some((d) => d.message.includes("quoted text"))).toBe(true);
  });
});
