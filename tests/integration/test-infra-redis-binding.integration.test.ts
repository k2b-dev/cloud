/**
 * Proves that Bun's default `redis` handle and an explicit `RedisClient`
 * reach the same Valkey when tests run through `bun run test`. Run it against
 * a disposable instance on a non-default port:
 *
 *   CLOUD_TEST_VALKEY_URL=redis://127.0.0.1:<port> bun run test --integration --filter test-infra-redis-binding
 */

import { afterAll, expect, test } from "bun:test";
import { RedisClient, redis } from "bun";
import { requireInfraUrl, valkeySuite } from "../../scripts/fixtures/test-infra";

const runId = async (client: RedisClient): Promise<string | undefined> => /run_id:(\S+)/.exec(await client.send("INFO", ["server"]))?.[1];

valkeySuite()("Bun default redis handle", () => {
  let explicit: RedisClient | undefined;
  afterAll(() => explicit?.close());

  test("reaches the CLOUD_TEST_VALKEY_URL instance like an explicit client", async () => {
    explicit = new RedisClient(requireInfraUrl("valkey"));
    const expected = await runId(explicit);
    expect(expected).toBeString();
    expect(await runId(redis)).toBe(expected);
  });
});
