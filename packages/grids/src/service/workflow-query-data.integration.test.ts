import { beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import { cleanupFixture, ctx, insertDslDbFixture, postgresTest } from "../query-dsl/sql-compiler.integration-fixtures";
import { workflowQueryParameterSamples } from "../workflows/query-parameters";
import { loadWorkflowCatalog } from "./workflow-catalog";
import { workflowQueryBinder } from "./workflow-query-binding";
import { bindWorkflowQueryData, captureWorkflowQueryData } from "./workflow-query-data";

postgresTest("summary workflow bindings capture real rows and reject a changed used View definition", async () => {
  const fixture = await insertDslDbFixture();
  try {
    const viewId = Bun.randomUUIDv7();
    const shortId = Math.random().toString(36).slice(2, 8);
    const source = `from table {${fixture.orders.shortId}}\ngroup by {${fixture.fieldsByTableId[fixture.orders.id]!.find((field) => field.id === fixture.customerLinkId)!.shortId}}\naggregate sum(Amount) as summed_amount`;
    await sql`INSERT INTO grids.views (id, short_id, base_id, table_id, name, source)
      VALUES (${viewId}::uuid, ${shortId}, ${fixture.baseId}::uuid, ${fixture.orders.id}::uuid, 'Order totals', ${source})`;
    const query = `from table Customers as customer\nleft join view {${shortId}} as totals on totals.gk_0 = customer.id\nselect formula(IF(ISBLANK(totals.summed_amount), 0, totals.summed_amount)) as total`;
    const catalog = await loadWorkflowCatalog(fixture.baseId);
    const bound = await workflowQueryBinder(fixture.baseId, catalog)(query, {});
    if (!bound.ok) throw new Error(bound.error.message);
    const capture = () =>
      captureWorkflowQueryData({
        baseId: fixture.baseId,
        binding: bound.data,
        values: {},
        timeZone: "UTC",
        createTableAccess: async () => async () => true,
      });
    const first = await capture();
    if (!first.ok) throw new Error(first.error.message);
    expect(first.data.payload.rows.length).toBeGreaterThan(0);
    expect(first.data.payload.rows.some((row) => Object.values(row).some((value) => Number(value) > 0))).toBe(true);
    await sql`UPDATE grids.views SET description = 'Presentation only' WHERE id = ${viewId}::uuid`;
    expect((await capture()).ok).toBe(true);
    await sql`UPDATE grids.views SET source = ${source.replace("\ngroup by", "\nwhere Amount > 10\ngroup by")} WHERE id = ${viewId}::uuid`;
    const changed = await capture();
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe("CONFLICT");
  } finally {
    await cleanupFixture(fixture.baseId);
  }
});

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

postgresTest("refuses to capture an incomplete formula result and preserves an explicit fallback", async () => {
  const fixture = await insertDslDbFixture();
  try {
    const capture = async (expression: string) => {
      const bound = bindWorkflowQueryData(`from table Orders\nselect formula(${expression}) as total`, ctx(fixture), {});
      if (!bound.ok) throw new Error(bound.error.message);
      return captureWorkflowQueryData({
        baseId: fixture.baseId,
        binding: bound.data.binding,
        values: {},
        locale: "de",
        timeZone: "UTC",
        createTableAccess: async () => async () => true,
      });
    };
    const invalid = await capture("IFEMPTY(Amount, 1) / 0");
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("Expected failed capture");
    expect(invalid.error.code).toBe("BAD_INPUT");
    expect(invalid.error.message).toBe("Dieser Wert konnte nicht berechnet werden. Prüfe die Formel und ihre Eingabewerte.");
    const recovered = await capture("IFERROR(IFEMPTY(Amount, 1) / 0, 42)");
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(recovered.error.message);
    expect(recovered.data.payload.rows.length).toBeGreaterThan(0);
    for (const row of recovered.data.payload.rows) expect(Object.values(row)).toEqual(["42"]);
  } finally {
    await cleanupFixture(fixture.baseId);
  }
});

postgresTest("semantic bindings tolerate presentation changes but reject changed calculation types", async () => {
  const fixture = await insertDslDbFixture();
  try {
    const source = "from table Orders\nselect Amount as exported_amount";
    const modern = bindWorkflowQueryData(source, ctx(fixture), {});
    const searched = bindWorkflowQueryData(`${source}\nsearch 'open'`, ctx(fixture), {});
    if (!modern.ok || !searched.ok) throw new Error("fixture binding failed");
    const capture = (binding: typeof modern.data.binding) =>
      captureWorkflowQueryData({
        baseId: fixture.baseId,
        binding,
        values: {},
        timeZone: "UTC",
        createTableAccess: async () => async () => true,
      });
    expect((await capture(modern.data.binding)).ok).toBe(true);
    expect((await capture(searched.data.binding)).ok).toBe(true);
    await sql`UPDATE grids.fields SET position = position + 20, presentable = NOT presentable WHERE id = ${fixture.amountId}::uuid`;
    expect((await capture(modern.data.binding)).ok).toBe(true);
    const changedSearch = await capture(searched.data.binding);
    expect(changedSearch.ok).toBe(false);
    if (!changedSearch.ok) expect(changedSearch.error.code).toBe("CONFLICT");
    await sql`UPDATE grids.fields SET config = '{"decimalPlaces": 3}'::jsonb WHERE id = ${fixture.amountId}::uuid`;
    const incompatible = await capture(modern.data.binding);
    expect(incompatible.ok).toBe(false);
    if (!incompatible.ok) expect(incompatible.error.code).toBe("CONFLICT");
  } finally {
    await cleanupFixture(fixture.baseId);
  }
});

postgresTest("publishes a typed select parameter and validates its real value before capture", async () => {
  const fixture = await insertDslDbFixture();
  try {
    await sql`UPDATE grids.fields SET type = 'select', config = ${{
      options: [
        { id: "open", label: "Open" },
        { id: "closed", label: "Closed" },
      ],
    }}::jsonb WHERE id = ${fixture.statusId}::uuid`;
    await sql`UPDATE grids.records SET data = data || ${{ [fixture.statusId]: ["closed"] }}::jsonb WHERE table_id = ${fixture.orders.id}::uuid`;
    await sql`UPDATE grids.records SET data = data || ${{ [fixture.statusId]: ["open"] }}::jsonb WHERE id = ${fixture.orderAId}::uuid`;
    const catalog = await loadWorkflowCatalog(fixture.baseId);
    const bind = workflowQueryBinder(fixture.baseId, catalog);
    const samples = workflowQueryParameterSamples({ status: { type: "text", value: "${input.status}" } });
    for (const predicate of ["Status = @params.status", "oneof(Status, @params.status)"]) {
      const bound = await bind(`from table Orders\nselect Amount\nwhere ${predicate}`, samples);
      if (!bound.ok) throw new Error(bound.error.message);
      expect(bound.data.source).toContain("@params.status");
      await sql`UPDATE grids.fields SET config = jsonb_set(config, '{options}', config->'options' || '[{"id":"pending","label":"Pending"}]'::jsonb)
        WHERE id = ${fixture.statusId}::uuid AND NOT (config->'options' @> '[{"id":"pending"}]'::jsonb)`;
      for (const [status, expected] of [
        ["Open", true],
        ["open", true],
        ["Does not exist", false],
      ] as const) {
        const result = await captureWorkflowQueryData({
          baseId: fixture.baseId,
          binding: bound.data,
          values: { "params.status": status },
          timeZone: "UTC",
          createTableAccess: async () => async () => true,
        });
        expect(result.ok).toBe(expected);
        if (result.ok) expect(result.data.rowCount).toBe(1);
      }
    }
  } finally {
    await cleanupFixture(fixture.baseId);
  }
});

postgresTest("an empty record selection captures no rows without bypassing table authorization", async () => {
  const fixture = await insertDslDbFixture();
  try {
    const bound = bindWorkflowQueryData("from table Orders\nselect Amount\nwhere oneof(record.id, @params.selected)", ctx(fixture), {
      "params.selected": ["REC001"],
    });
    if (!bound.ok) throw new Error(bound.error.message);
    const input = {
      baseId: fixture.baseId,
      binding: bound.data.binding,
      values: { "params.selected": [] },
      timeZone: "UTC",
    };
    const captured = await captureWorkflowQueryData({ ...input, createTableAccess: async () => async () => true });
    if (!captured.ok) throw new Error(captured.error.message);
    expect(captured.data.payload.rows).toEqual([]);
    expect(captured.data.rowCount).toBe(0);
    expect(captured.data.payload.complete).toBe(true);
    expect(captured.data.payload.columns).toHaveLength(1);
    const denied = await captureWorkflowQueryData({ ...input, createTableAccess: async () => async () => false });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
  } finally {
    await cleanupFixture(fixture.baseId);
  }
});

postgresTest("workflow query captures exact typed rows with public IDs and checks every table", async () => {
  const fixture = await insertDslDbFixture();
  try {
    await sql`UPDATE grids.records SET data = data || ${{ [fixture.amountId]: "9007199254740993.42" }}::jsonb WHERE id = ${fixture.orderAId}::uuid`;
    const bound = bindWorkflowQueryData(
      "from table Orders\nselect Amount as exported_amount, Customer as customer_ref\nsort Amount desc\nlimit 2",
      ctx(fixture),
      {},
    );
    if (!bound.ok) throw new Error(bound.error.message);
    const checked: string[] = [];
    let accessScopes = 0;
    const captured = await captureWorkflowQueryData({
      baseId: fixture.baseId,
      binding: bound.data.binding,
      values: {},
      timeZone: "UTC",
      createTableAccess: async (client) => {
        accessScopes += 1;
        expect(client).not.toBe(sql);
        return async (id) => {
          checked.push(id);
          return true;
        };
      },
    });
    if (!captured.ok) throw new Error(captured.error.message);
    expect(accessScopes).toBe(1);
    expect(checked).toContain(fixture.orders.id);
    expect(checked).toContain(fixture.customers.id);
    expect(captured.data.rowCount).toBe(2);
    expect(captured.data.payload.complete).toBe(true);
    expect(captured.data.payload.selectionLimit).toBe(2);
    expect(captured.data.payload.rows).toMatchObject([{ q_col_0: "9007199254740993.42" }, { q_col_0: "4" }]);
    expect(captured.data.payload.columns).toMatchObject([
      { key: "q_col_0", label: "exported_amount" },
      { key: "q_col_1", label: "customer_ref" },
    ]);
    expect(JSON.stringify(captured.data.payload.rows)).not.toContain(fixture.customerAId);
    expect(JSON.stringify(captured.data.payload.rowOrigins)).not.toContain(fixture.orderAId);
    expect(captured.data.sha256).toMatch(/^[a-f0-9]{64}$/);
    const denied = await captureWorkflowQueryData({
      baseId: fixture.baseId,
      binding: bound.data.binding,
      values: {},
      timeZone: "UTC",
      createTableAccess: async () => async (id) => id !== fixture.customers.id,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
    for (const predicate of ["Amount = @params.amount", "oneof(Amount, @params.amounts)"]) {
      const parameterized = bindWorkflowQueryData(`from table Orders\nselect Amount as exported_amount\nwhere ${predicate}`, ctx(fixture), {
        "params.amount": { decimal: "0" },
        "params.amounts": [{ decimal: "0" }],
      });
      if (!parameterized.ok) throw new Error(parameterized.error.message);
      const exact = await captureWorkflowQueryData({
        baseId: fixture.baseId,
        binding: parameterized.data.binding,
        values: { "params.amount": { decimal: "9007199254740993.42" }, "params.amounts": [{ decimal: "9007199254740993.42" }] },
        timeZone: "UTC",
        createTableAccess: async () => async () => true,
      });
      if (!exact.ok) throw new Error(exact.error.message);
      expect(exact.data.payload.rows).toEqual([{ q_col_0: "9007199254740993.42" }]);
    }
  } finally {
    await cleanupFixture(fixture.baseId);
  }
});

postgresTest(
  "workflow query uses one database snapshot and never succeeds with a technically truncated result",
  async () => {
    const fixture = await insertDslDbFixture();
    try {
      const bound = bindWorkflowQueryData("from table Orders\nselect Amount as exported_amount\nsort Amount desc", ctx(fixture), {});
      if (!bound.ok) throw new Error(bound.error.message);
      const capture = () =>
        captureWorkflowQueryData({
          baseId: fixture.baseId,
          binding: bound.data.binding,
          values: {},
          timeZone: "UTC",
          createTableAccess: async () => async () => true,
        });
      const before = await capture();
      if (!before.ok) throw new Error(before.error.message);
      let changed = false;
      const raced = await captureWorkflowQueryData({
        baseId: fixture.baseId,
        binding: bound.data.binding,
        values: {},
        timeZone: "UTC",
        createTableAccess: async () => async () => {
          if (!changed) {
            changed = true;
            await sql`UPDATE grids.records SET data = data || ${{ [fixture.amountId]: "999" }}::jsonb WHERE id = ${fixture.orderAId}::uuid`;
          }
          return true;
        },
      });
      if (!raced.ok) throw new Error(raced.error.message);
      expect(raced.data.payload.rows).toEqual(before.data.payload.rows);
      const after = await capture();
      if (!after.ok) throw new Error(after.error.message);
      expect(after.data.payload.rows).not.toEqual(before.data.payload.rows);
      await sql`INSERT INTO grids.records (id, short_id, table_id, data)
      SELECT gen_random_uuid(), candidate.short_id, ${fixture.orders.id}::uuid, ${{ [fixture.amountId]: "1" }}::jsonb
      FROM (SELECT 'W' || lpad(n::text, 5, '0') AS short_id FROM generate_series(1, 99999) n) candidate
      WHERE NOT EXISTS (SELECT 1 FROM grids.records r WHERE r.short_id = candidate.short_id)
      LIMIT 10001`;
      const incomplete = await capture();
      expect(incomplete.ok).toBe(false);
      if (!incomplete.ok) expect(incomplete.error.code).toBe("BAD_INPUT");
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  },
  30_000,
);

postgresTest("workflow query keeps stable names but rejects schema changes and live View bindings", async () => {
  const fixture = await insertDslDbFixture();
  try {
    const bound = bindWorkflowQueryData(
      "from table Orders\nselect Amount as exported_amount\nwhere Amount > @params.minimum",
      ctx(fixture),
      { "params.minimum": 0 },
    );
    if (!bound.ok) throw new Error(bound.error.message);
    expect(bound.data.binding.source).toContain("@params.minimum");
    const input = {
      baseId: fixture.baseId,
      binding: bound.data.binding,
      values: { "params.minimum": 1 },
      timeZone: "UTC",
      createTableAccess: async () => async () => true,
    };
    await sql`UPDATE grids.fields SET name = 'Renamed amount' WHERE id = ${fixture.amountId}::uuid`;
    expect((await captureWorkflowQueryData(input)).ok).toBe(true);
    await sql`UPDATE grids.fields SET config = '{"decimals": 3}'::jsonb WHERE id = ${fixture.amountId}::uuid`;
    const changed = await captureWorkflowQueryData(input);
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe("CONFLICT");
    expect(bindWorkflowQueryData("from view Live\nselect *", ctx(fixture), {}).ok).toBe(false);
  } finally {
    await cleanupFixture(fixture.baseId);
  }
});
