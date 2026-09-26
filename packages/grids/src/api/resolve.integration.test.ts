import { beforeAll, describe, expect } from "bun:test";
import { cliAmbiguityText } from "@k2b/cloud/cli";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { sql } from "bun";
import type { MiddlewareHandler } from "hono";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { createResolveApi } from "./resolve";

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

type Resolved = { base: { id: string; name: string }; table: { id: string; name: string } | null; record: { id: string } | null };

describe("address resolution route", () => {
  postgresTest("resolves bases, tables, and records by ID or exact name inside the caller's access", async () => {
    const userId = testUuid();
    const accessId = testUuid();
    const [bookshopId, twinAId, twinBId, hiddenId] = [testUuid(), testUuid(), testUuid(), testUuid()];
    const [bookshop, twinA, twinB, hidden] = [testShortId("B"), testShortId("B"), testShortId("B"), testShortId("B")];
    const [authorsId, ordersId, hiddenTableId] = [testUuid(), testUuid(), testUuid()];
    const [authors, orders, hiddenTable] = [testShortId("T"), testShortId("T"), testShortId("T")];
    const [recordId, trashedId, hiddenRecordId] = [testUuid(), testUuid(), testUuid()];
    const [record, trashed, hiddenRecord] = [testShortId("R"), testShortId("R"), testShortId("R")];
    const twinName = `Twin ${userId}`;
    const user: User = {
      id: userId,
      uid: `resolve-${userId}`,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: "Resolve",
      sn: "Reader",
      displayName: "Resolve Reader",
      mail: null,
      avatarHash: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
      ipa: null,
    };
    const auth: MiddlewareHandler<AuthContext> = async (c, next) => {
      c.set("actor", { kind: "user", user });
      c.set("accessSubject", { type: "user", userId });
      c.set("user", user);
      await next();
    };
    const app = createResolveApi({ requireAuthenticated: auth });
    const resolve = async (query: Record<string, string>) => {
      const response = await app.request(`/?${new URLSearchParams(query)}`);
      return { status: response.status, body: (await response.json()) as Resolved & { message?: string } };
    };

    try {
      await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn) VALUES (${userId}::uuid, ${user.uid}, 'local', 'user', ${user.displayName}, ${user.givenname}, ${user.sn})`;
      await sql`
        INSERT INTO grids.bases (id, short_id, name) VALUES
          (${bookshopId}::uuid, ${bookshop}, ${`Bookshop ${userId}`}),
          (${twinAId}::uuid, ${twinA}, ${twinName}),
          (${twinBId}::uuid, ${twinB}, ${twinName}),
          (${hiddenId}::uuid, ${hidden}, ${twinName})
      `;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name, position) VALUES
          (${authorsId}::uuid, ${authors}, ${bookshopId}::uuid, 'Authors', 0),
          (${ordersId}::uuid, ${orders}, ${twinAId}::uuid, 'Orders', 0),
          (${hiddenTableId}::uuid, ${hiddenTable}, ${hiddenId}::uuid, 'Secrets', 0)
      `;
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, deleted_at) VALUES
          (${recordId}::uuid, ${record}, ${authorsId}::uuid, NULL),
          (${trashedId}::uuid, ${trashed}, ${authorsId}::uuid, now()),
          (${hiddenRecordId}::uuid, ${hiddenRecord}, ${hiddenTableId}::uuid, NULL)
      `;
      await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${accessId}::uuid, ${userId}::uuid, 'read')`;
      await sql`
        INSERT INTO grids.base_access (base_id, access_id) VALUES
          (${bookshopId}::uuid, ${accessId}::uuid),
          (${twinAId}::uuid, ${accessId}::uuid),
          (${twinBId}::uuid, ${accessId}::uuid)
      `;

      // A base by ID or exact name.
      expect(await resolve({ base: bookshop })).toMatchObject({ status: 200, body: { base: { id: bookshop }, table: null, record: null } });
      expect((await resolve({ base: `Bookshop ${userId}` })).body.base.id).toBe(bookshop);
      expect((await resolve({ base: `bookshop ${userId}` })).status).toBe(404);

      // Two readable bases share a name: 409 with every candidate, never a guess. The unreadable twin stays invisible.
      const twins = await resolve({ base: twinName });
      expect(twins.status).toBe(409);
      const ambiguity = (ids: string[]) =>
        cliAmbiguityText({
          value: twinName,
          resources: { en: "bases", de: "Basen" },
          candidates: ids.map((id) => ({ path: twinName, id })),
        }).en;
      expect([ambiguity([twinA, twinB]), ambiguity([twinB, twinA])]).toContain(twins.body.message!);
      expect(twins.body.message).not.toContain(hidden);
      expect((await resolve({ base: twinA })).body.base.id).toBe(twinA);

      // A table as <base>:<table>, by ID alone, or by ID outside the named base.
      expect(await resolve({ base: bookshop, table: "Authors" })).toMatchObject({
        status: 200,
        body: { base: { id: bookshop }, table: { id: authors, name: "Authors" } },
      });
      expect((await resolve({ table: authors })).body).toMatchObject({ base: { id: bookshop }, table: { id: authors } });
      expect((await resolve({ base: twinA, table: authors })).body).toMatchObject({ base: { id: bookshop }, table: { id: authors } });
      expect(await resolve({ table: "Authors" })).toMatchObject({
        status: 404,
        body: { message: expect.stringContaining("<base>:<table>") },
      });
      expect((await resolve({ base: twinA, table: "Authors" })).status).toBe(404);

      // A record by ID, live or trashed, alone or with the table and base that own it.
      expect(await resolve({ record })).toMatchObject({
        status: 200,
        body: { base: { id: bookshop }, table: { id: authors }, record: { id: record } },
      });
      expect((await resolve({ base: bookshop, table: "Authors", record: trashed })).body.record).toEqual({ id: trashed });
      expect((await resolve({ base: twinA, table: "Orders", record })).status).toBe(404);
      expect((await resolve({ base: twinA, record })).status).toBe(404);

      // Nothing leaks from a base the caller cannot read.
      expect((await resolve({ base: hidden })).status).toBe(404);
      expect((await resolve({ table: hiddenTable })).status).toBe(404);
      expect((await resolve({ record: hiddenRecord })).status).toBe(404);

      // Inputs are bounded.
      expect((await resolve({})).status).toBe(400);
      expect((await resolve({ base: "x".repeat(201) })).status).toBe(400);
      expect((await resolve({ record: "not-an-id" })).status).toBe(400);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id IN (${bookshopId}::uuid, ${twinAId}::uuid, ${twinBId}::uuid, ${hiddenId}::uuid)`;
      await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
