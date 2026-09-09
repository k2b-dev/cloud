import { beforeAll, describe, expect } from "bun:test";
import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { postgresTest, testShortId as shortId, testUuid as uuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import type { SqlClient } from "./audit";
import {
  captureRecordEventSnapshot,
  claimRecordEventOutboxBatch,
  dispatchRecordEventOutbox,
  enqueueRecordEvent,
  notifyRecordEventOutbox,
  reapTerminalRecordEventOutbox,
  redriveRecordEventOutbox,
  startRecordEventOutbox,
  stopRecordEventOutbox,
} from "./record-event-outbox";
import type { GridsRecordEvent } from "./record-events";
import { replayWorkflowRecordEventDeliveryFailure } from "./workflow-record-events";

type Fixture = { actorId: string; baseId: string; tableId: string; fieldId: string };

const createFixture = (): Fixture => ({ actorId: uuid(), baseId: uuid(), tableId: uuid(), fieldId: uuid() });

const insertFixture = async (fixture: Fixture): Promise<void> => {
  await sql`
    INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
    VALUES (${fixture.actorId}::uuid, ${`outbox-${fixture.actorId}`}, 'local', 'user', 'Outbox Test', 'Outbox', 'Test')
  `;
  await sql`
    INSERT INTO grids.bases (id, short_id, name, created_by)
    VALUES (${fixture.baseId}::uuid, ${shortId("B")}, 'Record event outbox', ${fixture.actorId}::uuid)
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES (${fixture.tableId}::uuid, ${shortId("T")}, ${fixture.baseId}::uuid, 'Items', 0)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
    VALUES (${fixture.fieldId}::uuid, ${shortId("F")}, ${fixture.tableId}::uuid, 'Name', 'text', '{}'::jsonb, 0)
  `;
};

const cleanupFixture = async (fixture: Fixture): Promise<void> => {
  await sql`DELETE FROM grids.audit_log WHERE base_id = ${fixture.baseId}::uuid OR table_id = ${fixture.tableId}::uuid`;
  await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
  await sql`DELETE FROM auth.users WHERE id = ${fixture.actorId}::uuid`;
};

const insertRecordAndEvent = async (client: SqlClient, fixture: Fixture, name: string): Promise<{ recordId: string; outboxId: string }> => {
  const recordId = uuid();
  await client`
    INSERT INTO grids.records (short_id, id, table_id, data, version, created_by, updated_by)
    VALUES (
      ${shortId("R")}, ${recordId}::uuid,
      ${fixture.tableId}::uuid,
      ${{ [fixture.fieldId]: name }}::jsonb,
      1,
      ${fixture.actorId}::uuid,
      ${fixture.actorId}::uuid
    )
  `;
  const outboxId = await enqueueRecordEvent(client, {
    type: "record.created",
    baseId: fixture.baseId,
    tableId: fixture.tableId,
    recordId,
    version: 1,
    changedFieldIds: [fixture.fieldId],
    actorId: fixture.actorId,
  });
  return { recordId, outboxId };
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("record event outbox integration", () => {
  postgresTest("commits records and events atomically, retries publishing, and deduplicates delivery", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const created = await sql.begin((tx) => insertRecordAndEvent(tx, fixture, "Camera"));

      const [stored] = await sql<Array<{ record_count: number; status: string; attempts: number; payload: GridsRecordEvent }>>`
        SELECT
          (SELECT count(*)::int FROM grids.records WHERE id = ${created.recordId}::uuid) AS record_count,
          status,
          attempts,
          payload
        FROM grids.record_event_outbox
        WHERE id = ${created.outboxId}::uuid
      `;
      expect(stored?.record_count).toBe(1);
      expect(stored?.status).toBe("pending");
      expect(stored?.payload).toMatchObject({
        type: "record.created",
        baseId: fixture.baseId,
        tableId: fixture.tableId,
        recordId: created.recordId,
        version: 1,
        actorId: fixture.actorId,
      });

      const publishFailure = new Error("redis unavailable");
      await expect(dispatchRecordEventOutbox(created.outboxId, async () => Promise.reject(publishFailure))).rejects.toThrow(
        "redis unavailable",
      );
      const [failed] = await sql<Array<{ status: string; attempts: number; last_error: string | null }>>`
        SELECT status, attempts, last_error FROM grids.record_event_outbox WHERE id = ${created.outboxId}::uuid
      `;
      expect(failed).toEqual({ status: "failed", attempts: 1, last_error: "redis unavailable" });

      const published: GridsRecordEvent[] = [];
      let releasePublish!: () => void;
      let markPublishStarted!: () => void;
      const publishBarrier = new Promise<void>((resolve) => {
        releasePublish = resolve;
      });
      const publishStarted = new Promise<void>((resolve) => {
        markPublishStarted = resolve;
      });
      const firstDispatch = dispatchRecordEventOutbox(created.outboxId, async (event) => {
        published.push(event);
        const connection = await sql.reserve();
        try {
          await connection`BEGIN`;
          await connection`
            SELECT id
            FROM grids.record_event_outbox
            WHERE id = ${created.outboxId}::uuid
            FOR UPDATE NOWAIT
          `;
        } finally {
          try {
            await connection`ROLLBACK`;
          } finally {
            connection.release();
          }
        }
        markPublishStarted();
        await publishBarrier;
      });
      await publishStarted;
      const concurrentDispatch = dispatchRecordEventOutbox(created.outboxId, async (event) => {
        published.push(event);
      });
      releasePublish();
      expect(await Promise.all([firstDispatch, concurrentDispatch])).toEqual(["delivered", "already-delivered"]);
      expect(published).toHaveLength(1);
      expect(published[0]).toEqual(stored?.payload);
      expect(
        await dispatchRecordEventOutbox(created.outboxId, async (event) => {
          published.push(event);
        }),
      ).toBe("already-delivered");
      expect(published).toHaveLength(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("rolls back the outbox row when the surrounding record transaction fails", async () => {
    const fixture = createFixture();
    let recordId: string | null = null;
    let outboxId: string | null = null;
    try {
      await insertFixture(fixture);
      await expect(
        sql.begin(async (tx) => {
          const created = await insertRecordAndEvent(tx, fixture, "Rolled back");
          recordId = created.recordId;
          outboxId = created.outboxId;
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");
      expect(recordId).not.toBeNull();
      expect(outboxId).not.toBeNull();
      const [counts] = await sql<Array<{ records: number; events: number }>>`
        SELECT
          (SELECT count(*)::int FROM grids.records WHERE id = ${recordId}::uuid) AS records,
          (SELECT count(*)::int FROM grids.record_event_outbox WHERE id = ${outboxId}::uuid) AS events
      `;
      expect(counts).toEqual({ records: 0, events: 0 });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("moves poison events to a terminal dead-letter state", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const created = await sql.begin((tx) => insertRecordAndEvent(tx, fixture, "Poison"));
      await sql`UPDATE grids.record_event_outbox SET attempts = 19 WHERE id = ${created.outboxId}::uuid`;
      await expect(dispatchRecordEventOutbox(created.outboxId, async () => Promise.reject(new Error("invalid event")))).rejects.toThrow(
        "invalid event",
      );
      const [row] = await sql<Array<{ status: string; attempts: number; last_error: string | null }>>`
        SELECT status, attempts, last_error FROM grids.record_event_outbox WHERE id = ${created.outboxId}::uuid
      `;
      expect(row).toEqual({ status: "dead", attempts: 20, last_error: "invalid event" });
      expect(await dispatchRecordEventOutbox(created.outboxId, async () => undefined)).toBe("dead");
      const [failure] = await sql<Array<{ id: string }>>`
        SELECT id::text
        FROM grids.record_event_delivery_failures
        WHERE base_id = ${fixture.baseId}::uuid
          AND consumer_group = 'record-event-outbox'
          AND event_id = ${created.outboxId}
          AND status = 'dead'
      `;
      expect(failure?.id).toBeString();

      expect(await replayWorkflowRecordEventDeliveryFailure(fixture.baseId, failure!.id)).toBe(true);
      expect(await redriveRecordEventOutbox(created.outboxId)).toBe(false);
      expect(await dispatchRecordEventOutbox(created.outboxId, async () => undefined)).toBe("delivered");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("reaps expired dead events together with snapshots and producer dead letters", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const created = await sql.begin(async (tx) => {
        const item = await insertRecordAndEvent(tx, fixture, "Expired dead event");
        await captureRecordEventSnapshot(tx, {
          snapshotId: item.outboxId,
          tableId: fixture.tableId,
          recordId: item.recordId,
          eventType: "record.created",
        });
        return item;
      });
      await sql`UPDATE grids.record_event_outbox SET attempts = 19 WHERE id = ${created.outboxId}::uuid`;
      await expect(dispatchRecordEventOutbox(created.outboxId, async () => Promise.reject(new Error("unavailable")))).rejects.toThrow(
        "unavailable",
      );
      await sql`UPDATE grids.record_event_outbox SET dead_at = now() - interval '91 days' WHERE id = ${created.outboxId}::uuid`;

      expect(await reapTerminalRecordEventOutbox(30, 90)).toBe(1);
      const [counts] = await sql<Array<{ events: number; snapshots: number; failures: number }>>`
        SELECT
          (SELECT count(*)::int FROM grids.record_event_outbox WHERE id = ${created.outboxId}::uuid) AS events,
          (SELECT count(*)::int FROM grids.record_event_snapshots WHERE id = ${created.outboxId}::uuid) AS snapshots,
          (SELECT count(*)::int FROM grids.record_event_delivery_failures WHERE event_id = ${created.outboxId}) AS failures
      `;
      expect(counts).toEqual({ events: 0, snapshots: 0, failures: 0 });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("rejects malformed payloads without publishing them", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const created = await sql.begin((tx) => insertRecordAndEvent(tx, fixture, "Malformed"));
      await sql`
        UPDATE grids.record_event_outbox
        SET payload = jsonb_set(payload, '{v}', '2'::jsonb)
        WHERE id = ${created.outboxId}::uuid
      `;
      let publishCalls = 0;
      await expect(
        dispatchRecordEventOutbox(created.outboxId, async () => {
          publishCalls += 1;
        }),
      ).rejects.toThrow("Invalid record event payload");
      const [row] = await sql<Array<{ status: string; attempts: number; last_error: string | null }>>`
        SELECT status, attempts, last_error
        FROM grids.record_event_outbox
        WHERE id = ${created.outboxId}::uuid
      `;
      expect(publishCalls).toBe(0);
      expect(row).toMatchObject({ status: "dead", attempts: 1 });
      expect(row?.last_error).toContain("v");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("claims disjoint backlog batches across concurrent reconcilers", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const created = await Promise.all(
        Array.from({ length: 6 }, (_, index) => insertRecordAndEvent(sql, fixture, `Backlog ${index + 1}`)),
      );
      const [first, second] = await Promise.all([claimRecordEventOutboxBatch(2), claimRecordEventOutboxBatch(2)]);
      const third = await claimRecordEventOutboxBatch(2);
      const claimed = [...first, ...second, ...third];

      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      expect(third).toHaveLength(2);
      expect(new Set(claimed).size).toBe(6);
      expect(new Set(claimed)).toEqual(new Set(created.map((item) => item.outboxId)));
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("publishes record events in durable per-record order", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const first = await insertRecordAndEvent(sql, fixture, "Ordered");
      const secondOutboxId = await enqueueRecordEvent(sql, {
        type: "record.updated",
        baseId: fixture.baseId,
        tableId: fixture.tableId,
        recordId: first.recordId,
        version: 2,
        changedFieldIds: [fixture.fieldId],
        actorId: fixture.actorId,
      });
      const independent = await insertRecordAndEvent(sql, fixture, "Independent");

      const firstClaim = await claimRecordEventOutboxBatch(10);
      expect(new Set(firstClaim)).toEqual(new Set([first.outboxId, independent.outboxId]));
      expect(firstClaim).not.toContain(secondOutboxId);

      await dispatchRecordEventOutbox(first.outboxId, async () => undefined);
      expect(await claimRecordEventOutboxBatch(10)).toContain(secondOutboxId);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("uses the PostgreSQL clock for persisted event timestamps", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const created = await insertRecordAndEvent(sql, fixture, "Clock");
      const [row] = await sql<Array<{ occurred_at: string; created_at: Date }>>`
        SELECT payload->>'occurredAt' AS occurred_at, created_at
        FROM grids.record_event_outbox
        WHERE id = ${created.outboxId}::uuid
      `;

      expect(new Date(row!.occurred_at).getTime()).toBe(row!.created_at.getTime());
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("drains same-record bursts without waiting for the reconcile interval", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      await startRecordEventOutbox();
      const first = await insertRecordAndEvent(sql, fixture, "Burst");
      const outboxIds = [first.outboxId];
      for (let version = 2; version <= 4; version += 1) {
        outboxIds.push(
          await enqueueRecordEvent(sql, {
            type: "record.updated",
            baseId: fixture.baseId,
            tableId: fixture.tableId,
            recordId: first.recordId,
            version,
            changedFieldIds: [fixture.fieldId],
            actorId: fixture.actorId,
          }),
        );
      }
      notifyRecordEventOutbox(first.outboxId);

      const deadline = performance.now() + 5_000;
      let delivered = 0;
      while (delivered < outboxIds.length && performance.now() < deadline) {
        const [row] = await sql<Array<{ count: number }>>`
          SELECT count(*)::int AS count
          FROM grids.record_event_outbox
          WHERE id = ANY(${toPgUuidArray(outboxIds)}::uuid[])
            AND status = 'delivered'
        `;
        delivered = row?.count ?? 0;
        if (delivered < outboxIds.length) await Bun.sleep(25);
      }
      expect(delivered).toBe(outboxIds.length);
    } finally {
      await stopRecordEventOutbox();
      await cleanupFixture(fixture);
    }
  });
});
