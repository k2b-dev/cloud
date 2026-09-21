import { afterAll, expect, test } from "bun:test";
import { redis } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { waitForMailProviderSlot } from "./provider-pacer";

const suite = suiteFor("database", "nats", "valkey");

suite("Mail provider pacer", () => {
  const remoteResourceId = crypto.randomUUID();
  const key = `mail:provider-pacer:${remoteResourceId}`;

  afterAll(async () => {
    await redis.del(key);
  });

  test("spaces work that shares a remote provider resource", async () => {
    const startedAt = performance.now();
    await waitForMailProviderSlot(remoteResourceId);
    await waitForMailProviderSlot(remoteResourceId);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(150);
  });
});
