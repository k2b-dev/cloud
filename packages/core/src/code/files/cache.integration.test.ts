import { expect, test } from "bun:test";
import { redis } from "@k2b/cloud";
import { CODE_FILE_LIMITS } from "@k2b/cloud/code";
import { valkeySuite } from "../../../../../scripts/fixtures/test-infra";
import { REFUND_FILE, RESERVE_FILE } from "./cache";

valkeySuite()("Code generated file budgets", () => {
  test("atomic reservations enforce byte and count budgets across concurrent calls", async () => {
    const key = `code:generated-budget:test:${crypto.randomUUID()}`;
    const reserve = () =>
      redis.send("EVAL", [
        RESERVE_FILE,
        "1",
        key,
        String(CODE_FILE_LIMITS.files),
        String(CODE_FILE_LIMITS.fileBytes),
        String(CODE_FILE_LIMITS.totalBytes),
        String(CODE_FILE_LIMITS.ttlSeconds),
      ]);
    try {
      const replies = await Promise.all(Array.from({ length: 8 }, reserve));
      expect(replies.filter((reply) => reply === 1)).toHaveLength(5);
      expect(await redis.send("HGET", [key, "bytes"])).toBe(String(CODE_FILE_LIMITS.totalBytes));
      // Completed small files refund only unused byte reservations. Counts remain spent.
      await redis.send("HSET", [key, "count", String(CODE_FILE_LIMITS.files), "bytes", "0"]);
      expect(await reserve()).toBe(0);
      expect(Number(await redis.send("TTL", [key]))).toBeGreaterThan(0);
      await redis.del(key);
      expect(await redis.send("EVAL", [REFUND_FILE, "1", key, "-1"])).toBe(0);
      expect(await redis.send("EXISTS", [key])).toBe(0);
    } finally {
      await redis.del(key);
    }
  });
});
