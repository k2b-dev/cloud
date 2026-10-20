import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { updateBase } from "./base-management";
import { seedActiveBaseStore } from "./base-store.test-fixture";
import { savedQueries } from "./saved-queries";

suiteFor("database")("saved SQL queries", () => {
  beforeAll(migrate);
  test("read grants list and get; writes require write; revisions and replay are atomic", async () => {
    const baseId = crypto.randomUUID(),
      baseRef = newShortId();
    const [reader] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${`pulse-queries-${baseId}`},'local','user','Queries fixture') RETURNING id`;
    const [writer] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${`pulse-queries-w-${baseId}`},'local','user','Queries writer') RETURNING id`;
    await sql`INSERT INTO pulse.bases(id,short_id,name,created_at,updated_at) VALUES(${baseId}::uuid,${baseRef},'Saved queries fixture','2026-10-20T10:00:00Z','2026-10-20T10:00:00Z')`;
    await seedActiveBaseStore(baseId);
    const accessIds: string[] = [];
    for (const [id, permission] of [
      [reader!.id, "read"],
      [writer!.id, "write"],
    ]) {
      const [access] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access(user_id,permission) VALUES(${id}::uuid,${permission}::auth.permission_level) RETURNING id`;
      accessIds.push(access!.id);
      await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${baseId}::uuid,${access!.id}::uuid)`;
    }
    const read = { ...adminFixtureIdentity(reader!.id, false), baseId: baseRef },
      write = { ...adminFixtureIdentity(writer!.id, false), baseId };
    const input = { ...write, name: "Orders", sql: "SELECT :value", params: { value: "'); DROP TABLE x; --" }, idempotencyKey: "save-1" };
    try {
      expect(await savedQueries.list(read)).toMatchObject({ ok: true, data: { items: [], total: 0, nextOffset: null } });
      expect(await updateBase({ baseId, user: { id: writer!.id }, timezone: "Europe/Berlin" })).toMatchObject({
        ok: false,
        error: { status: 403 },
      });
      await sql`UPDATE auth.access SET permission='admin' WHERE id=${accessIds[1]}::uuid`;
      expect(await updateBase({ baseId, user: { id: writer!.id }, timezone: "Mars/Colony" })).toMatchObject({
        ok: false,
        error: { status: 400 },
      });
      await sql`UPDATE auth.access SET permission='write' WHERE id=${accessIds[1]}::uuid`;
      expect(await savedQueries.save({ ...input, ...read })).toMatchObject({ ok: false, error: { status: 403 } });
      const saved = await savedQueries.save(input);
      expect(saved.ok).toBe(true);
      if (!saved.ok) throw new Error("SAVE_FAILED");
      expect(saved.data).toMatchObject({ baseId: baseRef, revision: 1, params: input.params, createdBy: writer!.id });
      expect(await savedQueries.save(input)).toEqual(saved);
      expect(await savedQueries.save({ ...input, name: "Changed" })).toMatchObject({ ok: false, error: { status: 409 } });
      expect(await savedQueries.get({ ...read, queryId: saved.data.id })).toEqual(saved);
      expect(await savedQueries.list({ ...read, limit: 1 })).toMatchObject({
        ok: true,
        data: { total: 1, items: [saved.data], nextOffset: null },
      });
      const updated = await savedQueries.save({
        ...input,
        queryId: saved.data.id,
        expectedRevision: 1,
        idempotencyKey: "save-2",
        name: "Updated",
      });
      expect(updated).toMatchObject({ ok: true, data: { revision: 2, name: "Updated" } });
      expect(await savedQueries.save({ ...input, queryId: saved.data.id, expectedRevision: 1, idempotencyKey: "stale" })).toMatchObject({
        ok: false,
        error: { status: 409 },
      });
      expect(await savedQueries.save(input)).toEqual(saved);
      expect(await savedQueries.remove({ ...read, queryId: saved.data.id, expectedRevision: 2 })).toMatchObject({
        ok: false,
        error: { status: 403 },
      });
      const deletion = { ...write, queryId: saved.data.id, expectedRevision: 2, idempotencyKey: "delete-1" };
      expect(await savedQueries.remove({ ...deletion, expectedRevision: 1 })).toMatchObject({ ok: false, error: { status: 409 } });
      expect(await savedQueries.get({ ...read, queryId: saved.data.id })).toEqual(updated);
      expect(await savedQueries.remove(deletion)).toMatchObject({ ok: true });
      expect(await savedQueries.remove(deletion)).toMatchObject({ ok: true });
      expect(await savedQueries.get({ ...read, queryId: saved.data.id })).toMatchObject({ ok: false, error: { status: 404 } });
      // A create replay remains a receipt even after deletion; it must not recreate the row.
      expect(await savedQueries.save(input)).toEqual(saved);
      expect(await savedQueries.list(read)).toMatchObject({ ok: true, data: { items: [] } });
      await sql`UPDATE pulse.saved_query_operations SET expires_at='2000-01-01T00:00:00Z' WHERE base_id=${baseId}::uuid`;
      const afterExpiry = await savedQueries.save(input);
      expect(afterExpiry).toMatchObject({ ok: true, data: { name: "Orders", revision: 1 } });
      expect(await sql`SELECT id FROM pulse.saved_queries WHERE base_id=${baseId}::uuid`).toHaveLength(1);
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
      for (const id of accessIds) await sql`DELETE FROM auth.access WHERE id=${id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${reader!.id}::uuid OR id=${writer!.id}::uuid`;
    }
  });
  test("case-insensitive names and optimistic revision prevent concurrent duplicate changes", async () => {
    const baseId = crypto.randomUUID(),
      baseRef = newShortId();
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${`pulse-q-race-${baseId}`},'local','user','Queries race') RETURNING id`;
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,${baseRef},'Queries race')`;
    await seedActiveBaseStore(baseId);
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${user!.id}::uuid,'write') RETURNING id`;
    await sql`INSERT INTO pulse.base_access VALUES(${baseId}::uuid,${grant!.id}::uuid)`;
    const identity = { ...adminFixtureIdentity(user!.id, false), baseId };
    try {
      const creates = await Promise.all([
        savedQueries.save({ ...identity, name: "Count", sql: "SELECT 1" }),
        savedQueries.save({ ...identity, name: "COUNT", sql: "SELECT 2" }),
      ]);
      expect(creates.filter((r) => r.ok)).toHaveLength(1);
      expect(creates.filter((r) => !r.ok && r.error.status === 409)).toHaveLength(1);
      const saved = creates.find((r) => r.ok);
      if (!saved?.ok) throw new Error("SAVE_FAILED");
      const updates = await Promise.all(
        ["One", "Two"].map((name) =>
          savedQueries.save({ ...identity, queryId: saved.data.id, expectedRevision: 1, name, sql: "SELECT 1" }),
        ),
      );
      expect(updates.filter((r) => r.ok)).toHaveLength(1);
      expect(updates.filter((r) => !r.ok && r.error.status === 409)).toHaveLength(1);
      expect(await savedQueries.save({ ...identity, name: "Too large", sql: `SELECT '${"a".repeat(16384)}'` })).toMatchObject({
        ok: false,
        error: { code: "INPUT_TOO_LARGE" },
      });
      expect(await savedQueries.list({ ...identity, limit: 1001 })).toMatchObject({ ok: false, error: { status: 400 } });
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id=${grant!.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    }
  });
});
