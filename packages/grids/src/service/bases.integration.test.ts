import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { listVisible } from "./bases";

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
