import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { getRecordEventDeliveryFailure, listRecordEventDeliveryFailures } from "./record-event-delivery-failures";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

const createBase = async (name: string): Promise<string> => {
  const id = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${id}::uuid, ${testShortId("B")}, ${name})`;
  return id;
};

describe("historical record event delivery failures", () => {
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
