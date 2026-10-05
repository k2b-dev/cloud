import { expect } from "bun:test";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { startGridsTestSync } from "../sync-test-utils";
import { type GridsRecordEvent, publishRecordEvent, recordEventWorkQueue } from "./record-events";

const natsTest = testFor("nats");

natsTest(
  "competing workflow workers receive the events of one record in order",
  async () => {
    const stop = await startGridsTestSync();
    const event: GridsRecordEvent = {
      v: 1,
      type: "record.updated",
      baseId: Bun.randomUUIDv7(),
      tableId: Bun.randomUUIDv7(),
      recordId: Bun.randomUUIDv7(),
      version: 1,
      changedFieldIds: [],
      actorId: null,
      occurredAt: new Date().toISOString(),
    };
    try {
      const versions: Array<number | null> = [];
      const handle = async (message: { data: GridsRecordEvent }) => {
        if (message.data.recordId === event.recordId) versions.push(message.data.version);
      };
      await recordEventWorkQueue().process({ concurrency: 32 }, handle);
      await recordEventWorkQueue().process({ concurrency: 32 }, handle);
      await publishRecordEvent(event);
      await publishRecordEvent({ ...event, version: 2 });
      const deadline = Date.now() + 5_000;
      while (versions.length < 2 && Date.now() < deadline) await Bun.sleep(20);
      expect(versions).toEqual([1, 2]);
    } finally {
      await stop();
    }
  },
  30_000,
);
