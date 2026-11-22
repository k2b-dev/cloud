import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { RedisClient } from "bun";
import { requireInfraUrl, suiteFor, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { createRejectionRecorder } from "./source-rejection-recorder";
import { flushSourceRejections, rejectionIndexKey, sourceRejectionSummaries } from "./source-rejections";

suiteFor("database", "valkey")("Pulse source rejections flush from Valkey to Postgres", () => {
  const namespace = `test:pulse:rejections:${crypto.randomUUID()}`;
  const baseId = "b47f31ac-d628-4505-bfd4-b5ff86ec8a98";
  const sourceId = "c47f31ac-d628-4505-bfd4-b5ff86ec8a98";
  const now = new Date("2026-11-21T12:10:30.000Z");
  const openMinute = new Date("2026-11-21T12:10:00.000Z");
  const closedMinute = new Date("2026-11-21T12:05:00.000Z");
  let database: Awaited<ReturnType<typeof useMigratedDatabase>> | undefined;
  let redis: RedisClient;
  const recorder = (at: Date) =>
    createRejectionRecorder({
      createClient: () => new RedisClient(requireInfraUrl("valkey"), { enableOfflineQueue: false, connectionTimeout: 1000 }),
      clock: () => at,
      namespace,
    });
  const record = async (at: Date, shortId: string, reason: string) => {
    const instance = recorder(at);
    try {
      await instance.record(shortId, reason);
    } finally {
      instance.close();
    }
  };
  const flush = () => flushSourceRejections({ redis, now, namespace });
  const rows = () =>
    sql<{ minute: Date; count: number; last_reason: string; last_at: Date }[]>`
      SELECT minute,count,last_reason,last_at FROM pulse.source_rejections WHERE source_id=${sourceId}::uuid ORDER BY minute`;

  beforeAll(async () => {
    database = await useMigratedDatabase("pulse_source_rejections");
    redis = new RedisClient(requireInfraUrl("valkey"));
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,'RejBas','Rejections')`;
    await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name) VALUES(${sourceId}::uuid,'RejSrc',${baseId}::uuid,'http_ingest','Push')`;
  }, 30_000);
  afterAll(async () => {
    if (redis) {
      const members: unknown = await redis.send("ZRANGE", [rejectionIndexKey(namespace), "0", "-1"]);
      const keys = Array.isArray(members) ? members.map((member) => `${namespace}:${String(member)}`) : [];
      await redis.send("DEL", [rejectionIndexKey(namespace), ...keys]);
      redis.close();
    }
    if (database) {
      await sql.close();
      await database.drop();
    }
  });

  test("stores counts and the latest reason once, however often the flush runs", async () => {
    await record(new Date(closedMinute.getTime() + 1_000), "RejSrc", "events[0].kind: must not be empty");
    await record(new Date(closedMinute.getTime() + 2_000), "RejSrc", "metrics[2].value: expected number");
    await record(new Date(openMinute.getTime() + 5_000), "RejSrc", "Pulse base is throttled. Retry after the indicated delay.");
    // A key for a source Pulse does not know is not attributable and is never stored.
    await record(new Date(closedMinute.getTime() + 3_000), "Nobody", "events[0].kind: must not be empty");

    expect(await flush()).toEqual({ buckets: 3, stored: 2, pruned: 0 });
    const first = await rows();
    expect(first).toEqual([
      {
        minute: closedMinute,
        count: 2,
        last_reason: "metrics[2].value: expected number",
        last_at: new Date(closedMinute.getTime() + 2_000),
      },
      {
        minute: openMinute,
        count: 1,
        last_reason: "Pulse base is throttled. Retry after the indicated delay.",
        last_at: new Date(openMinute.getTime() + 5_000),
      },
    ]);
    // Final minutes leave the index; the open minute stays for the next run.
    expect(await redis.send("ZRANGE", [rejectionIndexKey(namespace), "0", "-1"])).toEqual([`RejSrc:${openMinute.getTime()}`]);

    expect(await flush()).toEqual({ buckets: 1, stored: 1, pruned: 0 });
    expect(await rows()).toEqual(first);

    await record(new Date(openMinute.getTime() + 9_000), "RejSrc", "events[1].attributes: expected record");
    await flush();
    expect((await rows())[1]).toEqual({
      minute: openMinute,
      count: 2,
      last_reason: "events[1].attributes: expected record",
      last_at: new Date(openMinute.getTime() + 9_000),
    });
    expect(await sourceRejectionSummaries([sourceId], now)).toEqual(
      new Map([[sourceId, { last24h: 4, lastReason: "events[1].attributes: expected record", lastAt: "2026-11-21T12:10:09.000Z" }]]),
    );
  }, 30_000);

  test("keeps seven days of rows", async () => {
    await sql`INSERT INTO pulse.source_rejections(source_id,minute,count,last_reason,last_at)
      VALUES(${sourceId}::uuid,'2026-11-14T12:00:00Z',5,'old','2026-11-14T12:00:10Z'),
        (${sourceId}::uuid,'2026-11-15T12:00:00Z',1,'kept','2026-11-15T12:00:10Z')`;
    expect((await flush()).pruned).toBe(1);
    const summary = (await sourceRejectionSummaries([sourceId], now)).get(sourceId);
    // The six-day-old row is outside the 24-hour count.
    expect(summary?.last24h).toBe(4);
    expect((await rows()).map((row) => row.last_reason)).toContain("kept");
    expect((await rows()).map((row) => row.last_reason)).not.toContain("old");
  }, 30_000);
});
