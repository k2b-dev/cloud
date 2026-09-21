import { afterAll, expect, test } from "bun:test";
import { redis } from "bun";
import { valkeySuite } from "../../../../scripts/fixtures/test-infra";
import { claimCacheFill, completeCacheFill } from "./cache-fill";

const suite = valkeySuite();
const key = `cache-fill-test:${crypto.randomUUID()}`;
suite("cache fill invalidation", () => {
  afterAll(async () => {
    await redis.del(key);
  });
  test("does not resurrect an invalidated or superseded read", async () => {
    const old = await claimCacheFill(key, null);
    expect(old).not.toBeNull();
    expect(await claimCacheFill(key, await redis.get(key))).toBeNull();
    await redis.del(key);
    const current = await claimCacheFill(key, null);
    await completeCacheFill(key, old, '"old"', 300);
    expect(await redis.get(key)).toBe(current);
    await completeCacheFill(key, current, '"new"', 300);
    expect(await redis.get(key)).toBe('"new"');
    expect(Number(await redis.send("TTL", [key]))).toBeGreaterThan(290);
  });
  test("an expired lease cannot overwrite a newer value", async () => {
    await redis.del(key);
    const old = await claimCacheFill(key, null);
    await redis.send("PEXPIRE", [key, "1"]);
    await Bun.sleep(10);
    await redis.set(key, '"newer"');
    await completeCacheFill(key, old, '"old"', 300);
    expect(await redis.get(key)).toBe('"newer"');
  });
  test("a corrupt observation cannot remove a concurrent replacement", async () => {
    await redis.set(key, '"fresh"');
    expect(await claimCacheFill(key, "corrupt-old-value")).toBeNull();
    expect(await redis.get(key)).toBe('"fresh"');
  });
});
