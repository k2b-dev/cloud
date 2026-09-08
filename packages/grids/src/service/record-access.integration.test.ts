import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId as shortId, testUuid as uuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { createReader } from "./record-read";
import { createInTransaction, updateInTransaction } from "./record-write";
import { countByTable, list } from "./records";

type Fixture = {
  userId: string;
  otherUserId: string;
  baseId: string;
  parentTableId: string;
  childTableId: string;
  parentNameFieldId: string;
  childNameFieldId: string;
  relationFieldId: string;
  ownedParentId: string;
  otherParentId: string;
  linkedChildId: string;
  otherChildId: string;
};

const createFixture = (): Fixture => ({
  userId: uuid(),
  otherUserId: uuid(),
  baseId: uuid(),
  parentTableId: uuid(),
  childTableId: uuid(),
  parentNameFieldId: uuid(),
  childNameFieldId: uuid(),
  relationFieldId: uuid(),
  ownedParentId: uuid(),
  otherParentId: uuid(),
  linkedChildId: uuid(),
  otherChildId: uuid(),
});

const insertFixture = async (fixture: Fixture): Promise<void> => {
  await sql`
    INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn) VALUES
      (${fixture.userId}::uuid, ${`record-access-${fixture.userId}`}, 'local', 'user', 'Record Owner', 'Record', 'Owner'),
      (${fixture.otherUserId}::uuid, ${`record-access-${fixture.otherUserId}`}, 'local', 'user', 'Other Owner', 'Other', 'Owner')
  `;
  await sql`
    INSERT INTO grids.bases (id, short_id, name, created_by)
    VALUES (${fixture.baseId}::uuid, ${shortId("B")}, 'Record access integration', ${fixture.userId}::uuid)
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position) VALUES
      (${fixture.parentTableId}::uuid, ${shortId("P")}, ${fixture.baseId}::uuid, 'Parents', 0),
      (${fixture.childTableId}::uuid, ${shortId("C")}, ${fixture.baseId}::uuid, 'Children', 1)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position) VALUES
      (${fixture.parentNameFieldId}::uuid, ${shortId("N")}, ${fixture.parentTableId}::uuid, 'Name', 'text', '{}'::jsonb, 0),
      (${fixture.childNameFieldId}::uuid, ${shortId("N")}, ${fixture.childTableId}::uuid, 'Name', 'text', '{}'::jsonb, 0),
      (
        ${fixture.relationFieldId}::uuid,
        ${shortId("R")},
        ${fixture.childTableId}::uuid,
        'Parent',
        'relation',
        ${{ targetTableId: fixture.parentTableId, cardinality: "multiple" }}::jsonb,
        1
      )
  `;
  await sql`
    INSERT INTO grids.records (id, short_id, table_id, data, created_by, updated_by) VALUES
      (
        ${fixture.ownedParentId}::uuid,
        ${shortId("R")},
        ${fixture.parentTableId}::uuid,
        ${{ [fixture.parentNameFieldId]: "Owned parent" }}::jsonb,
        ${fixture.userId}::uuid,
        ${fixture.userId}::uuid
      ),
      (
        ${fixture.otherParentId}::uuid,
        ${shortId("R")},
        ${fixture.parentTableId}::uuid,
        ${{ [fixture.parentNameFieldId]: "Other parent" }}::jsonb,
        ${fixture.otherUserId}::uuid,
        ${fixture.otherUserId}::uuid
      ),
      (
        ${fixture.linkedChildId}::uuid,
        ${shortId("R")},
        ${fixture.childTableId}::uuid,
        ${{ [fixture.childNameFieldId]: "Linked child" }}::jsonb,
        ${fixture.otherUserId}::uuid,
        ${fixture.otherUserId}::uuid
      ),
      (
        ${fixture.otherChildId}::uuid,
        ${shortId("R")},
        ${fixture.childTableId}::uuid,
        ${{ [fixture.childNameFieldId]: "Other child" }}::jsonb,
        ${fixture.otherUserId}::uuid,
        ${fixture.otherUserId}::uuid
      )
  `;
  await sql`
    INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position) VALUES
      (${fixture.linkedChildId}::uuid, ${fixture.relationFieldId}::uuid, ${fixture.ownedParentId}::uuid, 0),
      (${fixture.otherChildId}::uuid, ${fixture.relationFieldId}::uuid, ${fixture.otherParentId}::uuid, 0)
  `;
};

const cleanupFixture = async (fixture: Fixture): Promise<void> => {
  await sql`DELETE FROM grids.audit_log WHERE base_id = ${fixture.baseId}::uuid`;
  await sql`DELETE FROM grids.record_event_outbox WHERE base_id = ${fixture.baseId}::uuid`;
  await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
  await sql`DELETE FROM auth.users WHERE id IN (${fixture.userId}::uuid, ${fixture.otherUserId}::uuid)`;
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("record access integration", () => {
  postgresTest("reads and counts every record after row scopes are removed", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const parents = await list({ tableId: fixture.parentTableId });
      expect(parents.ok).toBe(true);
      if (!parents.ok) throw new Error(parents.error.message);
      expect(parents.data.items.map((record) => record.id).sort()).toEqual([fixture.otherParentId, fixture.ownedParentId].sort());

      const children = await list({ tableId: fixture.childTableId });
      expect(children.ok).toBe(true);
      if (!children.ok) throw new Error(children.error.message);
      expect(children.data.items.map((record) => record.id).sort()).toEqual([fixture.linkedChildId, fixture.otherChildId].sort());

      const reader = await createReader(fixture.childTableId);
      expect((await reader.getMany([fixture.linkedChildId, fixture.otherChildId])).map((record) => record.id).sort()).toEqual(
        [fixture.linkedChildId, fixture.otherChildId].sort(),
      );
      expect(await countByTable([fixture.parentTableId, fixture.childTableId])).toEqual({
        [fixture.parentTableId]: 2,
        [fixture.childTableId]: 2,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("allows creates and updates independently of record ownership", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const accepted = await sql.begin((tx) =>
        createInTransaction(
          tx,
          fixture.childTableId,
          {
            [fixture.childNameFieldId]: "Accepted",
            [fixture.relationFieldId]: [fixture.ownedParentId],
          },
          fixture.userId,
          "direct",
        ),
      );
      expect(accepted.ok).toBe(true);

      const otherParentCreate = await sql.begin((tx) =>
        createInTransaction(
          tx,
          fixture.childTableId,
          {
            [fixture.childNameFieldId]: "Rejected",
            [fixture.relationFieldId]: [fixture.otherParentId],
          },
          fixture.userId,
          "direct",
        ),
      );
      expect(otherParentCreate.ok).toBe(true);

      const updated = await sql.begin((tx) =>
        updateInTransaction(
          tx,
          fixture.childTableId,
          fixture.linkedChildId,
          { [fixture.relationFieldId]: [fixture.otherParentId] },
          fixture.userId,
          "direct",
        ),
      );
      expect(updated.ok).toBe(true);

      const [link] = await sql<Array<{ to_record_id: string }>>`
        SELECT to_record_id::text
        FROM grids.record_links
        WHERE from_record_id = ${fixture.linkedChildId}::uuid
          AND from_field_id = ${fixture.relationFieldId}::uuid
      `;
      expect(link?.to_record_id).toBe(fixture.otherParentId);
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
