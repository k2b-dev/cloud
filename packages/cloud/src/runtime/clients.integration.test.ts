import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedisClient, SQL } from "bun";
import { initializeTestPlatform, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { connections, createRedis, createSql, redis, sql } from "../index";
import { closePlatformClients } from "./clients";

afterAll(closePlatformClients);

suiteFor("database", "valkey")("native platform clients", () => {
  test("supports query helpers, transactions, reservations, file queries, listeners, native options and setters", async () => {
    await initializeTestPlatform("native-test");
    const reference = new SQL({ url: connections().database.url });
    try {
      expect(Object.getPrototypeOf(sql)).toBe(Object.getPrototypeOf(reference));
    } finally {
      await reference.close();
    }
    expect(redis).toBeInstanceOf(RedisClient);
    expect((await sql`SELECT ${41}::integer + 1 AS answer`)[0].answer).toBe(42);
    expect((await sql`SELECT ${sql.array([1, 2, 3], "INT")} AS values`)[0].values).toEqual(new Int32Array([1, 2, 3]));
    expect(await sql.begin(async (tx) => (await tx.unsafe("SELECT 42 AS answer"))[0].answer)).toBe(42);
    const pool = createSql({ max: 1 });
    const lease = await pool.reserve();
    try {
      const abort = new AbortController();
      const pending = pool.reserve({ signal: abort.signal });
      abort.abort();
      await expect(pending).rejects.toThrow();
      expect((await lease`SELECT 42 AS answer`)[0].answer).toBe(42);
    } finally {
      lease.release();
      await pool.close();
    }
    const dir = await mkdtemp(join(tmpdir(), "cloud-native-sql-"));
    try {
      const path = join(dir, "query.sql");
      await writeFile(path, "SELECT 42 AS answer");
      expect((await sql.file(path))[0].answer).toBe(42);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const channel = `cloud_native_${crypto.randomUUID().replaceAll("-", "")}`;
    let deliver: (value: string) => void = () => {};
    const received = new Promise<string>((resolve) => {
      deliver = resolve;
    });
    const subscription = await sql.listen(channel, (message) => deliver(message));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await sql`SELECT pg_notify(${channel}, ${"native"})`;
      expect(
        await Promise.race([
          received,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Notification not received")), 3_000);
          }),
        ]),
      ).toBe("native");
    } finally {
      clearTimeout(timer);
      await subscription.unlisten();
    }
    const cache = createRedis({ enableOfflineQueue: false });
    const key = `test:native:${crypto.randomUUID()}`;
    let connected = false;
    cache.onconnect = () => {
      connected = true;
    };
    try {
      await cache.connect();
      await cache.set(key, "native", "EX", "60");
      expect(await cache.get(key)).toBe("native");
      expect(connected).toBe(true);
    } finally {
      try {
        await cache.del(key);
      } finally {
        cache.close();
      }
    }
  }, 20_000);
});
