import { describe, expect, spyOn } from "bun:test";
import { sql } from "bun";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import {
  dropFieldIndex,
  dropOrphanedFieldIndexes,
  ensureFieldIndex,
  ensureMissingFieldSortIndexes,
  fieldPerformanceIndexName,
  fieldPlannerStatisticsName,
  fieldReverseSortIndexName,
  fieldUniqueIndexName,
} from "./field-indexes";
import * as fields from "./fields";
import * as metadataEvents from "./metadata-events";
import * as mutationPolicy from "./mutation-policy";
import * as tables from "./tables";

const postgresTest = testFor("database");
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

const createTableFixture = async (name: string) => {
  const baseId = Bun.randomUUIDv7();
  const tableId = Bun.randomUUIDv7();
  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${shortId("B")}, ${name})
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name)
    VALUES (${tableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Fields')
  `;
  return { baseId, tableId };
};

const createTextField = async (tableId: string, name: string, options: { hideInTable?: boolean } = {}) => {
  const created = await fields.create({ tableId, name, type: "text", ...options }, null);
  if (!created.ok) throw new Error(created.error.message);
  return created.data.id;
};

const deleteField = async (fieldId: string) => {
  const deleted = await fields.softDelete(fieldId, null);
  if (!deleted.ok) throw new Error(deleted.error.message);
};

const restoreField = async (fieldId: string) => {
  const restored = await fields.restore(fieldId, null);
  if (!restored.ok) throw new Error(restored.error.message);
};

const setColumns = async (tableId: string, fieldIds: string[]) => {
  const updated = await tables.update(tableId, { columns: fieldIds.map((fieldId) => ({ fieldId })) }, null);
  if (!updated.ok) throw new Error(updated.error.message);
  return updated.data;
};

const readTable = async (tableId: string) => {
  const table = await tables.get(tableId);
  if (!table) throw new Error("table not found");
  return { columns: table.columns.map((column) => column.fieldId), updatedAt: table.updatedAt };
};

describe("table columns follow field creation, deletion, and restore", () => {
  postgresTest(
    "appends a new field to a stored column list and records the change",
    async () => {
      await migrate();
      const fixture = await createTableFixture(`Column append ${Bun.randomUUIDv7()}`);
      const events = spyOn(metadataEvents, "emitTableMetadataEvent");
      try {
        const first = await createTextField(fixture.tableId, "First");
        const second = await createTextField(fixture.tableId, "Second");
        await setColumns(fixture.tableId, [second, first]);
        const before = await readTable(fixture.tableId);

        events.mockClear();
        const third = await createTextField(fixture.tableId, "Third");
        const after = await readTable(fixture.tableId);
        expect(after.columns).toEqual([second, first, third]);
        expect(after.updatedAt).not.toBe(before.updatedAt);
        expect(events.mock.calls.map(([, event]) => event.type)).toEqual(["field.created", "table.updated"]);
        const [audit] = await sql<Array<{ diff: { columns: { old: unknown; new: unknown } } }>>`
          SELECT diff FROM grids.audit_log
          WHERE table_id = ${fixture.tableId}::uuid AND action = 'updated' AND diff ? 'columns'
          ORDER BY created_at DESC LIMIT 1
        `;
        expect(audit?.diff.columns).toEqual({
          old: [{ fieldId: second }, { fieldId: first }],
          new: [{ fieldId: second }, { fieldId: first }, { fieldId: third }],
        });
      } finally {
        events.mockRestore();
        await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
      }
    },
    30_000,
  );

  postgresTest(
    "keeps a derived column list empty and leaves hidden fields out of a stored one",
    async () => {
      await migrate();
      const fixture = await createTableFixture(`Column derived ${Bun.randomUUIDv7()}`);
      const events = spyOn(metadataEvents, "emitTableMetadataEvent");
      try {
        const first = await createTextField(fixture.tableId, "First");
        const derived = await readTable(fixture.tableId);
        expect(derived.columns).toEqual([]);

        events.mockClear();
        await createTextField(fixture.tableId, "Second");
        const stillDerived = await readTable(fixture.tableId);
        expect(stillDerived.columns).toEqual([]);
        // The version still changes, so a column list built before this field existed cannot drop it.
        expect(stillDerived.updatedAt).not.toBe(derived.updatedAt);
        expect(events.mock.calls.map(([, event]) => event.type)).toEqual(["field.created"]);

        await setColumns(fixture.tableId, [first]);
        await createTextField(fixture.tableId, "Internal", { hideInTable: true });
        expect((await readTable(fixture.tableId)).columns).toEqual([first]);
      } finally {
        events.mockRestore();
        await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
      }
    },
    30_000,
  );

  postgresTest(
    "keeps every new field visible after listed fields were deleted",
    async () => {
      await migrate();
      const fixture = await createTableFixture(`Column delete add ${Bun.randomUUIDv7()}`);
      try {
        const [a, b, c, d] = [
          await createTextField(fixture.tableId, "A"),
          await createTextField(fixture.tableId, "B"),
          await createTextField(fixture.tableId, "C"),
          await createTextField(fixture.tableId, "D"),
        ];
        await setColumns(fixture.tableId, [a, b, c, d]);

        await deleteField(c);
        await deleteField(d);
        expect((await readTable(fixture.tableId)).columns).toEqual([a, b]);
        const e = await createTextField(fixture.tableId, "E");
        expect((await readTable(fixture.tableId)).columns).toEqual([a, b, e]);
        const f = await createTextField(fixture.tableId, "F");
        expect((await readTable(fixture.tableId)).columns).toEqual([a, b, e, f]);
      } finally {
        await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
      }
    },
    30_000,
  );

  postgresTest(
    "rejects a column write built from an older table version",
    async () => {
      await migrate();
      const fixture = await createTableFixture(`Column precondition ${Bun.randomUUIDv7()}`);
      try {
        const first = await createTextField(fixture.tableId, "First");
        await setColumns(fixture.tableId, [first]);
        const loaded = await readTable(fixture.tableId);

        // Another client adds a field; a list from the earlier version would drop it.
        const second = await createTextField(fixture.tableId, "Second");
        const stale = await tables.update(fixture.tableId, { columns: [{ fieldId: first }], expectedUpdatedAt: loaded.updatedAt }, null);
        expect(stale.ok).toBe(false);
        if (!stale.ok) expect(stale.error.code).toBe("CONFLICT");
        expect((await readTable(fixture.tableId)).columns).toEqual([first, second]);

        // The current version is accepted, and omitting it keeps the unconditional write for existing clients.
        const current = await readTable(fixture.tableId);
        const reordered = await tables.update(
          fixture.tableId,
          { columns: [{ fieldId: second }, { fieldId: first }], expectedUpdatedAt: current.updatedAt },
          null,
        );
        expect(reordered.ok).toBe(true);
        expect((await tables.update(fixture.tableId, { columns: [{ fieldId: first }] }, null)).ok).toBe(true);
        expect((await readTable(fixture.tableId)).columns).toEqual([first]);

        // Deleting a field changes the version as well.
        const beforeDelete = await readTable(fixture.tableId);
        await deleteField(second);
        const afterDelete = await tables.update(fixture.tableId, { name: "Renamed", expectedUpdatedAt: beforeDelete.updatedAt }, null);
        expect(afterDelete.ok).toBe(false);
      } finally {
        await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
      }
    },
    30_000,
  );

  postgresTest(
    "puts a restored field back at the end of a stored column list",
    async () => {
      await migrate();
      const fixture = await createTableFixture(`Column restore ${Bun.randomUUIDv7()}`);
      const events = spyOn(metadataEvents, "emitTableMetadataEvent");
      try {
        const [a, b, c] = [
          await createTextField(fixture.tableId, "A"),
          await createTextField(fixture.tableId, "B"),
          await createTextField(fixture.tableId, "C"),
        ];
        await setColumns(fixture.tableId, [a, b, c]);
        await deleteField(b);
        const loaded = await readTable(fixture.tableId);
        expect(loaded.columns).toEqual([a, c]);

        events.mockClear();
        await restoreField(b);
        expect((await readTable(fixture.tableId)).columns).toEqual([a, c, b]);
        expect(events.mock.calls.map(([, event]) => event.type)).toEqual(["field.restored", "table.updated"]);
        // A list built before the restore conflicts instead of hiding the restored field again.
        const stale = await tables.update(
          fixture.tableId,
          { columns: [{ fieldId: c }, { fieldId: a }], expectedUpdatedAt: loaded.updatedAt },
          null,
        );
        expect(stale.ok).toBe(false);

        // A derived list stays derived, but the restore still changes its version.
        await setColumns(fixture.tableId, []);
        await deleteField(c);
        const derived = await readTable(fixture.tableId);
        events.mockClear();
        await restoreField(c);
        const restored = await readTable(fixture.tableId);
        expect(restored.columns).toEqual([]);
        expect(restored.updatedAt).not.toBe(derived.updatedAt);
        expect(events.mock.calls.map(([, event]) => event.type)).toEqual(["field.restored"]);
      } finally {
        events.mockRestore();
        await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
      }
    },
    30_000,
  );

  postgresTest(
    "moves the table version forward with every change, even past a version ahead of the clock",
    async () => {
      await migrate();
      const fixture = await createTableFixture(`Column version ${Bun.randomUUIDv7()}`);
      // A change whose transaction started before an already committed one, or within the same millisecond, would
      // otherwise reuse its version, so a column list built on that version could still drop the new field.
      const advances = async (change: () => Promise<unknown>) => {
        await sql`UPDATE grids.tables SET updated_at = now() + interval '1 minute' WHERE id = ${fixture.tableId}::uuid`;
        const before = await readTable(fixture.tableId);
        await change();
        expect(Date.parse((await readTable(fixture.tableId)).updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
      };
      try {
        const first = await createTextField(fixture.tableId, "First");
        await advances(() => setColumns(fixture.tableId, [first]));
        let second = "";
        await advances(async () => {
          second = await createTextField(fixture.tableId, "Second");
        });
        await advances(() => createTextField(fixture.tableId, "Internal", { hideInTable: true }));
        await advances(() => deleteField(second));
        await advances(() => restoreField(second));
        await advances(() => mutationPolicy.update(fixture.tableId, { mode: "selected", sources: ["form"] }, null));
        await advances(async () => {
          expect((await tables.remove(fixture.tableId, null)).ok).toBe(true);
          expect((await tables.restore(fixture.tableId, null)).ok).toBe(true);
        });
      } finally {
        await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
      }
    },
    30_000,
  );
});

describe("field lifecycle Postgres integration", () => {
  postgresTest(
    "removes dynamic indexes after their field was hard-deleted",
    async () => {
      await migrate();
      const fixture = await createTableFixture(`Orphan index ${Bun.randomUUIDv7()}`);
      const fieldId = Bun.randomUUIDv7();
      const indexName = fieldPerformanceIndexName(fieldId);
      const statisticsName = fieldPlannerStatisticsName(fieldId);
      try {
        await ensureFieldIndex(fieldId, "number", fixture.tableId);
        const [before] = await sql<Array<{ indexExists: boolean; statisticsExists: boolean }>>`
          SELECT to_regclass(${"grids." + indexName}) IS NOT NULL AS "indexExists",
                 EXISTS (
                   SELECT 1
                   FROM pg_statistic_ext e
                   JOIN pg_namespace n ON n.oid = e.stxnamespace
                   WHERE n.nspname = 'grids' AND e.stxname = ${statisticsName}
                 ) AS "statisticsExists"
        `;
        expect(before).toEqual({ indexExists: true, statisticsExists: true });

        expect(await dropOrphanedFieldIndexes()).toBeGreaterThanOrEqual(1);
        const [after] = await sql<Array<{ indexExists: boolean; statisticsExists: boolean }>>`
          SELECT to_regclass(${"grids." + indexName}) IS NOT NULL AS "indexExists",
                 EXISTS (
                   SELECT 1
                   FROM pg_statistic_ext e
                   JOIN pg_namespace n ON n.oid = e.stxnamespace
                   WHERE n.nspname = 'grids' AND e.stxname = ${statisticsName}
                 ) AS "statisticsExists"
        `;
        expect(after).toEqual({ indexExists: false, statisticsExists: false });
      } finally {
        await dropFieldIndex(fieldId);
        await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
      }
    },
    30_000,
  );

  postgresTest(
    "uses btree for single-select and GIN containment for multi-select indexes",
    async () => {
      await migrate();
      const fixture = await createTableFixture(`Select indexes ${Bun.randomUUIDv7()}`);
      const singleId = Bun.randomUUIDv7();
      const multiId = Bun.randomUUIDv7();
      try {
        await ensureFieldIndex(singleId, "select", fixture.tableId, { multiple: false });
        await ensureFieldIndex(multiId, "select", fixture.tableId, { multiple: true });
        const names = [fieldPerformanceIndexName(singleId), fieldReverseSortIndexName(singleId), fieldPerformanceIndexName(multiId)];
        const statisticsNames = [fieldPlannerStatisticsName(singleId), fieldPlannerStatisticsName(multiId)];
        const definitions = await sql<Array<{ name: string; definition: string; keyColumns: number }>>`
          SELECT c.relname::text AS name, pg_get_indexdef(i.indexrelid) AS definition, i.indnkeyatts::int AS "keyColumns"
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_index i ON i.indexrelid = c.oid
          WHERE n.nspname = 'grids' AND c.relname::text = ANY(${sql.array(names, "TEXT")})
        `;
        const byName = new Map(definitions.map((row) => [row.name, row.definition]));
        const keyColumnsByName = new Map(definitions.map((row) => [row.name, row.keyColumns]));
        expect(byName.get(names[0]!)).toContain("USING btree");
        expect(byName.get(names[0]!)).toContain("->> 0");
        expect(keyColumnsByName.get(names[0]!)).toBe(2);
        expect(byName.get(names[1]!)).toContain("DESC NULLS LAST");
        expect(byName.get(names[1]!)).toContain("id DESC");
        expect(keyColumnsByName.get(names[1]!)).toBe(2);
        expect(byName.get(names[2]!)).toContain("USING gin");
        expect(byName.get(names[2]!)).toContain("jsonb_path_ops");
        const statistics = await sql<Array<{ name: string }>>`
          SELECT e.stxname::text AS name
          FROM pg_statistic_ext e
          JOIN pg_namespace n ON n.oid = e.stxnamespace
          WHERE n.nspname = 'grids'
            AND e.stxname = ANY(${sql.array(statisticsNames, "TEXT")})
        `;
        expect(statistics.map((item) => item.name)).toEqual([statisticsNames[0]!]);
      } finally {
        await dropFieldIndex(singleId);
        await dropFieldIndex(multiId);
        await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
      }
    },
    30_000,
  );

  postgresTest(
    "upgrades legacy single-key sort indexes",
    async () => {
      await migrate();
      const fixture = await createTableFixture(`Legacy sort index ${Bun.randomUUIDv7()}`);
      const fieldId = Bun.randomUUIDv7();
      const forwardName = fieldPerformanceIndexName(fieldId);
      const reverseName = fieldReverseSortIndexName(fieldId);
      try {
        await sql`
          INSERT INTO grids.fields (id, short_id, table_id, name, type, indexed)
          VALUES (${fieldId}::uuid, ${shortId("F")}, ${fixture.tableId}::uuid, 'Indexed', 'number', TRUE)
        `;
        await sql.unsafe(
          `CREATE INDEX ${forwardName}
           ON grids.records ((grids.try_numeric(data->>'${fieldId}')))
           WHERE table_id = '${fixture.tableId}'::uuid AND deleted_at IS NULL`,
        );
        await sql.unsafe(
          `CREATE INDEX ${reverseName}
           ON grids.records ((grids.try_numeric(data->>'${fieldId}')) DESC NULLS LAST)
           WHERE table_id = '${fixture.tableId}'::uuid AND deleted_at IS NULL`,
        );

        const indexesCreated = await ensureMissingFieldSortIndexes();
        expect(indexesCreated).toBeGreaterThanOrEqual(2);
        const indexes = await sql<Array<{ name: string; keyColumns: number }>>`
          SELECT c.relname::text AS name, i.indnkeyatts::int AS "keyColumns"
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_index i ON i.indexrelid = c.oid
          WHERE n.nspname = 'grids'
            AND c.relname::text = ANY(${sql.array([forwardName, reverseName], "TEXT")})
        `;
        expect(indexes).toHaveLength(2);
        expect(indexes.every((index) => index.keyColumns === 2)).toBe(true);
      } finally {
        await dropFieldIndex(fieldId);
        await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
      }
    },
    30_000,
  );

  postgresTest(
    "returns name conflicts without aborting the surrounding field transaction",
    async () => {
      await migrate();
      const fixture = await createTableFixture(`Field conflicts ${Bun.randomUUIDv7()}`);
      try {
        const original = await fields.create({ tableId: fixture.tableId, name: "Shared name", type: "text" }, null);
        expect(original.ok).toBe(true);
        if (!original.ok) throw new Error(original.error.message);

        const duplicate = await fields.create({ tableId: fixture.tableId, name: "Shared name", type: "text" }, null);
        expect(duplicate.ok).toBe(false);
        if (!duplicate.ok) expect(duplicate.error.code).toBe("CONFLICT");

        expect((await fields.softDelete(original.data.id, null)).ok).toBe(true);
        const replacement = await fields.create({ tableId: fixture.tableId, name: "Shared name", type: "text" }, null);
        expect(replacement.ok).toBe(true);
        const restore = await fields.restore(original.data.id, null);
        expect(restore.ok).toBe(false);
        if (!restore.ok) expect(restore.error.code).toBe("CONFLICT");

        const [trashed] = await sql<Array<{ deleted: boolean }>>`
          SELECT deleted_at IS NOT NULL AS deleted FROM grids.fields WHERE id = ${original.data.id}::uuid
        `;
        expect(trashed?.deleted).toBe(true);
      } finally {
        await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
      }
    },
    30_000,
  );

  postgresTest(
    "rolls back create, update, restore, and delete when their audit write fails",
    async () => {
      await migrate();
      const fixture = await createTableFixture(`Field lifecycle ${Bun.randomUUIDv7()}`);
      try {
        await expect(fields.create({ tableId: fixture.tableId, name: "Create rollback", type: "text" }, "not-a-uuid")).rejects.toThrow();
        const [createdAfterRollback] = await sql<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM grids.fields
          WHERE table_id = ${fixture.tableId}::uuid AND name = 'Create rollback'
        `;
        expect(createdAfterRollback?.count).toBe(0);

        const created = await fields.create({ tableId: fixture.tableId, name: "Lifecycle", type: "text" }, null);
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error.message);

        const updateResult = await fields.update(created.data.id, { description: "must roll back" }, "not-a-uuid");
        expect(updateResult.ok).toBe(false);
        const afterUpdate = await fields.get(created.data.id);
        expect(afterUpdate?.description).toBeNull();

        await expect(fields.softDelete(created.data.id, "not-a-uuid")).rejects.toThrow();
        expect((await fields.get(created.data.id))?.deletedAt).toBeNull();

        expect((await fields.softDelete(created.data.id, null)).ok).toBe(true);
        await expect(fields.restore(created.data.id, "not-a-uuid")).rejects.toThrow();
        const afterRestore = await sql<Array<{ deleted: boolean }>>`
          SELECT deleted_at IS NOT NULL AS deleted
          FROM grids.fields
          WHERE id = ${created.data.id}::uuid
        `;
        expect(afterRestore[0]?.deleted).toBe(true);
      } finally {
        await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
      }
    },
    30_000,
  );

  postgresTest(
    "records every materially changed field property in the update audit diff",
    async () => {
      await migrate();
      const fixture = await createTableFixture(`Field diff ${Bun.randomUUIDv7()}`);
      try {
        const created = await fields.create(
          {
            tableId: fixture.tableId,
            name: "Before",
            description: "old description",
            icon: "old-icon",
            type: "text",
            config: { maxLength: 20 },
            position: 1,
            required: false,
            presentable: false,
            hideInTable: false,
            defaultValue: "old default",
            uniqueConstraint: true,
          },
          null,
        );
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error.message);

        const updated = await fields.update(
          created.data.id,
          {
            name: "After",
            description: "new description",
            icon: "new-icon",
            config: { maxLength: 40, regex: "^new" },
            position: 4,
            required: true,
            presentable: true,
            hideInTable: true,
            defaultValue: "new default",
            uniqueConstraint: false,
          },
          null,
        );
        expect(updated.ok).toBe(true);
        const [updatedRow] = await sql<Array<{ uniqueConstraint: boolean; indexName: string | null }>>`
          SELECT f.unique_constraint AS "uniqueConstraint",
                 to_regclass(${`grids.${fieldUniqueIndexName(created.data.id)}`}::text)::text AS "indexName"
          FROM grids.fields f
          WHERE f.id = ${created.data.id}::uuid
        `;
        expect(updatedRow).toEqual({ uniqueConstraint: false, indexName: null });

        const [audit] = await sql<Array<{ diff: Record<string, { old: unknown; new: unknown }> }>>`
          SELECT diff
          FROM grids.audit_log
          WHERE table_id = ${fixture.tableId}::uuid
            AND action = 'updated'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `;
        expect(Object.keys(audit?.diff ?? {}).sort()).toEqual(
          [
            "config",
            "defaultValue",
            "description",
            "hideInTable",
            "icon",
            "name",
            "position",
            "presentable",
            "required",
            "uniqueConstraint",
          ].sort(),
        );
        expect(audit?.diff.name).toEqual({ old: "Before", new: "After" });
        expect(audit?.diff.config).toEqual({ old: { maxLength: 20 }, new: { maxLength: 40, regex: "^new" } });
        expect(audit?.diff.defaultValue).toEqual({ old: "old default", new: "new default" });
      } finally {
        await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
      }
    },
    30_000,
  );

  postgresTest(
    "removes deleted fields from table and view presentation settings",
    async () => {
      await migrate();
      const fixture = await createTableFixture(`Presentation cleanup ${Bun.randomUUIDv7()}`);
      try {
        const created = await fields.create({ tableId: fixture.tableId, name: "Presented", type: "text" }, null);
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error.message);
        const viewId = Bun.randomUUIDv7();
        await sql`
          UPDATE grids.tables
          SET columns = ${[{ fieldId: created.data.id }]}::jsonb,
              display_config = ${{
                mode: "cards",
                cards: { imageFieldId: created.data.id, fieldIds: [created.data.id] },
              }}::jsonb
          WHERE id = ${fixture.tableId}::uuid
        `;
        await sql`
          INSERT INTO grids.views (id, short_id, table_id, base_id, name, source, ui)
          VALUES (
            ${viewId}::uuid,
            ${shortId("V")},
            ${fixture.tableId}::uuid,
            ${fixture.baseId}::uuid,
            'Presented view',
            'from table Fields',
            ${{
              columns: [{ fieldId: created.data.id }],
              displayConfig: { mode: "calendar", calendar: { dateFieldId: created.data.id } },
              groupedColumnOrder: [`group:0:${created.data.id}:year`],
              hiddenGroupedColumns: [`agg:0:${created.data.id}:count`],
            }}::jsonb
          )
        `;

        expect((await fields.softDelete(created.data.id, null)).ok).toBe(true);
        const [table] = await sql<
          Array<{ columns: unknown[]; display_config: { cards?: { imageFieldId?: string | null; fieldIds?: string[] } } }>
        >`
          SELECT columns, display_config FROM grids.tables WHERE id = ${fixture.tableId}::uuid
        `;
        const [view] = await sql<
          Array<{
            ui: {
              columns?: unknown[];
              displayConfig?: { mode?: string; calendar?: { dateFieldId?: string | null } };
              groupedColumnOrder?: string[];
              hiddenGroupedColumns?: string[];
            };
          }>
        >`SELECT ui FROM grids.views WHERE id = ${viewId}::uuid`;
        expect(table).toMatchObject({ columns: [], display_config: { cards: { imageFieldId: null, fieldIds: [] } } });
        expect(view).toEqual({
          ui: {
            columns: [],
            displayConfig: { mode: "calendar", calendar: { dateFieldId: null } },
            groupedColumnOrder: [],
            hiddenGroupedColumns: [],
          },
        });
      } finally {
        await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
      }
    },
    30_000,
  );

  postgresTest(
    "does not list trashed fields from a trashed base",
    async () => {
      await migrate();
      const fixture = await createTableFixture(`Field trash ${Bun.randomUUIDv7()}`);
      try {
        const created = await fields.create({ tableId: fixture.tableId, name: "Trash me", type: "text" }, null);
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error.message);
        expect((await fields.softDelete(created.data.id, null)).ok).toBe(true);

        expect((await fields.listTrashedByBase(fixture.baseId)).map((field) => field.id)).toEqual([created.data.id]);
        await sql`UPDATE grids.bases SET deleted_at = now() WHERE id = ${fixture.baseId}::uuid`;
        expect(await fields.listTrashedByBase(fixture.baseId)).toEqual([]);
      } finally {
        await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
      }
    },
    30_000,
  );
});
