import { beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import { pulseCapabilities } from "./capabilities";
import { newShortId } from "./lib/short-id";
import { migrate } from "./migrate";
import { seedActiveBaseStore } from "./service/base-store.test-fixture";
import { adminFixtureIdentity } from "./store/admin-identity.test-fixture";

suiteFor("database")("saved query capability permissions, review, and retries", () => {
  beforeAll(migrate);
  test("read lists, save needs write, updates use revision, replay is stable, delete always asks", async () => {
    const otherBaseId = crypto.randomUUID(),
      otherBaseRef = newShortId();
    const baseId = crypto.randomUUID(),
      baseRef = newShortId();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES(${`pulse-cap-query-${baseId}`},'local','user','Pulse capability fixture') RETURNING id`;
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${user!.id}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO pulse.bases(id,short_id,name,created_at,updated_at)
      VALUES(${baseId}::uuid,${baseRef},'Capability queries','2026-10-20T10:00:00Z','2026-10-20T10:00:00Z')`;
    await seedActiveBaseStore(baseId);
    await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${baseId}::uuid,${grant!.id}::uuid)`;
    const context: CapabilityExecutionContext = {
      ...adminFixtureIdentity(user!.id, false),
      user: null,
      locale: "en",
      requestId: "pulse-capability-fixture",
      target: { type: "pulse.base", id: baseRef },
      origin: "http",
      signal: new AbortController().signal,
      idempotencyKey: "create-query",
    };
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${otherBaseId}::uuid,${otherBaseRef},'Other base')`;
    await seedActiveBaseStore(otherBaseId);
    await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${otherBaseId}::uuid,${grant!.id}::uuid)`;
    const input = { name: "Events", sql: "SELECT :message", params: { message: "'); DROP TABLE x; --" } };
    try {
      expect(await pulseCapabilities.queries["saved_query.list"].run({ baseId: baseRef, limit: 25 }, context)).toMatchObject({
        ok: true,
        data: { data: [] },
      });
      expect(await pulseCapabilities.actions["saved_query.save"].run(input, context)).toMatchObject({ ok: false, error: { status: 403 } });
      await sql`UPDATE auth.access SET permission='write' WHERE id=${grant!.id}::uuid`;
      const review = await pulseCapabilities.actions["saved_query.save"].review(input, context);
      expect(review).toMatchObject({ ok: true, data: { approvalScope: `pulse:base:${baseId}:saved-queries` } });
      const created = await pulseCapabilities.actions["saved_query.save"].run(input, context);
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("SAVE_FAILED");
      expect(created.data.data).toMatchObject({ revision: 1, params: input.params });
      // Both bases are writable; a query ID from A still cannot be changed through B.
      const foreign = { ...context, target: { type: "pulse.base", id: otherBaseRef }, idempotencyKey: "foreign-query" };
      const foreignInput = { ...input, queryId: created.data.data.id, expectedRevision: 1 };
      for (const operation of [pulseCapabilities.actions["saved_query.save"], pulseCapabilities.actions["saved_query.delete"]]) {
        expect(await operation.review(foreignInput, foreign)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
        expect(await operation.run(foreignInput, foreign)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      }
      expect(await pulseCapabilities.actions["saved_query.save"].run(input, context)).toEqual(created);
      const update = { ...input, queryId: created.data.data.id, expectedRevision: 1, name: "Updated" };
      const updated = await pulseCapabilities.actions["saved_query.save"].run(update, { ...context, idempotencyKey: "update-query" });
      expect(updated).toMatchObject({ ok: true, data: { data: { revision: 2 } } });
      expect(await pulseCapabilities.actions["saved_query.save"].run(update, { ...context, idempotencyKey: "stale-query" })).toMatchObject({
        ok: false,
        error: { status: 409 },
      });
      expect(await pulseCapabilities.actions["saved_query.save"].review(update, context)).toMatchObject({
        ok: false,
        error: { status: 409 },
      });
      const deletion = pulseCapabilities.actions["saved_query.delete"];
      const deleteInput = { queryId: created.data.data.id, expectedRevision: 1 };
      expect(await deletion.review(deleteInput, context)).toMatchObject({ ok: false, error: { status: 409 } });
      expect(await deletion.run(deleteInput, { ...context, idempotencyKey: "stale-delete" })).toMatchObject({
        ok: false,
        error: { status: 409 },
      });
      expect("approval" in deletion).toBe(false);
      expect(deletion.destructive).toBe(true);
      const deleted = await deletion.run(
        { queryId: created.data.data.id, expectedRevision: 2 },
        { ...context, idempotencyKey: "delete-query" },
      );
      expect(deleted).toMatchObject({ ok: true, data: { data: { deleted: true } } });
      expect(
        await deletion.run({ queryId: created.data.data.id, expectedRevision: 2 }, { ...context, idempotencyKey: "delete-query" }),
      ).toEqual(deleted);
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id IN (${baseId}::uuid, ${otherBaseId}::uuid)`;
      await sql`DELETE FROM auth.access WHERE id=${grant!.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    }
  });
});
