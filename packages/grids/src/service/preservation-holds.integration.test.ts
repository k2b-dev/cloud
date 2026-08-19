import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { admitDestruction, create, list, release } from "./preservation-holds";
import { listByBase } from "./tables";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("scoped preservation holds", () => {
  postgresTest("keeps multiple holds independent and gates destruction through the Base lock", async () => {
    const baseId = testUuid();
    const baseShortId = testShortId("B");
    const firstTableId = testUuid();
    const secondTableId = testUuid();
    const unheldTableId = testUuid();
    const foreignBaseId = testUuid();
    const firstTableShortId = testShortId("T");
    const secondTableShortId = testShortId("T");
    const unheldTableShortId = testShortId("T");
    try {
      await sql`
        INSERT INTO grids.bases (id, short_id, name) VALUES
          (${baseId}::uuid, ${baseShortId}, 'Preservation fixture'),
          (${foreignBaseId}::uuid, ${testShortId("B")}, 'Foreign preservation fixture')
      `;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name, position) VALUES
          (${firstTableId}::uuid, ${firstTableShortId}, ${baseId}::uuid, 'Invoices', 0),
          (${secondTableId}::uuid, ${secondTableShortId}, ${baseId}::uuid, 'Cases', 1),
          (${unheldTableId}::uuid, ${unheldTableShortId}, ${baseId}::uuid, 'Notes', 2)
      `;
      const matchingTables = await listByBase(baseId, { search: "invoice", limit: 1 });
      expect(matchingTables.map((table) => table.name)).toEqual(["Invoices"]);

      const baseHold = await create(
        baseId,
        { reason: "Financial review", scope: { type: "base" } },
        { id: null, displayName: "Base Admin" },
      );
      const firstTableHold = await create(
        baseId,
        { reason: "Invoice dispute", scope: { type: "table", tableId: firstTableId } },
        { id: null, displayName: "Base Admin" },
      );
      const secondTableHold = await create(
        baseId,
        { reason: "Case review", scope: { type: "table", tableId: secondTableId } },
        { id: null, displayName: "Base Admin" },
      );
      expect(baseHold.ok && baseHold.data.id).toMatch(/^[A-Za-z0-9]{6}$/);
      expect(firstTableHold.ok && firstTableHold.data.scope).toMatchObject({ type: "table", tableName: "Invoices" });
      expect(secondTableHold.ok && secondTableHold.data.id).not.toBe(baseHold.ok && baseHold.data.id);

      const active = await list(baseId, { status: "active", scope: "all", tablePublicId: null, perPage: 1, offset: 0 });
      expect(active.total).toBe(3);
      expect(active.items).toHaveLength(1);
      expect(active.items[0]?.baseId).toBe(baseShortId);
      const tableOnly = await list(baseId, {
        status: "active",
        scope: "table",
        tablePublicId: firstTableShortId,
        perPage: 25,
        offset: 0,
      });
      expect(tableOnly.items).toHaveLength(1);
      expect(tableOnly.items[0]?.scope).toMatchObject({ type: "table", tableName: "Invoices" });
      await sql.begin(async (tx) =>
        expect((await admitDestruction({ type: "table", baseId: foreignBaseId, tableId: firstTableId }, tx)).ok).toBe(false),
      );

      await sql.begin(async (tx) => expect((await admitDestruction({ type: "table", baseId, tableId: unheldTableId }, tx)).ok).toBe(false));
      if (!baseHold.ok || !firstTableHold.ok || !secondTableHold.ok) throw new Error("Hold setup failed");
      expect(
        (await release(baseId, baseHold.data.id, { reason: "Base review completed" }, { id: null, displayName: "Base Admin" })).ok,
      ).toBe(true);
      await sql`UPDATE grids.tables SET deleted_at = now() WHERE id = ${secondTableId}::uuid`;
      expect(
        (
          await list(baseId, {
            status: "active",
            scope: "table",
            tablePublicId: secondTableShortId,
            perPage: 25,
            offset: 0,
          })
        ).items,
      ).toHaveLength(1);
      await sql.begin(async (tx) => expect((await admitDestruction({ type: "table", baseId, tableId: firstTableId }, tx)).ok).toBe(false));
      await sql.begin(async (tx) => expect((await admitDestruction({ type: "table", baseId, tableId: unheldTableId }, tx)).ok).toBe(true));
      await sql.begin(async (tx) => expect((await admitDestruction({ type: "base", baseId }, tx)).ok).toBe(false));

      expect(
        (await release(baseId, firstTableHold.data.id, { reason: "Invoice dispute resolved" }, { id: null, displayName: "Base Admin" })).ok,
      ).toBe(true);
      await sql.begin(async (tx) => expect((await admitDestruction({ type: "table", baseId, tableId: firstTableId }, tx)).ok).toBe(true));
      await sql`DELETE FROM grids.tables WHERE id = ${firstTableId}::uuid`;
      await sql.begin(async (tx) => expect((await admitDestruction({ type: "base", baseId }, tx)).ok).toBe(false));
      expect(
        (await release(baseId, secondTableHold.data.id, { reason: "Case review completed" }, { id: null, displayName: "Base Admin" })).ok,
      ).toBe(true);
      await sql.begin(async (tx) => expect((await admitDestruction({ type: "base", baseId }, tx)).ok).toBe(true));

      const released = await list(baseId, { status: "released", scope: "all", tablePublicId: null, perPage: 25, offset: 0 });
      expect(released.total).toBe(3);
      expect(released.items.every((hold) => hold.status === "released" && hold.releaseReason)).toBe(true);
      expect(released.items.some((hold) => hold.scope.type === "table" && hold.scope.tableName === "Invoices")).toBe(true);
      expect(
        (
          await list(baseId, {
            status: "released",
            scope: "table",
            tablePublicId: firstTableShortId,
            perPage: 25,
            offset: 0,
          })
        ).items,
      ).toHaveLength(1);
      const audits = await sql<Array<{ action: string }>>`
        SELECT action FROM grids.audit_log WHERE base_id = ${baseId}::uuid ORDER BY created_at, id
      `;
      expect(audits.map((entry) => entry.action).sort()).toEqual([
        "preservation_hold.created",
        "preservation_hold.created",
        "preservation_hold.created",
        "preservation_hold.released",
        "preservation_hold.released",
        "preservation_hold.released",
      ]);
    } finally {
      await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id = ${foreignBaseId}::uuid`;
    }
  });

  postgresTest("serializes hold changes with admitted destruction", async () => {
    const baseId = testUuid();
    const tableId = testUuid();
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Hold lock fixture')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name, position)
        VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Locked Table', 0)
      `;
      const created = await create(
        baseId,
        { reason: "Lock review", scope: { type: "table", tableId } },
        { id: null, displayName: "Base Admin" },
      );
      if (!created.ok) throw new Error(created.error.message);

      const admissionConnection = await sql.reserve();
      let admissionOpen = false;
      try {
        await admissionConnection`BEGIN`;
        admissionOpen = true;
        expect((await admitDestruction({ type: "table", baseId, tableId }, admissionConnection)).ok).toBe(false);
        let releaseFinished = false;
        const pendingRelease = release(
          baseId,
          created.data.id,
          { reason: "Lock review complete" },
          { id: null, displayName: "Base Admin" },
        ).then((result) => {
          releaseFinished = true;
          return result;
        });
        await Bun.sleep(25);
        expect(releaseFinished).toBe(false);
        await admissionConnection`COMMIT`;
        admissionOpen = false;
        expect((await pendingRelease).ok).toBe(true);
      } finally {
        if (admissionOpen) await admissionConnection`ROLLBACK`;
        admissionConnection.release();
      }

      const destructionConnection = await sql.reserve();
      let destructionOpen = false;
      try {
        await destructionConnection`BEGIN`;
        destructionOpen = true;
        expect((await admitDestruction({ type: "table", baseId, tableId }, destructionConnection)).ok).toBe(true);
        let createFinished = false;
        const pendingCreate = create(
          baseId,
          { reason: "New review", scope: { type: "table", tableId } },
          { id: null, displayName: "Base Admin" },
        ).then((result) => {
          createFinished = true;
          return result;
        });
        await Bun.sleep(25);
        expect(createFinished).toBe(false);
        await destructionConnection`COMMIT`;
        destructionOpen = false;
        expect((await pendingCreate).ok).toBe(true);
      } finally {
        if (destructionOpen) await destructionConnection`ROLLBACK`;
        destructionConnection.release();
      }

      await sql`UPDATE grids.bases SET deleted_at = now() WHERE id = ${baseId}::uuid`;
      expect((await create(baseId, { reason: "Too late", scope: { type: "base" } }, { id: null, displayName: "Base Admin" })).ok).toBe(
        false,
      );
    } finally {
      await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });
});
