import { beforeAll, expect, spyOn } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import * as bases from "./bases";
import * as durableHistory from "./durable-history";
import * as fields from "./fields";
import { lockFinalizedSchema } from "./finalized-schema";
import { requireValidCalculationSql } from "./formula-sql-values";
import * as storage from "./local-calculation-storage";
import * as parents from "./parent-checks";
import * as finalization from "./record-finalization";
import { get as getRecord } from "./record-read";
import * as records from "./record-write";
import * as tables from "./tables";

beforeAll(async () => {
  if (testInfra.database) await migrate();
}, 30_000);

const fixture = async () => {
  const baseId = testUuid();
  const tableId = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${testShortId("B")}, 'Materialized calculation storage')`;
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name)
    VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Records')`;
  const amount = await fields.create({ tableId, name: "Amount", type: "number" }, null);
  const total = await fields.create({ tableId, name: "Total", type: "formula", config: { expression: "Amount * 2" } }, null);
  if (!amount.ok) throw amount.error;
  if (!total.ok) throw total.error;
  const record = await records.create(tableId, { [amount.data.id]: "3" }, null, "direct");
  if (!record.ok) throw record.error;
  return { baseId, tableId, amount: amount.data, total: total.data, record: record.data };
};

type StoredCalculation = { signature: string; inputs: string; values: Record<string, unknown>; errors: Record<string, boolean> };

const readStored = async (recordId: string) => {
  const [row] = await sql<Array<{ data: Record<string, unknown>; calculations: StoredCalculation; version: number; inputsMatch: boolean }>>`
    SELECT data, local_calculations AS calculations, version,
      local_calculations->>'inputs' = md5(data::text) AS "inputsMatch"
    FROM grids.records WHERE id = ${recordId}::uuid
  `;
  if (!row) throw new Error("Missing test record");
  return row;
};

const repair = (tableId: string) =>
  sql.begin(async (tx) => {
    await lockFinalizedSchema(tx, tableId);
    await storage.refreshLocalCalculations(tx, tableId);
  });

postgresTest(
  "null-only materializations remain null through dependent formulas, reads and finalization",
  async () => {
    const item = await fixture();
    try {
      const expected: Record<string, unknown> = {};
      for (const [name, expression, value] of [
        ["Empty", "null", null],
        ["NestedEmpty", "IF(Amount > 0, null, null)", null],
        ["CopyEmpty", "Empty", null],
        ["EmptyFallback", "IFEMPTY(NestedEmpty, 7)", "7"],
        ["ErrorFallback", "IFERROR(Empty, 8)", null],
        ["NullBranch", "IF(Amount > 0, Empty, 9)", null],
        ["BooleanFallback", "IFEMPTY(Empty, true)", true],
        ["NullArithmetic", "Empty + 1", null],
      ] as const) {
        const created = await fields.create({ tableId: item.tableId, name, type: "formula", config: { expression } }, null);
        if (!created.ok) throw created.error;
        expected[created.data.id] = value;
      }
      const assertValues = async (recordId: string) => {
        const read = await getRecord(item.tableId, recordId);
        expect(read?.data).toMatchObject(expected);
        expect(read?.fieldErrors).toBeUndefined();
      };
      await assertValues(item.record.id);
      const created = await records.create(item.tableId, { [item.amount.id]: "4" }, null, "direct");
      if (!created.ok) throw created.error;
      expect(created.data.data).toMatchObject(expected);
      const updated = await records.update(item.tableId, created.data.id, { [item.amount.id]: "5" }, null, "direct", created.data.version);
      if (!updated.ok) throw updated.error;
      expect(updated.data.data).toMatchObject(expected);
      const materialized = await readStored(created.data.id);
      expect(materialized.calculations.values).toMatchObject(expected);
      for (const id of Object.keys(expected)) expect(materialized.calculations.errors[id]).toBe(false);
      expect(materialized.inputsMatch).toBe(true);
      await assertValues(created.data.id);

      const history = await durableHistory.enable(item.tableId, null);
      if (!history.ok) throw history.error;
      const enabled = await finalization.enable(item.tableId, { mode: "direct" }, null);
      if (!enabled.ok) throw enabled.error;
      const finalized = await finalization.finalize({ tableId: item.tableId, recordId: created.data.id, actorId: null, origin: "direct" });
      if (!finalized.ok) throw finalized.error;
      expect(finalized.data.data).toMatchObject(expected);
      const frozen = await readStored(created.data.id);
      expect(frozen.data).toMatchObject(expected);
      await assertValues(created.data.id);
    } finally {
      await sql`UPDATE grids.records SET finalized_at = NULL, finalized_by = NULL, final_revision_id = NULL
        WHERE table_id = ${item.tableId}::uuid`;
      await sql`DELETE FROM grids.record_revisions WHERE table_id = ${item.tableId}::uuid`;
      await sql`DELETE FROM grids.record_finalization_requests WHERE table_id = ${item.tableId}::uuid`;
      await sql`DELETE FROM grids.table_finalization_activations WHERE table_id = ${item.tableId}::uuid`;
      await sql`DELETE FROM grids.durable_history_activations WHERE table_id = ${item.tableId}::uuid`;
      await sql`DELETE FROM grids.table_schema_revisions WHERE table_id = ${item.tableId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id = ${item.baseId}::uuid`;
    }
  },
  30_000,
);

postgresTest(
  "record writes commit values and materialization atomically and retain one winner in a version race",
  async () => {
    const item = await fixture();
    try {
      const before = await readStored(item.record.id);
      expect(before.calculations.values[item.total.id]).toBe("6");
      expect(before.calculations.errors[item.total.id]).toBe(false);
      expect(before.inputsMatch).toBe(true);
      await expect(
        sql.begin(async (tx) => {
          const changed = await records.updateInTransaction(
            tx,
            item.tableId,
            item.record.id,
            { [item.amount.id]: "7" },
            null,
            "direct",
            item.record.version,
          );
          if (!changed.ok) throw changed.error;
          expect(changed.data.record.data[item.total.id]).toBe("14");
          throw new Error("forced rollback after materialized write");
        }),
      ).rejects.toThrow("forced rollback after materialized write");
      expect(await readStored(item.record.id)).toEqual(before);

      const results = await Promise.all(
        ["5", "9"].map((value) =>
          records.update(item.tableId, item.record.id, { [item.amount.id]: value }, null, "direct", item.record.version),
        ),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const rejected = results.find((result) => !result.ok);
      expect(rejected?.ok === false && rejected.error.code).toBe("CONFLICT");
      const after = await readStored(item.record.id);
      expect(after.version).toBe(before.version + 1);
      expect(after.inputsMatch).toBe(true);
      expect(after.calculations.values[item.total.id]).toBe(after.data[item.amount.id] === "5" ? "10" : "18");
      expect((await getRecord(item.tableId, item.record.id))?.data[item.total.id]).toBe(after.calculations.values[item.total.id]);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${item.baseId}::uuid`;
    }
  },
  30_000,
);

postgresTest(
  "raw input writes invalidate materialization, fail closed and are repaired explicitly",
  async () => {
    const item = await fixture();
    try {
      await sql`UPDATE grids.records SET data = jsonb_set(data, ${sql.array([item.amount.id], "TEXT")}, '"11"'::jsonb)
      WHERE id = ${item.record.id}::uuid`;
      const [invalidated] = await sql<Array<{ calculations: unknown }>>`
      SELECT local_calculations AS calculations FROM grids.records WHERE id = ${item.record.id}::uuid`;
      expect(invalidated?.calculations).toEqual({});
      await expect(getRecord(item.tableId, item.record.id)).rejects.toThrow("grids: stale local calculation");
      await repair(item.tableId);
      const stored = await readStored(item.record.id);
      expect(stored.inputsMatch).toBe(true);
      expect(stored.calculations.values[item.total.id]).toBe("22");
      expect(stored.version).toBe(item.record.version);
      expect((await getRecord(item.tableId, item.record.id))?.data[item.total.id]).toBe("22");
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${item.baseId}::uuid`;
    }
  },
  30_000,
);

postgresTest(
  "missing calculation values and error flags fail closed while stored formula errors stay recoverable",
  async () => {
    const item = await fixture();
    try {
      const initial = await readStored(item.record.id);
      for (const part of ["values", "errors"]) {
        await sql`UPDATE grids.records SET local_calculations = ${initial.calculations}::jsonb #- ${sql.array([part, item.total.id], "TEXT")}
        WHERE id = ${item.record.id}::uuid`;
        await expect(getRecord(item.tableId, item.record.id)).rejects.toThrow("grids: stale local calculation");
      }
      await sql`UPDATE grids.records SET local_calculations = ${initial.calculations}::jsonb WHERE id = ${item.record.id}::uuid`;
      const bad = await fields.create({ tableId: item.tableId, name: "Bad", type: "formula", config: { expression: "Amount / 0" } }, null);
      if (!bad.ok) throw bad.error;
      const recovered = await fields.create(
        { tableId: item.tableId, name: "Recovered", type: "formula", config: { expression: "IFERROR(Bad, 7)" } },
        null,
      );
      if (!recovered.ok) throw recovered.error;
      const stored = await readStored(item.record.id);
      expect(stored.calculations.values[bad.data.id]).toBeNull();
      expect(stored.calculations.errors[bad.data.id]).toBe(true);
      expect(stored.calculations.values[recovered.data.id]).toBe("7");
      expect(stored.calculations.errors[recovered.data.id]).toBe(false);
      const read = await getRecord(item.tableId, item.record.id);
      expect(read?.data[bad.data.id]).toBeNull();
      expect(read?.fieldErrors?.[bad.data.id]).toBeTruthy();
      expect(read?.data[recovered.data.id]).toBe("7");
      const expression = storage.storedLocalCalculationSqlMap(await fields.listByTable(item.tableId)).get(bad.data.id);
      if (!expression) throw new Error("Missing local formula projection");
      await expect(
        Promise.resolve(sql`SELECT ${requireValidCalculationSql(expression)} FROM grids.records r WHERE r.id = ${item.record.id}::uuid`),
      ).rejects.toThrow("grids: invalid calculation");
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${item.baseId}::uuid`;
    }
  },
  30_000,
);

postgresTest(
  "a writer racing a schema change computes against the committed schema",
  async () => {
    const item = await fixture();
    const refreshed = Promise.withResolvers<void>();
    const releaseSchema = Promise.withResolvers<void>();
    const writerEntered = Promise.withResolvers<void>();
    const refresh = storage.refreshLocalCalculations;
    const writable = parents.requireStoredTableWritable;
    const schemaPause = spyOn(storage, "refreshLocalCalculations").mockImplementationOnce(async (...args) => {
      await refresh(...args);
      refreshed.resolve();
      await releaseSchema.promise;
    });
    const writerSignal = spyOn(parents, "requireStoredTableWritable").mockImplementation(async (...args) => {
      writerEntered.resolve();
      return writable(...args);
    });
    const schemaChange = fields.update(item.total.id, { config: { expression: "Amount * 3" } }, null);
    let writer: ReturnType<typeof records.update> | undefined;
    try {
      await Promise.race([
        refreshed.promise,
        schemaChange.then(() => {
          throw new Error("Schema refresh did not enter test barrier");
        }),
      ]);
      writer = records.update(item.tableId, item.record.id, { [item.amount.id]: "5" }, null, "direct", item.record.version);
      await Promise.race([
        writerEntered.promise,
        writer.then(() => {
          throw new Error("Writer did not enter table lock");
        }),
      ]);
      releaseSchema.resolve();
      const [changed, written] = await Promise.all([schemaChange, writer]);
      if (!changed.ok) throw changed.error;
      if (!written.ok) throw written.error;
      expect(written.data.data[item.total.id]).toBe("15");
      const stored = await readStored(item.record.id);
      expect(stored.inputsMatch).toBe(true);
      expect(stored.calculations.values[item.total.id]).toBe("15");
      expect(stored.version).toBe(item.record.version + 1);
    } finally {
      releaseSchema.resolve();
      await Promise.allSettled([schemaChange, ...(writer ? [writer] : [])]);
      schemaPause.mockRestore();
      writerSignal.mockRestore();
      await sql`DELETE FROM grids.bases WHERE id = ${item.baseId}::uuid`;
    }
  },
  30_000,
);

postgresTest(
  "startup backfill preserves calculations inside trashed tables and bases before their restore",
  async () => {
    const trashedTable = await fixture();
    const trashedBase = await fixture();
    try {
      await sql`UPDATE grids.tables SET deleted_at = now() WHERE id = ${trashedTable.tableId}::uuid`;
      await sql`UPDATE grids.bases SET deleted_at = now() WHERE id = ${trashedBase.baseId}::uuid`;
      await sql`UPDATE grids.records SET local_calculations = '{}'::jsonb
        WHERE id = ANY(${sql.array([trashedTable.record.id, trashedBase.record.id], "UUID")})`;
      await migrate();
      for (const item of [trashedTable, trashedBase]) {
        const stored = await readStored(item.record.id);
        expect(stored.calculations.values[item.total.id]).toBe("6");
        expect(stored.inputsMatch).toBe(true);
        expect(stored.version).toBe(item.record.version);
        expect(await getRecord(item.tableId, item.record.id)).toBeNull();
      }
      const tableRestored = await tables.restore(trashedTable.tableId, null);
      const baseRestored = await bases.restore(trashedBase.baseId, null);
      if (!tableRestored.ok) throw tableRestored.error;
      if (!baseRestored.ok) throw baseRestored.error;
      for (const item of [trashedTable, trashedBase]) {
        expect((await getRecord(item.tableId, item.record.id))?.data[item.total.id]).toBe("6");
      }
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ANY(${sql.array([trashedTable.baseId, trashedBase.baseId], "UUID")})`;
    }
  },
  30_000,
);

postgresTest(
  "an erroneous materialized list preserves its editable raw inputs and exposes the calculation error",
  async () => {
    const item = await fixture();
    try {
      const list = await fields.create(
        {
          tableId: item.tableId,
          name: "Lines",
          type: "object_list",
          config: {
            fields: [
              { id: "Amount", name: "Amount", type: "number" },
              { id: "Result", name: "Result", type: "number", formula: { expression: "10 / Amount" } },
            ],
          },
        },
        null,
      );
      if (!list.ok) throw list.error;
      const created = await records.create(item.tableId, { [item.amount.id]: "1", [list.data.id]: [{ Amount: "2" }] }, null, "direct");
      if (!created.ok) throw created.error;
      const inputs = [{ Amount: "0" }];
      await sql`UPDATE grids.records SET data = jsonb_set(data, ${sql.array([list.data.id], "TEXT")}, ${inputs}::jsonb)
        WHERE id = ${created.data.id}::uuid`;
      await repair(item.tableId);
      const stored = await readStored(created.data.id);
      expect(stored.calculations.values[list.data.id]).toBeNull();
      expect(stored.calculations.errors[list.data.id]).toBe(true);
      const read = await getRecord(item.tableId, created.data.id);
      expect(read?.data[list.data.id]).toEqual(inputs);
      expect(read?.fieldErrors?.[list.data.id]).toBeTruthy();
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${item.baseId}::uuid`;
    }
  },
  30_000,
);

postgresTest(
  "extreme local arithmetic remains a recoverable calculation error during writes and startup backfill",
  async () => {
    const item = await fixture();
    try {
      const bad = await fields.update(item.total.id, { name: "Bad", config: { expression: "Amount * 10" } }, null);
      if (!bad.ok) throw bad.error;
      const recovered = await fields.create(
        { tableId: item.tableId, name: "Recovered", type: "formula", config: { expression: "IFERROR(Bad, 7)" } },
        null,
      );
      if (!recovered.ok) throw recovered.error;
      const wideText = await fields.create(
        { tableId: item.tableId, name: "WideText", type: "formula", config: { expression: "LEFT('x', Amount)" } },
        null,
      );
      if (!wideText.ok) throw wideText.error;
      const written = await records.create(item.tableId, { [item.amount.id]: "9".repeat(131072) }, null, "direct");
      if (!written.ok) throw written.error;
      expect(written.data.data[bad.data.id]).toBeNull();
      expect(written.data.fieldErrors?.[bad.data.id]).toBeTruthy();
      expect(written.data.data[recovered.data.id]).toBe("7");
      expect(written.data.data[wideText.data.id]).toBe("x");

      const assertStored = async () => {
        const stored = await readStored(written.data.id);
        expect(stored.inputsMatch).toBe(true);
        expect(stored.calculations.values[bad.data.id]).toBeNull();
        expect(stored.calculations.errors[bad.data.id]).toBe(true);
        expect(stored.calculations.values[recovered.data.id]).toBe("7");
        expect(stored.calculations.errors[recovered.data.id]).toBe(false);
        expect(stored.calculations.values[wideText.data.id]).toBe("x");
        expect(stored.calculations.errors[wideText.data.id]).toBe(false);
        expect(stored.version).toBe(written.data.version);
      };
      await assertStored();
      await sql`UPDATE grids.records SET local_calculations = '{}'::jsonb WHERE id = ${written.data.id}::uuid`;
      await migrate();
      await assertStored();
      const read = await getRecord(item.tableId, written.data.id);
      expect(read?.data[bad.data.id]).toBeNull();
      expect(read?.fieldErrors?.[bad.data.id]).toBeTruthy();
      expect(read?.data[recovered.data.id]).toBe("7");
      expect(read?.data[wideText.data.id]).toBe("x");
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${item.baseId}::uuid`;
    }
  },
  30_000,
);

postgresTest(
  "editing an unrelated field preserves raw list data after its calculation changes",
  async () => {
    const item = await fixture();
    try {
      const amountColumn = { id: "Amount", name: "Amount", type: "number" };
      const resultColumn = { id: "Result", name: "Result", type: "number", formula: { expression: "Amount * 2" } };
      const list = await fields.create(
        { tableId: item.tableId, name: "Lines", type: "object_list", config: { fields: [amountColumn, resultColumn] } },
        null,
      );
      if (!list.ok) throw list.error;
      const written = await records.create(item.tableId, { [item.amount.id]: "1", [list.data.id]: [{ Amount: "1" }] }, null, "direct");
      if (!written.ok) throw written.error;
      const before = await readStored(written.data.id);
      expect(before.data[list.data.id]).toEqual([{ Amount: "1", Result: "2" }]);
      const changed = await fields.update(
        list.data.id,
        { config: { fields: [amountColumn, { ...resultColumn, formula: { expression: "Amount * 3" } }] } },
        null,
      );
      if (!changed.ok) throw changed.error;
      const afterSchemaChange = await readStored(written.data.id);
      expect(afterSchemaChange.data[list.data.id]).toEqual(before.data[list.data.id]);
      expect(afterSchemaChange.calculations.values[list.data.id]).toEqual([{ Amount: "1", Result: "3" }]);

      const edited = await records.update(item.tableId, written.data.id, { [item.amount.id]: "5" }, null, "direct", written.data.version);
      if (!edited.ok) throw edited.error;
      const afterEdit = await readStored(written.data.id);
      expect(afterEdit.data[list.data.id]).toEqual(before.data[list.data.id]);
      expect(afterEdit.calculations.values[list.data.id]).toEqual([{ Amount: "1", Result: "3" }]);
      expect(afterEdit.inputsMatch).toBe(true);
      expect(edited.data.data[list.data.id]).toEqual([{ Amount: "1", Result: "3" }]);
      expect(edited.data.data[item.total.id]).toBe("10");
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${item.baseId}::uuid`;
    }
  },
  30_000,
);
