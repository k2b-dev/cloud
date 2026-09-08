import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import {
  getRecordEventDeliveryFailure,
  listRecordEventDeliveryFailures,
  recordRecordEventDeliveryFailure,
} from "./record-event-delivery-failures";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

const createBase = async (name: string): Promise<string> => {
  const id = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${id}::uuid, ${testShortId("B")}, ${name})`;
  return id;
};

describe("record event delivery failures", () => {
  postgresTest("transitions exactly at the attempt limit and keeps terminal data immutable", async () => {
    const baseId = await createBase("Delivery failure lifecycle");
    try {
      const input = {
        baseId,
        consumerGroup: "workflow-kernel-queue-v1",
        eventId: "event-1",
        payload: "original payload",
        error: "first error",
        maxAttempts: 3,
      };
      expect(await recordRecordEventDeliveryFailure(input)).toEqual({ attempts: 1, dead: false, alreadyDead: false });
      expect(await recordRecordEventDeliveryFailure({ ...input, error: "second error" })).toEqual({
        attempts: 2,
        dead: false,
        alreadyDead: false,
      });
      expect(await recordRecordEventDeliveryFailure({ ...input, error: "terminal error" })).toEqual({
        attempts: 3,
        dead: true,
        alreadyDead: false,
      });
      expect(await recordRecordEventDeliveryFailure({ ...input, payload: "must not replace", error: "must not replace" })).toEqual({
        attempts: 3,
        dead: true,
        alreadyDead: true,
      });
      const failures = await listRecordEventDeliveryFailures(baseId, 0);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ attempts: 3, status: "dead", error: "terminal error", payload: "original payload" });
      expect(failures[0]?.deadAt).not.toBeNull();
      expect(await getRecordEventDeliveryFailure(baseId, failures[0]!.id)).toEqual(failures[0]!);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });

  postgresTest("marks the first attempt dead when the configured limit is one", async () => {
    const baseId = await createBase("Immediate dead letter");
    try {
      const failure = await recordRecordEventDeliveryFailure({
        baseId,
        consumerGroup: "scanner",
        eventId: "event-1",
        payload: null,
        error: "invalid payload",
        maxAttempts: 1,
      });
      expect(failure).toEqual({ attempts: 1, dead: true, alreadyDead: false });
      expect(await listRecordEventDeliveryFailures(baseId)).toHaveLength(1);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });

  postgresTest("serializes concurrent attempts without losing increments", async () => {
    const baseId = await createBase("Concurrent delivery failures");
    try {
      const input = { baseId, consumerGroup: "workflow", eventId: "event-1", payload: "payload", error: "retry", maxAttempts: 4 };
      const attempts = await Promise.all(Array.from({ length: 4 }, () => recordRecordEventDeliveryFailure(input)));
      expect(attempts.some((entry) => entry.dead)).toBe(true);
      const failures = await listRecordEventDeliveryFailures(baseId, 1_000);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.attempts).toBe(4);
      expect(await getRecordEventDeliveryFailure(baseId, testUuid())).toBeNull();
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });

  postgresTest("keeps pre-cutover dead letters readable and isolated by base", async () => {
    const baseId = await createBase("Historical delivery failure");
    const otherBaseId = await createBase("Other base");
    try {
      const [inserted] = await sql<Array<{ id: string }>>`
        INSERT INTO grids.record_event_delivery_failures (
          base_id, consumer_group, event_id, payload, error, attempts, status, dead_at
        ) VALUES (${baseId}::uuid, 'workflow-kernel-queue-v1', 'old-event', 'original payload', 'terminal error', 20, 'dead', now())
        RETURNING id::text
      `;
      const dead = await listRecordEventDeliveryFailures(baseId);
      expect(dead).toHaveLength(1);
      expect(dead[0]).toMatchObject({ attempts: 20, error: "terminal error", payload: "original payload" });
      expect(await getRecordEventDeliveryFailure(baseId, inserted!.id)).toEqual(dead[0]!);
      expect(await getRecordEventDeliveryFailure(otherBaseId, inserted!.id)).toBeNull();
    } finally {
      await sql`DELETE FROM grids.bases WHERE id IN (${baseId}::uuid, ${otherBaseId}::uuid)`;
    }
  });
});
