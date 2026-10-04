import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid as uuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import type { SqlClient } from "./audit";
import { listRecordChanges, type RecordChangeFeedItem } from "./record-change-feed";
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

/**
 * The feed withholds changes until every older transaction in the cluster has
 * ended. Waits for that horizon, so an unrelated open transaction elsewhere on
 * the test server cannot make an assertion race it.
 */
const awaitFeedHorizon = async (): Promise<void> => {
  const [current] = await sql<Array<{ txid: string }>>`SELECT pg_current_xact_id()::text AS txid`;
  for (;;) {
    const [horizon] = await sql<Array<{ passed: boolean }>>`
      SELECT ${current!.txid}::xid8 < pg_snapshot_xmin(pg_current_snapshot()) AS passed
    `;
    if (horizon?.passed) return;
    await Bun.sleep(10);
  }
};

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

      await awaitFeedHorizon();
      const second = await drain(fixture, short.page.cursor);
      expect(second.items.map((item) => item.recordId)).toEqual([longRecordId, short.recordId]);
      expect(await drain(fixture, second.cursor)).toEqual({ items: [], cursor: second.cursor });
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
