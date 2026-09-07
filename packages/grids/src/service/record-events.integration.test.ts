import { expect, test } from "bun:test";
import { startGridsTestSync } from "../sync-test-utils";
import {
  type GridsRecordEvent,
  latestRecordEventCursor,
  liveRecordEvents,
  publishRecordEvent,
  recordEventWorkQueue,
} from "./record-events";

const natsTest = process.env.GRIDS_SYNC_TEST === "1" ? test : test.skip;

natsTest(
  "record events replay from opaque cursors and competing workers preserve per-record order",
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
    const abort = new AbortController();
    try {
      const origin = await latestRecordEventCursor(event.baseId);
      expect(origin).toMatch(/\.0$/);
      await publishRecordEvent(event);
      // Capture the empty origin before the first publish, then subscribe later.
      const initial = liveRecordEvents({ baseId: event.baseId, after: origin, signal: abort.signal })[Symbol.asyncIterator]();
      expect((await initial.next()).value?.data.version).toBe(1);
      await initial.return?.();
      const baseline = await latestRecordEventCursor(event.baseId);
      expect(baseline).toMatch(/^s6t\./);
      const versions: Array<number | null> = [];
      const handle = async (message: { data: GridsRecordEvent }) => {
        versions.push(message.data.version);
      };
      await recordEventWorkQueue().process({ concurrency: 32 }, handle);
      await recordEventWorkQueue().process({ concurrency: 32 }, handle);
      await publishRecordEvent({ ...event, version: 2 });
      const iterator = liveRecordEvents({ baseId: event.baseId, after: baseline, signal: abort.signal })[Symbol.asyncIterator]();
      const next = await iterator.next();
      expect(next.value?.data.version).toBe(2);
      const deadline = Date.now() + 5_000;
      while (versions.length < 2 && Date.now() < deadline) await Bun.sleep(20);
      expect(versions).toEqual([1, 2]);
      abort.abort();
      await iterator.return?.();
    } finally {
      abort.abort();
      await stop();
    }
  },
  30_000,
);
