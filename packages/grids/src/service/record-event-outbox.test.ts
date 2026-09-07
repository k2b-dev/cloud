import { expect, mock, test } from "bun:test";
import { dispatchRecordEventOutboxBatch } from "./record-event-outbox";

test("an aborted outbox dispatcher claims and publishes no further work", async () => {
  const publish = mock(async () => undefined);
  expect(await dispatchRecordEventOutboxBatch(AbortSignal.abort(), publish)).toBe(0);
  expect(publish).not.toHaveBeenCalled();
});
