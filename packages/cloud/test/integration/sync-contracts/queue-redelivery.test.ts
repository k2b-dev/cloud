import { afterAll, beforeAll, expect, test } from "bun:test";
import { natsSuite } from "../../../../../scripts/fixtures/test-infra";
import { openSync, until } from "./harness";

const suite = natsSuite();

suite("queue redelivery contract", () => {
  let fixture: Awaited<ReturnType<typeof openSync>>;
  const delivery = { backoffMs: [100], maxAttempts: 2, ackWaitMs: 5_000 };

  beforeAll(async () => {
    fixture = await openSync("queue");
  });
  afterAll(async () => {
    await fixture?.close();
  });

  test("a handler failure is redelivered once with attempt 2 and then succeeds", async () => {
    const queue = fixture.sync.queue<{ value: number }>({ id: "flaky", delivery });
    const attempts: number[] = [];
    const worker = await queue.process({}, async (message) => {
      attempts.push(message.attempt);
      if (message.attempt === 1) throw new Error("first attempt fails");
    });
    try {
      await queue.send({ data: { value: 1 } });
      await until(() => attempts.length === 2, 5_000, "the second delivery");
      expect(attempts).toEqual([1, 2]);
      await Bun.sleep(300);
      expect(attempts).toEqual([1, 2]);
      expect(await queue.deadLetters.list()).toEqual([]);
    } finally {
      worker.stop();
      await worker.drain();
    }
  });

  test("a handler that always fails reaches the dead-letter store after the last attempt", async () => {
    const queue = fixture.sync.queue<{ value: number }>({ id: "broken", delivery });
    const attempts: number[] = [];
    const worker = await queue.process({}, async (message) => {
      attempts.push(message.attempt);
      throw new Error("permanent failure");
    });
    try {
      const receipt = await queue.send({ data: { value: 2 } });
      await until(async () => (await queue.deadLetters.list()).length === 1, 5_000, "the dead letter");
      const [dead] = await queue.deadLetters.list();
      expect(attempts).toEqual([1, 2]);
      expect(dead).toMatchObject({ messageId: receipt.messageId, attempts: 2, data: { value: 2 }, error: "permanent failure" });
    } finally {
      worker.stop();
      await worker.drain();
    }
  });
});
