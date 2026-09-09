import { beforeAll, describe, expect } from "bun:test";
import type { User } from "@valentinkolb/cloud/contracts";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { sql } from "bun";
import type { MiddlewareHandler } from "hono";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { createBasesApi } from "./bases";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("preservation hold routes", () => {
  postgresTest("requires Base admin and exposes only public resource IDs", async () => {
    const userId = testUuid();
    const baseId = testUuid();
    const otherBaseId = testUuid();
    const tableId = testUuid();
    const otherTableId = testUuid();
    const accessId = testUuid();
    const baseShortId = testShortId("B");
    const otherBaseShortId = testShortId("B");
    const tableShortId = testShortId("T");
    const otherTableShortId = testShortId("T");
    const user: User = {
      id: userId,
      uid: `hold-${userId}`,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: "Hold",
      sn: "Admin",
      displayName: "Hold Admin",
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
    const app = createBasesApi({ requireAuthenticated: auth });
    const path = `/${baseShortId}/preservation-holds`;
    try {
      await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn) VALUES (${userId}::uuid, ${user.uid}, 'local', 'user', ${user.displayName}, ${user.givenname}, ${user.sn})`;
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Hold routes')`;
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${otherBaseId}::uuid, ${otherBaseShortId}, 'Other hold routes')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name, position) VALUES
          (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Invoices', 0),
          (${otherTableId}::uuid, ${otherTableShortId}, ${otherBaseId}::uuid, 'Foreign invoices', 0)
      `;
      await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${accessId}::uuid, ${userId}::uuid, 'read')`;
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${accessId}::uuid)`;
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${otherBaseId}::uuid, ${accessId}::uuid)`;

      expect((await app.request(path)).status).toBe(403);
      expect((await app.request(`${path}?q=review`)).status).toBe(403);
      expect(
        (
          await app.request(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason: "Review" }),
          })
        ).status,
      ).toBe(403);
      await sql`UPDATE auth.access SET permission = 'admin' WHERE id = ${accessId}::uuid`;

      const createdResponse = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "  Annual review  " }),
      });
      expect(createdResponse.status).toBe(201);
      const created = (await createdResponse.json()) as { id: string; baseId: string; reason: string; scope: { type: string } };
      expect(created).toMatchObject({ baseId: baseShortId, reason: "Annual review", scope: { type: "base" } });
      expect(created.id).toMatch(/^[A-Za-z0-9]{6}$/);
      expect(JSON.stringify(created)).not.toContain(baseId);

      const tableCreatedResponse = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Invoice dispute", scope: { type: "table", tableId: tableShortId } }),
      });
      expect(tableCreatedResponse.status).toBe(201);
      const tableCreated = (await tableCreatedResponse.json()) as { id: string };
      expect(tableCreated).toMatchObject({
        baseId: baseShortId,
        reason: "Invoice dispute",
        scope: { type: "table", tableId: tableShortId, tableName: "Invoices" },
      });
      expect(JSON.stringify(tableCreated)).not.toContain(tableId);
      expect(
        (
          await app.request(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason: "Wrong Base", scope: { type: "table", tableId: otherTableShortId } }),
          })
        ).status,
      ).toBe(404);

      expect(
        (
          await app.request(`/${otherBaseShortId}/preservation-holds/${created.id}/release`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason: "Wrong Base" }),
          })
        ).status,
      ).toBe(404);

      await sql`UPDATE grids.tables SET deleted_at = now() WHERE id = ${tableId}::uuid`;
      const listed = await app.request(`${path}?status=active&scope=table&tableId=${tableShortId}&page=1&per_page=10`);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({
        items: [{ id: tableCreated.id, baseId: baseShortId, status: "active", createdByDisplayName: "Hold Admin" }],
        pagination: { page: 1, per_page: 10, total: 1, has_next: false },
      });
      expect((await app.request(`${path}?status=active&scope=all&tableId=${tableShortId}`)).status).toBe(400);
      const searched = await app.request(`${path}?q=annual&page=1&per_page=1`);
      expect(await searched.json()).toMatchObject({ items: [{ id: created.id }], pagination: { total: 1 } });
      expect((await app.request(`${path}?q=${"a".repeat(201)}`)).status).toBe(400);
      const unknownTableFilter = await app.request(`${path}?status=active&scope=table&tableId=${testShortId("T")}`);
      expect(unknownTableFilter.status).toBe(200);
      expect(await unknownTableFilter.json()).toMatchObject({ items: [], pagination: { total: 0 } });

      const released = await app.request(`${path}/${created.id}/release`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Review completed" }),
      });
      expect(released.status).toBe(200);
      expect(await released.json()).toMatchObject({ id: created.id, status: "released", releaseReason: "Review completed" });
      const tableReleased = await app.request(`${path}/${tableCreated.id}/release`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Dispute resolved" }),
      });
      expect(tableReleased.status).toBe(200);
      await sql`DELETE FROM grids.tables WHERE id = ${tableId}::uuid`;
      const historical = await app.request(`${path}?status=released&scope=table&tableId=${tableShortId}`);
      expect(historical.status).toBe(200);
      expect(await historical.json()).toMatchObject({ items: [{ id: tableCreated.id }], pagination: { total: 1 } });
      expect(
        (
          await app.request(`${path}/${created.id}/release`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason: "Again" }),
          })
        ).status,
      ).toBe(409);
      expect((await app.request(`/${baseId}/preservation-holds`)).status).toBe(404);
    } finally {
      await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id = ${otherBaseId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
