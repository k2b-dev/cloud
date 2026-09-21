import { expect, test } from "bun:test";
import { RedisClient } from "bun";
import { requireInfraUrl, valkeySuite } from "../../../../scripts/fixtures/test-infra";
import { defaultRailPreferences } from "../contracts/rail-preferences";
import { createRailSnapshotReader } from "./rail-snapshot";
import { buildProjectedUser } from "./session/user";

const suite = valkeySuite();
suite("shared rail Valkey cache", () => {
  test("separate readers share one cache entry and version changes bypass it", async () => {
    const redis = new RedisClient(requireInfraUrl("valkey"));
    const keys = new Set<string>();
    const cache = {
      get: (key: string) => redis.get(key),
      set: (key: string, value: string) => {
        keys.add(key);
        return redis.set(key, value, "EX", 300);
      },
    };
    let loads = 0;
    const load = async () => {
      loads++;
      return { ...defaultRailPreferences(), managedShortcuts: [] };
    };
    const first = createRailSnapshotReader(load, cache);
    const second = createRailSnapshotReader(load, cache);
    const id = crypto.randomUUID();
    const user = (version: string) => buildProjectedUser({ id, provider: "local", profile: "user", rail_cache_version: version });
    try {
      await first(user("a"));
      await second(user("a"));
      expect(loads).toBe(1);
      await second(user("b"));
      expect(loads).toBe(2);
      for (const key of keys) expect(Number(await redis.send("TTL", [key]))).toBeGreaterThan(0);
    } finally {
      for (const key of keys) await redis.del(key);
      redis.close();
    }
  });
});
