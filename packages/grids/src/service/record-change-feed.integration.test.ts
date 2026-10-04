import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { awaitRecordChangeFeedHorizon, postgresTest, testShortId, testUuid as uuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import type { SqlClient } from "./audit";
import { encodeRecordChangeFeedCursor, listRecordChanges, type RecordChangeFeedItem } from "./record-change-feed";
import { captureRecordEventSnapshot, enqueueRecordEvent } from "./record-event-outbox";

const key = "record-change-feed-integration-key";

type Fixture = { actorId: string; baseId: string; tableId: string };

const insertFixture = async (): Promise<Fixture> => {
  const fixture = { actorId: uuid(), baseId: uuid(), tableId: uuid() };
  await sql`
    INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
    VALUES (${fixture.actorId}::uuid, ${`feed-${fixture.actorId}`}, 'local', 'user', 'Feed Test', 'Feed', 'Test')
  `;
  await sql`
    INSERT INTO grids.bases (id, short_id, name, created_by)
    VALUES (${fixture.baseId}::uuid, ${testShortId()}, 'Record change feed', ${fixture.actorId}::uuid)
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES (${fixture.tableId}::uuid, ${testShortId()}, ${fixture.baseId}::uuid, 'Items', 0)
  `;
  return fixture;
};

const cleanupFixture = async (fixture: Fixture): Promise<void> => {
  await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
  await sql`DELETE FROM auth.users WHERE id = ${fixture.actorId}::uuid`;
};

/** One Record write as Grids commits it: Record, outbox event and snapshot in the caller's transaction. */
const createRecord = async (client: SqlClient, fixture: Fixture): Promise<string> => {
  const recordId = uuid();
  const shortId = testShortId();
  await client`
    INSERT INTO grids.records (id, short_id, table_id, data, version, created_by, updated_by)
    VALUES (${recordId}::uuid, ${shortId}, ${fixture.tableId}::uuid, '{}'::jsonb, 1, ${fixture.actorId}::uuid, ${fixture.actorId}::uuid)
  `;
  const snapshotId = await enqueueRecordEvent(client, {
    type: "record.created",
    baseId: fixture.baseId,
    tableId: fixture.tableId,
    recordId,
    version: 1,
    changedFieldIds: [],
    actorId: fixture.actorId,
  });
  await captureRecordEventSnapshot(client, { snapshotId, tableId: fixture.tableId, recordId, eventType: "record.created" });
  return shortId;
};

/** Reads every page an integration would read right now, starting at `cursor`. */
const drain = async (fixture: Fixture, cursor: string | null): Promise<{ items: RecordChangeFeedItem[]; cursor: string | null }> => {
  const items: RecordChangeFeedItem[] = [];
  for (;;) {
    const page = await listRecordChanges({ scope: { baseId: fixture.baseId }, cursor, limit: 1, cursorSigningKey: key });
    if (!page.ok) throw new Error(page.error.message);
    items.push(...page.data.items);
    cursor = page.data.cursor;
    if (!page.data.hasMore) return { items, cursor };
  }
};

const day = 24 * 60 * 60 * 1_000;
const expired = {
  ok: false,
  error: { code: "CONFLICT", status: 409, message: "The Record change-feed cursor has expired. Perform a full Record rescan." },
} as const;

/** Event times of the fixture's Base in feed order. */
const eventTimes = async (fixture: Fixture): Promise<Array<{ id: string; createdAt: Date }>> =>
  await sql<Array<{ id: string; createdAt: Date }>>`
    SELECT id::text, created_at AS "createdAt" FROM grids.record_event_outbox
    WHERE base_id = ${fixture.baseId}::uuid
    ORDER BY txid, created_at, id
  `;

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

describe("record change feed integration", () => {
  postgresTest("returns a change exactly once even when an older transaction commits after a newer one", async () => {
    const fixture = await insertFixture();
    try {
      let markLongWritten!: () => void;
      const longWritten = new Promise<void>((resolve) => {
        markLongWritten = resolve;
      });
      let releaseLong!: () => void;
      const longReleased = new Promise<void>((resolve) => {
        releaseLong = resolve;
      });
      // A long write (an import, say) starts first and is still open when a
      // short edit commits; an integration polls in between.
      const long = sql.begin(async (tx) => {
        const recordId = await createRecord(tx, fixture);
        markLongWritten();
        await longReleased;
        return recordId;
      });
      const interleaved = (async () => {
        await longWritten;
        const recordId = await sql.begin((tx) => createRecord(tx, fixture));
        return { recordId, page: await drain(fixture, null) };
      })().finally(releaseLong);
      const [longRecordId, short] = await Promise.all([long, interleaved]);
      // The short edit committed, but the older import was still open.
      expect(short.page).toEqual({ items: [], cursor: null });

      await awaitRecordChangeFeedHorizon();
      const second = await drain(fixture, short.page.cursor);
      expect(second.items.map((item) => item.recordId)).toEqual([longRecordId, short.recordId]);
      expect(await drain(fixture, second.cursor)).toEqual({ items: [], cursor: second.cursor });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("resumes a transaction that started before the cursor's change until the cursor expires", async () => {
    const fixture = await insertFixture();
    try {
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let releaseLate!: () => void;
      const lateReleased = new Promise<void>((resolve) => {
        releaseLate = resolve;
      });
      // The late transaction starts first but writes, and so gets its ID, after an edit.
      const late = sql.begin(async (tx) => {
        markStarted();
        await lateReleased;
        return createRecord(tx, fixture);
      });
      await started;
      await Bun.sleep(50);
      const editRecordId = await sql.begin((tx) => createRecord(tx, fixture)).finally(releaseLate);
      const lateRecordId = await late;
      await awaitRecordChangeFeedHorizon();

      const scope = { baseId: fixture.baseId };
      const first = await listRecordChanges({ scope, limit: 1, cursorSigningKey: key });
      if (!first.ok) throw new Error(first.error.message);
      expect(first.data.items.map((item) => item.recordId)).toEqual([editRecordId]);
      const [edit, older] = await eventTimes(fixture);
      expect(older!.createdAt.getTime()).toBeLessThan(edit!.createdAt.getTime());
      // The cutoff falls between both start times: the cursor is still valid,
      // the late change itself is older than the cutoff.
      const now = new Date((older!.createdAt.getTime() + edit!.createdAt.getTime()) / 2 + 30 * day);
      const resumed = await listRecordChanges({ scope, cursor: first.data.cursor, now, cursorSigningKey: key });
      if (!resumed.ok) throw new Error(resumed.error.message);
      expect(resumed.data.items.map((item) => item.recordId)).toEqual([lateRecordId]);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("pages the events of one transaction oldest first, so the cursor expires before an unread one", async () => {
    const fixture = await insertFixture();
    try {
      // One transaction ID with different times, like the events that existed before the upgrade.
      await sql.begin(async (tx) => {
        await createRecord(tx, fixture);
        await createRecord(tx, fixture);
      });
      const [lowerId, higherId] = (await eventTimes(fixture)).map((event) => event.id).toSorted();
      const now = Date.now();
      const olderAt = new Date(now - 30 * day + 60 * 60 * 1_000);
      await sql`UPDATE grids.record_event_outbox SET created_at = ${new Date(now - 60 * 60 * 1_000)} WHERE id = ${lowerId!}::uuid`;
      await sql`UPDATE grids.record_event_outbox SET created_at = ${olderAt} WHERE id = ${higherId!}::uuid`;
      await awaitRecordChangeFeedHorizon();

      const scope = { baseId: fixture.baseId };
      const first = await listRecordChanges({ scope, limit: 1, cursorSigningKey: key });
      if (!first.ok) throw new Error(first.error.message);
      expect(first.data.items.map((item) => item.occurredAt)).toEqual([olderAt.toISOString()]);
      // Two hours later the unread event may already be reaped with its
      // delivery, so the cursor must ask for a rescan instead of passing it.
      expect(
        await listRecordChanges({ scope, cursor: first.data.cursor, now: new Date(now + 2 * 60 * 60 * 1_000), cursorSigningKey: key }),
      ).toEqual(expired);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("asks for a rescan when a cursor counts transactions this server has not reached, as after a logical restore", async () => {
    const fixture = await insertFixture();
    try {
      const [current] = await sql<Array<{ txid: string }>>`SELECT pg_current_xact_id()::text AS txid`;
      const scope = { baseId: fixture.baseId };
      // The server the cursor came from had counted further than this one.
      const cursor = encodeRecordChangeFeedCursor(
        scope,
        { txid: String(BigInt(current!.txid) + 1_000_000n), eventId: uuid(), occurredAt: new Date().toISOString() },
        key,
      );
      await sql.begin((tx) => createRecord(tx, fixture));
      await awaitRecordChangeFeedHorizon();

      expect(await listRecordChanges({ scope, cursor, cursorSigningKey: key })).toEqual(expired);
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
