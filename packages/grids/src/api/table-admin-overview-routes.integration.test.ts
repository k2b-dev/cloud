import { beforeAll, describe, expect } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { sql } from "bun";
import { Hono, type MiddlewareHandler } from "hono";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { tablesRoutes } from "./tables";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

const user = (id: string, name: string): User => ({
  id,
  uid: `table-overview-${id}`,
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: name,
  sn: "Admin",
  displayName: name,
  mail: null,
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
});

describe("Table administration overview route", () => {
  postgresTest("returns public Table metadata to Base admins and rejects Read access", async () => {
    const admin = user(testUuid(), "Admin");
    const reader = user(testUuid(), "Reader");
    const users = new Map([admin, reader].map((item) => [item.id, item]));
    const baseId = testUuid();
    const tableId = testUuid();
    const baseShortId = testShortId("B");
    const tableShortId = testShortId("T");
    const accessIds = [testUuid(), testUuid()];
    const auth: MiddlewareHandler<AuthContext> = async (c, next) => {
      const selected = users.get(c.req.header("x-test-user") ?? "") ?? reader;
      c.set("actor", { kind: "user", user: selected });
      c.set("accessSubject", { type: "user", userId: selected.id });
      c.set("user", selected);
      await next();
    };
    const app = new Hono<AuthContext>().use(auth).route("/tables", tablesRoutes);
    const request = (actor: User) => app.request(`/tables/by-base/${baseShortId}/admin-overview`, { headers: { "x-test-user": actor.id } });

    try {
      await sql`
        INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn) VALUES
          (${admin.id}::uuid, ${admin.uid}, 'local', 'user', ${admin.displayName}, ${admin.givenname}, ${admin.sn}),
          (${reader.id}::uuid, ${reader.uid}, 'local', 'user', ${reader.displayName}, ${reader.givenname}, ${reader.sn})
      `;
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Admin overview')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Cases')
      `;
      await sql`
        INSERT INTO auth.access (id, user_id, permission) VALUES
          (${accessIds[0]}::uuid, ${admin.id}::uuid, 'admin'),
          (${accessIds[1]}::uuid, ${reader.id}::uuid, 'read')
      `;
      await sql`
        INSERT INTO grids.base_access (base_id, access_id) VALUES
          (${baseId}::uuid, ${accessIds[0]}::uuid),
          (${baseId}::uuid, ${accessIds[1]}::uuid)
      `;

      expect((await request(reader)).status).toBe(403);
      const response = await request(admin);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { items: Array<Record<string, unknown>>; total: number };
      expect(body).toMatchObject({ total: 1, items: [{ id: tableShortId, name: "Cases", fieldCount: 0 }] });
      expect(JSON.stringify(body)).not.toContain(tableId);
      expect(body.items[0]).not.toHaveProperty("recordCount");
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id IN (${accessIds[0]}::uuid, ${accessIds[1]}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id IN (${admin.id}::uuid, ${reader.id}::uuid)`;
    }
  });
});
