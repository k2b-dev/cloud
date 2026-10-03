import { afterAll, beforeAll, expect, test } from "bun:test";
import { createSync, type Sync, type Topic } from "@k2b/sync";
import { sql } from "bun";
import { z } from "zod";
import { connectTestNats, suiteFor, testInfra, testSyncNamespace, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import { defineLive, liveOutbox, liveTopicConfig, startLiveOutbox } from "./live";

const APP = "eventstest";
const live = defineLive({ appId: APP, event: z.object({ n: z.number().int() }) });

let sync: Sync;
let topic: Topic<unknown>;
let connection: Awaited<ReturnType<typeof connectTestNats>>;
let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;

// The file owns a private database: it asserts that the whole outbox is empty.
beforeAll(async () => {
  if (!testInfra.database || !testInfra.nats) return;
  database = await useFreshDatabase("events_outbox");
  connection = await connectTestNats({ ignoreClusterUpdates: true });
  sync = createSync({ connection, namespace: testSyncNamespace("events-live"), application: APP, defaults: { replicas: 1 } });
  bindProcessSync(sync);
  topic = sync.topic(liveTopicConfig(APP));
});

afterAll(async () => {
  if (!database) return;
  await sync.drain({ timeoutMs: 5_000 });
  unbindProcessSync();
  await connection.drain();
  await sql.close();
  await database.drop();
});

const pending = async (): Promise<{ ordering_key: string; payload: unknown; attempts: number }[]> =>
  sql`SELECT ordering_key, payload, attempts FROM events.outbox ORDER BY seq`;

const publishedAfter = async (after: string): Promise<unknown[]> => {
  const events: unknown[] = [];
  for await (const event of topic.replay({ after })) events.push(event.data);
  return events;
};

const numberOf = (payload: unknown): number => z.object({ d: z.object({ n: z.number() }) }).parse(payload).d.n;

const toTopic = (row: { id: string; ordering_key: string; payload: unknown }) =>
  topic.publish({ data: row.payload, orderingKey: row.ordering_key, idempotencyKey: row.id });

suiteFor("database", "nats")("live outbox", () => {
  test("an application does not start before Core created the outbox", async () => {
    await expect(startLiveOutbox("inventory")).rejects.toThrow(/names "eventstest", but this process starts "inventory"/);
    await expect(startLiveOutbox(APP)).rejects.toThrow(/Update Cloud Core first/);
    const { runCoreSetup } = await import("../../../core/src/runtime-helpers");
    await runCoreSetup();
  });

  test("a rollback writes nothing; a commit publishes once and leaves no row", async () => {
    const after = await live.cursor();
    await sql
      .begin(async (tx) => {
        await live.publish(tx, { key: "a", data: { n: 1 } });
        throw new Error("domain write failed");
      })
      .catch(() => undefined);
    expect(await pending()).toEqual([]);

    await sql.begin((tx) => live.publish(tx, { key: "a", data: { n: 2 } }));
    const stop = await startLiveOutbox(APP);
    try {
      live.wake();
      for (let attempt = 0; attempt < 50 && (await pending()).length > 0; attempt++) await Bun.sleep(100);
    } finally {
      await stop?.();
    }
    expect(await pending()).toEqual([]);
    expect(await publishedAfter(after)).toEqual([{ v: 1, k: "a", d: { n: 2 } }]);

    const updates = live.subscribe({ after })[Symbol.asyncIterator]();
    const first = await updates.next();
    await updates.return(undefined);
    expect(first.value).toMatchObject({ key: "a", data: { n: 2 } });
  });

  test("a subscriber receives the schema output once, and data that does not survive JSON fails the write", async () => {
    const transformed = defineLive({ appId: APP, event: z.object({ n: z.string().transform(Number) }) });
    const after = await transformed.cursor();
    await sql.begin((tx) => transformed.publish(tx, { key: "transform", data: { n: "42" } }));
    expect((await pending()).map((row) => row.payload)).toEqual([{ v: 1, k: "transform", d: { n: "42" } }]);
    await liveOutbox(APP, toTopic).reconcile();
    const updates = transformed.subscribe({ after })[Symbol.asyncIterator]();
    const first = await updates.next();
    await updates.return(undefined);
    expect(first.value).toMatchObject({ key: "transform", data: { n: 42 } });

    const dated = defineLive({ appId: APP, event: z.object({ at: z.date() }) });
    await expect(sql.begin((tx) => dated.publish(tx, { key: "date", data: { at: new Date() } }))).rejects.toThrow();
    expect(await pending()).toEqual([]);
  });

  test("rows of one key keep their order and a failing row blocks no other key", async () => {
    await sql.begin(async (tx) => {
      await live.publish(tx, { key: "k", data: { n: 1 } });
      await live.publish(tx, { key: "k", data: { n: 2 } });
      await live.publish(tx, { key: "other", data: { n: 3 } });
    });
    const delivered: number[] = [];
    let failing = true;
    const outbox = liveOutbox(APP, async (row) => {
      if (failing && row.ordering_key === "k") throw new Error("topic unavailable");
      delivered.push(numberOf(row.payload));
    });

    // The second row of "k" waits behind the first, even in the same batch.
    expect((await outbox.claim()).map((row) => row.ordering_key).sort()).toEqual(["k", "other"]);
    await sql`UPDATE events.outbox SET claimed_until = NULL`;
    await outbox.reconcile();
    expect(delivered).toEqual([3]);
    expect((await pending()).map((row) => [row.ordering_key, row.attempts])).toEqual([
      ["k", 1],
      ["k", 0],
    ]);

    failing = false;
    await sql`UPDATE events.outbox SET next_attempt_at = now()`;
    await outbox.reconcile();
    expect(delivered).toEqual([3, 1, 2]);
    expect(await pending()).toEqual([]);
  });

  test("a retry after an uncertain publish delivers the event once", async () => {
    const after = await live.cursor();
    await sql.begin((tx) => live.publish(tx, { key: "retry", data: { n: 4 } }));
    const outbox = liveOutbox(APP, toTopic);
    const [row] = await outbox.claim();
    if (!row) throw new Error("Expected a claimable row");
    // The topic accepted the event, but the dispatcher did not learn it.
    await outbox.dispatch(row, async (claimed) => {
      await toTopic(claimed);
      throw new Error("connection lost");
    });
    await sql`UPDATE events.outbox SET next_attempt_at = now()`;
    await outbox.reconcile();
    expect(await pending()).toEqual([]);
    expect(await publishedAfter(after)).toEqual([{ v: 1, k: "retry", d: { n: 4 } }]);
  });

  test("two dispatchers deliver every row exactly once and in order per key", async () => {
    await sql.begin(async (tx) => {
      for (let n = 0; n < 50; n++) await live.publish(tx, { key: `key-${n % 5}`, data: { n } });
    });
    const delivered: { key: string; n: number }[] = [];
    const record = async (row: { ordering_key: string; payload: unknown }) => {
      await Bun.sleep(1);
      delivered.push({ key: row.ordering_key, n: numberOf(row.payload) });
    };
    await Promise.all([liveOutbox(APP, record).reconcile(), liveOutbox(APP, record).reconcile()]);

    expect(delivered.map(({ n }) => n).sort((left, right) => left - right)).toEqual(Array.from({ length: 50 }, (_, n) => n));
    for (let key = 0; key < 5; key++) {
      const ordered = delivered.filter((entry) => entry.key === `key-${key}`).map(({ n }) => n);
      expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
    }
    expect(await pending()).toEqual([]);
  });

  test("coalescing keeps the last payload of one transaction, and oversized data becomes a reload hint", async () => {
    const enqueue = (tx: typeof sql, n: number, coalesce: string | null) =>
      tx`SELECT events.enqueue(gen_random_uuid(), ${APP}, 'live', 'c', ${JSON.stringify({ v: 1, k: "c", d: { n } })}::text::jsonb, ${coalesce})`;
    await sql.begin(async (tx) => {
      await enqueue(tx, 1, "conversation");
      await enqueue(tx, 2, "conversation");
    });
    await sql.begin((tx) => enqueue(tx, 3, "conversation"));
    expect((await pending()).map((row) => row.payload)).toEqual([
      { v: 1, k: "c", d: { n: 2 } },
      { v: 1, k: "c", d: { n: 3 } },
    ]);
    await sql`DELETE FROM events.outbox`;

    const after = await live.cursor();
    await sql`SELECT events.enqueue(gen_random_uuid(), ${APP}, 'live', 'big', ${JSON.stringify({ v: 1, k: "big", d: "x".repeat(40_000) })}::text::jsonb)`;
    expect((await pending()).map((row) => row.payload)).toEqual([{ v: 1, k: "big", r: true }]);
    await liveOutbox(APP, toTopic).reconcile();
    const updates = live.subscribe({ after })[Symbol.asyncIterator]();
    const first = await updates.next();
    await updates.return(undefined);
    expect(first.value).toMatchObject({ key: "big", data: null });
  });
});
