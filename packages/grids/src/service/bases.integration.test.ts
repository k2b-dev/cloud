import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { listVisible, overviewActivity } from "./bases";

const postgresTest = testFor("database");
const uuid = () => Bun.randomUUIDv7();
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

describe("base visibility integration", () => {
  postgresTest("filters resource-bound listings before totals and pagination", async () => {
    const baseAId = uuid();
    const baseBId = uuid();
    const [serviceAccount] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
      VALUES ('Grids base list integration', 'resource_bound', 'grids', 'base', ${baseAId})
      RETURNING id::text AS id
    `;
    if (!serviceAccount) throw new Error("Failed to create service account fixture");

    const accessIds: string[] = [];
    try {
      await sql`
        INSERT INTO grids.bases (id, short_id, name)
        VALUES
          (${baseAId}::uuid, ${shortId("A")}, 'Bound base'),
          (${baseBId}::uuid, ${shortId("B")}, 'Other base')
      `;
      for (const baseId of [baseAId, baseBId]) {
        const [access] = await sql<{ id: string }[]>`
          INSERT INTO auth.access (service_account_id, permission)
          VALUES (${serviceAccount.id}::uuid, 'read')
          RETURNING id::text AS id
        `;
        if (!access) throw new Error("Failed to create access fixture");
        accessIds.push(access.id);
        await sql`
          INSERT INTO grids.base_access (base_id, access_id)
          VALUES (${baseId}::uuid, ${access.id}::uuid)
        `;
      }

      const firstPage = await listVisible({
        userId: null,
        userGroups: [],
        serviceAccountId: serviceAccount.id,
        baseId: baseAId,
        limit: 1,
        offset: 0,
      });
      const pastEnd = await listVisible({
        userId: null,
        userGroups: [],
        serviceAccountId: serviceAccount.id,
        baseId: baseAId,
        limit: 1,
        offset: 1,
      });

      expect(firstPage.total).toBe(1);
      expect(firstPage.items.map((base) => base.id)).toEqual([baseAId]);
      expect(pastEnd).toEqual({ items: [], total: 1 });
    } finally {
      await sql`DELETE FROM grids.bases WHERE id IN (${baseAId}::uuid, ${baseBId}::uuid)`;
      for (const accessId of accessIds) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccount.id}::uuid`;
    }
  });
});

describe("base overview activity integration", () => {
  postgresTest("counts live tables and orders tables by their newest change across the given bases", async () => {
    const baseAId = uuid();
    const baseBId = uuid();
    const otherBaseId = uuid();
    const [oldTableId, activeTableId, deletedTableId, otherTableId] = [uuid(), uuid(), uuid(), uuid()];
    try {
      await sql`
        INSERT INTO grids.bases (id, short_id, name, updated_at)
        VALUES
          (${baseAId}::uuid, ${shortId("A")}, 'Sales', '2026-01-01T00:00:00Z'),
          (${baseBId}::uuid, ${shortId("B")}, 'Empty', '2026-01-03T00:00:00Z'),
          (${otherBaseId}::uuid, ${shortId("C")}, 'Not requested', '2026-01-01T00:00:00Z')
      `;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name, updated_at, deleted_at)
        VALUES
          (${oldTableId}::uuid, ${shortId("T")}, ${baseAId}::uuid, 'Contacts', '2026-01-02T00:00:00Z', NULL),
          (${activeTableId}::uuid, ${shortId("U")}, ${baseAId}::uuid, 'Deals', '2026-01-01T00:00:00Z', NULL),
          (${deletedTableId}::uuid, ${shortId("V")}, ${baseAId}::uuid, 'Archive', '2026-01-09T00:00:00Z', now()),
          (${otherTableId}::uuid, ${shortId("W")}, ${otherBaseId}::uuid, 'Hidden', '2026-01-09T00:00:00Z', NULL)
      `;
      // A record write is newer than any schema change and moves its table to the top.
      await sql`
        INSERT INTO grids.audit_log (table_id, record_id, action, created_at)
        VALUES
          (${activeTableId}::uuid, ${uuid()}::uuid, 'updated', '2026-01-05T00:00:00Z'),
          (${activeTableId}::uuid, ${uuid()}::uuid, 'created', '2026-01-04T00:00:00Z')
      `;

      const activity = await overviewActivity({ baseIds: [baseAId, baseBId], tableLimit: 10 });

      expect(activity.tables.map((table) => [table.name, table.lastActivityAt])).toEqual([
        ["Deals", "2026-01-05T00:00:00.000Z"],
        ["Contacts", "2026-01-02T00:00:00.000Z"],
      ]);
      expect(activity.tables[0]).toMatchObject({ id: activeTableId, baseId: baseAId });
      expect(new Map(activity.bases.map((base) => [base.baseId, [base.tableCount, base.lastActivityAt]]))).toEqual(
        new Map([
          [baseAId, [2, "2026-01-05T00:00:00.000Z"]],
          [baseBId, [0, "2026-01-03T00:00:00.000Z"]],
        ]),
      );
      expect((await overviewActivity({ baseIds: [baseAId], tableLimit: 1 })).tables.map((table) => table.name)).toEqual(["Deals"]);
      expect(await overviewActivity({ baseIds: [], tableLimit: 10 })).toEqual({ bases: [], tables: [] });
    } finally {
      await sql`DELETE FROM grids.audit_log WHERE table_id = ${activeTableId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id IN (${baseAId}::uuid, ${baseBId}::uuid, ${otherBaseId}::uuid)`;
    }
  });
});
