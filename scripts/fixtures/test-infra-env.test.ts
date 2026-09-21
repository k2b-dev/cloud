import { describe, expect, test } from "bun:test";
import { infraMappings, testRuntimeEnv } from "./test-infra-env";

describe("test runtime aliases", () => {
  test("map every configured CLOUD_TEST_* target to its runtime variables", () => {
    const env = testRuntimeEnv({
      CLOUD_TEST_VALKEY_URL: " redis://127.0.0.1:57001 ",
      CLOUD_TEST_NATS_SERVERS: "nats://127.0.0.1:4222,nats://127.0.0.1:4223",
    });
    expect(env.REDIS_URL).toBe("redis://127.0.0.1:57001");
    expect(env.VALKEY_URL).toBe("redis://127.0.0.1:57001");
    expect(env.NATS_SERVERS).toBe("nats://127.0.0.1:4222,nats://127.0.0.1:4223");
    expect(env.SYNC_TEST_SERVERS).toBe(env.NATS_SERVERS);
  });

  test("map a missing or blank target to a closed loopback port instead of removing it", () => {
    const env = testRuntimeEnv({ CLOUD_TEST_DATABASE_URL: "  ", REDIS_URL: "redis://localhost:6379" });
    expect(env.DATABASE_URL).toBe("postgres://127.0.0.1:1/unset");
    expect(env.REDIS_URL).toBe("redis://127.0.0.1:1");
    expect(env.NATS_SERVERS).toBe("nats://127.0.0.1:1");
    for (const mapping of Object.values(infraMappings)) {
      for (const runtime of mapping.runtime) expect(new URL(env[runtime]!).port).toBe("1");
    }
  });
});
