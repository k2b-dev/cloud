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

/** Commits `count` rows in one statement: row `n` (from 1) has key `<prefix>-<n % keys>`. */
const enqueueMany = (count: number, keys: number, prefix: string) => sql`
  SELECT events.enqueue(gen_random_uuid(), ${APP}, 'live', key, jsonb_build_object('v', 1, 'k', key, 'd', jsonb_build_object('n', n)))
  FROM generate_series(1, ${count}) n, LATERAL (SELECT ${prefix} || '-' || (n % ${keys}) AS key) keyed
`;

const pendingCount = async (): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM events.outbox`;
  return row?.count ?? -1;
};

/** Records published numbers per key; `expectInOrder()` checks that each key received its numbers ascending, none twice. */
const recorder = (delayMs = 0) => {
  const delivered = new Map<string, number[]>();
  return {
    publish: async (row: { ordering_key: string; payload: unknown }) => {
      if (delayMs > 0) await Bun.sleep(delayMs);
      const numbers = delivered.get(row.ordering_key) ?? [];
      numbers.push(numberOf(row.payload));
      delivered.set(row.ordering_key, numbers);
    },
    count: () => [...delivered.values()].reduce((sum, numbers) => sum + numbers.length, 0),
    of: (key: string) => delivered.get(key) ?? [],
    expectInOrder: () => {
      const unordered = [...delivered].filter(([, numbers]) => numbers.some((n, index) => index > 0 && n <= (numbers[index - 1] ?? n)));
      expect(unordered.map(([key]) => key)).toEqual([]);
    },
  };
};

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
  });

  test("the topic carries the JSON input, and data that does not survive JSON fails the write", async () => {
    const transformed = defineLive({ appId: APP, event: z.object({ n: z.string().transform(Number) }) });
    const after = await transformed.cursor();
    await sql.begin((tx) => transformed.publish(tx, { key: "transform", data: { n: "42" } }));
    await sql.begin((tx) => transformed.publish(tx, { key: "transform", access: true }));
    expect((await pending()).map((row) => row.payload)).toEqual([
      { v: 1, k: "transform", d: { n: "42" } },
      { v: 1, k: "transform", a: true },
    ]);
    await liveOutbox(APP, toTopic).reconcile();
    expect(await publishedAfter(after)).toEqual([
      { v: 1, k: "transform", d: { n: "42" } },
      { v: 1, k: "transform", a: true },
    ]);

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

    // One claim takes the rows of "k" in order; the failure of the first releases the second.
    expect((await outbox.claim()).map((row) => row.ordering_key)).toEqual(["k", "k", "other"]);
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

  test("concurrent claims never hold rows of one key, and two dispatchers deliver every row once and in order", async () => {
    await enqueueMany(1_000, 5, "shared");
    const record = recorder(1);
    const left = liveOutbox(APP, record.publish);
    const right = liveOutbox(APP, record.publish);
    // Two claims that overlap must not split one key: each would publish its part in parallel with the other.
    for (let round = 0; round < 20; round++) {
      const [first, second] = await Promise.all([left.claim(), right.claim()]);
      const keys = new Set(first.map((row) => row.ordering_key));
      expect(second.filter((row) => keys.has(row.ordering_key)).map((row) => row.ordering_key)).toEqual([]);
      await sql`UPDATE events.outbox SET claimed_until = NULL`;
    }

    await Promise.all([left.reconcile(), right.reconcile()]);
    expect(record.count()).toBe(1_000);
    record.expectInOrder();
    expect(await pendingCount()).toBe(0);
  });

  test("a writer that started earlier but committed later keeps its place in the order of its key", async () => {
    // A transaction that waits for a domain row lock commits after a later one: its row gets the
    // higher seq, while next_attempt_at defaults to its earlier start. Neither may let it overtake.
    const insert = (key: string, n: number, startedSecondsAgo: number) => sql`
      INSERT INTO events.outbox (id, app_id, kind, ordering_key, payload, next_attempt_at)
      VALUES (gen_random_uuid(), ${APP}, 'live', ${key}, ${JSON.stringify({ v: 1, k: key, d: { n } })}::text::jsonb,
              now() - make_interval(secs => ${startedSecondsAgo}))
    `;
    await insert("late", 1, 1);
    for (let n = 0; n < 150; n++) await insert(`between-${n}`, n, 2);
    await insert("late", 2, 3);
    const record = recorder();
    await liveOutbox(APP, record.publish).reconcile();
    expect(record.of("late")).toEqual([1, 2]);
    expect(await pendingCount()).toBe(0);
  });

  test("one process publishes Chat's peak of 1,000 rows per second when a publish takes a millisecond", async () => {
    // Spike V2: publishing row by row costs ~2 ms per row (publish p50 0.6 ms, then its own DELETE),
    // ~500 rows per second; claiming a prefix of each key reached 1,700-2,100 per process.
    await enqueueMany(4_000, 1_000, "chat");
    const record = recorder(1);
    const started = performance.now();
    await liveOutbox(APP, record.publish).reconcile();
    const seconds = (performance.now() - started) / 1_000;
    expect(record.count()).toBe(4_000);
    expect(4_000 / seconds).toBeGreaterThanOrEqual(1_000);
    record.expectInOrder();
    expect(await pendingCount()).toBe(0);
  }, 60_000);

  test("10,000 waiting rows of one key drain in seconds, a prefix per claim", async () => {
    // Spike V2: with one row of the hot key per claim and 0.15-0.7 s per claim, 2,210 of these rows
    // took 8.5 minutes; claiming a prefix of each key drained all of them in ~8 s with real publishes.
    await enqueueMany(10_000, 1, "hot");
    await enqueueMany(2_000, 1_000, "cold");
    const record = recorder();
    const outbox = liveOutbox(APP, record.publish);
    expect((await outbox.claim()).filter((row) => row.ordering_key === "hot-0")).toHaveLength(100);
    await sql`UPDATE events.outbox SET claimed_until = NULL`;

    const started = performance.now();
    await outbox.reconcile();
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(record.count()).toBe(12_000);
    record.expectInOrder();
    expect(await pendingCount()).toBe(0);
  }, 60_000);

  test("a claim stays fast while 100,000 keys wait for a retry, whatever the statistics say", async () => {
    // After a NATS outage every key of an application can wait for a retry. A busy-key check that the
    // planner turns into an unhashed NOT IN or a join against all busy rows, on statistics from before
    // or during the outage, grows with candidates times busy rows: such claims took minutes.
    const outbox = liveOutbox(APP, async () => {});
    // 200,000 rows of 180,000 keys; rows 100,001-120,000 are later rows of the keys of rows 1-20,000.
    const insert = (attempts: number, nextAttempt: string) => sql`
      INSERT INTO events.outbox (id, app_id, kind, ordering_key, payload, attempts, next_attempt_at)
      SELECT gen_random_uuid(), ${APP}, 'live', 'outage-' || CASE WHEN n BETWEEN 100001 AND 120000 THEN n - 100000 ELSE n END,
             '{"v":1}'::jsonb, ${attempts}, now() + ${nextAttempt}::interval
      FROM generate_series(1, 200000) n
    `;
    const firstRows = sql`seq IN (SELECT seq FROM events.outbox ORDER BY seq LIMIT 100000)`;
    // Rows 1-100,000 wait for a retry, so the claim skips the next 20,000 and takes rows from 120,001 on.
    const claimTakes = async (attempts: number) => {
      const started = performance.now();
      const rows = await outbox.claim();
      const milliseconds = performance.now() - started;
      expect(rows).toHaveLength(100);
      const keys = rows.map((row) => Number(row.ordering_key.slice("outage-".length)));
      expect(keys.filter((key) => key <= 120_000)).toEqual([]);
      expect(rows.filter((row) => row.attempts !== attempts)).toEqual([]);
      return milliseconds;
    };
    try {
      // Statistics taken while every row waits; then the later half comes due.
      await insert(3, "1 hour");
      await sql`ANALYZE events.outbox`;
      await sql`UPDATE events.outbox SET next_attempt_at = now() - interval '1 second' WHERE NOT ${firstRows}`;
      expect(await claimTakes(3)).toBeLessThan(5_000);

      // Statistics taken before the outage; then the first half waits for a retry.
      await sql`DELETE FROM events.outbox`;
      await insert(0, "0 seconds");
      await sql`ANALYZE events.outbox`;
      await sql`UPDATE events.outbox SET attempts = 3, next_attempt_at = now() + interval '1 hour' WHERE ${firstRows}`;
      expect(await claimTakes(0)).toBeLessThan(5_000);
    } finally {
      await sql`DELETE FROM events.outbox`;
    }
  }, 120_000);

  test("a claim gives up its turn when its statement or its client stalls for the claim period", async () => {
    // Claims take turns under a lock; a claim that outlives its claim period would only hold up the others.
    await sql`CREATE TABLE public.claim_settings (statement_timeout text, idle_timeout text)`;
    await sql`
      CREATE FUNCTION public.record_claim_settings() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO public.claim_settings VALUES (current_setting('statement_timeout'), current_setting('idle_in_transaction_session_timeout'));
        RETURN NULL;
      END $$
    `.simple();
    // After the write: `events.enqueue` is an upsert, which fires UPDATE statement triggers too.
    await live.publish(sql, { key: "settings", data: { n: 1 } });
    await sql`CREATE TRIGGER record_claim_settings AFTER UPDATE ON events.outbox FOR EACH STATEMENT EXECUTE FUNCTION public.record_claim_settings()`;
    try {
      expect(await liveOutbox(APP, async () => {}).claim()).toHaveLength(1);
      expect(await sql<{ statement_timeout: string; idle_timeout: string }[]>`SELECT * FROM public.claim_settings`).toEqual([
        { statement_timeout: "30s", idle_timeout: "30s" },
      ]);
    } finally {
      await sql`DROP TABLE public.claim_settings`;
      await sql`DROP TRIGGER record_claim_settings ON events.outbox`;
      await sql`DROP FUNCTION public.record_claim_settings()`;
      await sql`DELETE FROM events.outbox`;
    }
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
    expect(await publishedAfter(after)).toEqual([{ v: 1, k: "big", r: true }]);
  });
});
