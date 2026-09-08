import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId as shortId, testUuid as uuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import * as comments from "./record-comments";

type Fixture = {
  ownerId: string;
  otherUserId: string;
  baseId: string;
  tableId: string;
  fieldId: string;
  ownerRecordId: string;
  otherRecordId: string;
};

const createFixture = (): Fixture => ({
  ownerId: uuid(),
  otherUserId: uuid(),
  baseId: uuid(),
  tableId: uuid(),
  fieldId: uuid(),
  ownerRecordId: uuid(),
  otherRecordId: uuid(),
});

const insertFixture = async (fixture: Fixture): Promise<void> => {
  await sql`
    INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn) VALUES
      (${fixture.ownerId}::uuid, ${`comment-owner-${fixture.ownerId}`}, 'local', 'user', 'Comment Owner', 'Comment', 'Owner'),
      (${fixture.otherUserId}::uuid, ${`comment-other-${fixture.otherUserId}`}, 'local', 'user', 'Other User', 'Other', 'User')
  `;
  await sql`
    INSERT INTO grids.bases (id, short_id, name, created_by)
    VALUES (${fixture.baseId}::uuid, ${shortId("B")}, 'Record comments', ${fixture.ownerId}::uuid)
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES (${fixture.tableId}::uuid, ${shortId("T")}, ${fixture.baseId}::uuid, 'Requests', 0)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
    VALUES (${fixture.fieldId}::uuid, ${shortId("F")}, ${fixture.tableId}::uuid, 'Title', 'text', '{}'::jsonb, 0)
  `;
  await sql`
    INSERT INTO grids.records (short_id, id, table_id, data, created_by, updated_by) VALUES
      (
        ${shortId("R")}, ${fixture.ownerRecordId}::uuid,
        ${fixture.tableId}::uuid,
        ${{ [fixture.fieldId]: "Owner request" }}::jsonb,
        ${fixture.ownerId}::uuid,
        ${fixture.ownerId}::uuid
      ),
      (
        ${shortId("R")}, ${fixture.otherRecordId}::uuid,
        ${fixture.tableId}::uuid,
        ${{ [fixture.fieldId]: "Other request" }}::jsonb,
        ${fixture.otherUserId}::uuid,
        ${fixture.otherUserId}::uuid
      )
  `;
};

const cleanupFixture = async (fixture: Fixture): Promise<void> => {
  await sql`DELETE FROM grids.record_event_outbox WHERE base_id = ${fixture.baseId}::uuid`;
  await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
  await sql`DELETE FROM auth.users WHERE id IN (${fixture.ownerId}::uuid, ${fixture.otherUserId}::uuid)`;
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("record comments integration", () => {
  postgresTest("paginates comments newest-first without row-scope filtering", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      for (const body of ["First", "Second"]) {
        const created = await comments.create({
          baseId: fixture.baseId,
          tableId: fixture.tableId,
          recordId: fixture.ownerRecordId,
          actorUserId: fixture.ownerId,
          body,
        });
        expect(created.ok).toBe(true);
      }

      const firstPage = await comments.list({
        baseId: fixture.baseId,
        tableId: fixture.tableId,
        recordId: fixture.ownerRecordId,
        limit: 1,
      });
      expect(firstPage.ok).toBe(true);
      if (!firstPage.ok) return;
      expect(firstPage.data.items.map((comment) => comment.body)).toEqual(["Second"]);
      expect(firstPage.data.nextCursor).toBeString();

      const secondPage = await comments.list({
        baseId: fixture.baseId,
        tableId: fixture.tableId,
        recordId: fixture.ownerRecordId,
        cursor: firstPage.data.nextCursor,
        limit: 1,
      });
      expect(secondPage.ok).toBe(true);
      if (secondPage.ok) expect(secondPage.data.items.map((comment) => comment.body)).toEqual(["First"]);

      const hidden = await comments.list({
        baseId: fixture.baseId,
        tableId: fixture.tableId,
        recordId: fixture.otherRecordId,
      });
      expect(hidden).toEqual({ ok: true, data: { items: [], nextCursor: null } });

      const [event] = await sql<Array<{ type: string }>>`
        SELECT payload->>'type' AS type
        FROM grids.record_event_outbox
        WHERE base_id = ${fixture.baseId}::uuid
        ORDER BY created_at DESC
        LIMIT 1
      `;
      expect(event?.type).toBe("comment.created");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("keeps author mutations scoped and allows record admins to moderate", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const created = await comments.create({
        baseId: fixture.baseId,
        tableId: fixture.tableId,
        recordId: fixture.ownerRecordId,
        actorUserId: fixture.ownerId,
        body: "Please review",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const foreignEdit = await comments.update({
        baseId: fixture.baseId,
        tableId: fixture.tableId,
        recordId: fixture.ownerRecordId,
        commentId: created.data.id,
        actorUserId: fixture.otherUserId,
        canModerate: false,
        body: "Changed",
      });
      expect(foreignEdit.ok).toBe(false);
      if (!foreignEdit.ok) expect(foreignEdit.error.code).toBe("FORBIDDEN");

      const moderated = await comments.update({
        baseId: fixture.baseId,
        tableId: fixture.tableId,
        recordId: fixture.ownerRecordId,
        commentId: created.data.id,
        actorUserId: fixture.otherUserId,
        canModerate: true,
        body: "Admin correction",
      });
      expect(moderated.ok).toBe(true);
      if (moderated.ok) expect(moderated.data.body).toBe("Admin correction");

      const removed = await comments.remove({
        baseId: fixture.baseId,
        tableId: fixture.tableId,
        recordId: fixture.ownerRecordId,
        commentId: created.data.id,
        actorUserId: fixture.ownerId,
        canModerate: false,
      });
      expect(removed.ok).toBe(true);

      const listed = await comments.list({
        baseId: fixture.baseId,
        tableId: fixture.tableId,
        recordId: fixture.ownerRecordId,
      });
      expect(listed.ok).toBe(true);
      if (listed.ok) expect(listed.data.items[0]).toMatchObject({ body: null, deletedAt: expect.any(String) });
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
