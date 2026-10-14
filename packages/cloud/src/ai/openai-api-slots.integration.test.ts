import { expect, test } from "bun:test";
import { redis } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { acquire } from "./openai-api-slots";

suiteFor("valkey")("OpenAI API distributed slots", () => {
  test("enforces limits across acquisitions, releases and removes expired leases", async () => {
    const userId = crypto.randomUUID();
    const key = `cloud:ai:openai-api:slots:${userId}`;
    const first = await acquire({ userId, limit: 2 });
    const second = await acquire({ userId, limit: 2 });
    try {
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(await acquire({ userId, limit: 2 })).toBeNull();
      await first?.release();
      const freed = await acquire({ userId, limit: 2 });
      expect(freed).not.toBeNull();
      await freed?.release();
      await redis.send("ZADD", [key, "0", "expired-slot"]);
      const afterExpiry = await acquire({ userId, limit: 2 });
      expect(afterExpiry).not.toBeNull();
      expect(await redis.send("ZSCORE", [key, "expired-slot"])).toBeNull();
      await afterExpiry?.release();
    } finally {
      await first?.release();
      await second?.release();
      await redis.del(key);
    }
  });
  test("refreshes a live lease using server time and release stops the heartbeat", async () => {
    const userId = crypto.randomUUID();
    const key = `cloud:ai:openai-api:slots:${userId}`;
    const slot = await acquire({ userId, limit: 1 });
    try {
      expect(slot).not.toBeNull();
      const initial: unknown = await redis.send("ZRANGE", [key, "0", "-1", "WITHSCORES"]);
      await new Promise((resolve) => setTimeout(resolve, 31_000));
      const refreshed: unknown = await redis.send("ZRANGE", [key, "0", "-1", "WITHSCORES"]);
      expect(refreshed).not.toEqual(initial);
      await slot?.release();
      expect(await redis.send("ZCARD", [key])).toBe(0);
    } finally {
      await slot?.release();
      await redis.del(key);
    }
  }, 35_000);
});
