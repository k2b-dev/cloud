import { expect, test } from "bun:test";
import { createGeoBucket } from "./bucket";

test("admission sends shared keys, server clock Lua, bounded leases and releases its own lease", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const bucket = createGeoBucket({
    randomId: () => "fixed-lease",
    redis: async () => ({
      send: async (command, args) => {
        calls.push({ command, args });
        return [1, 0];
      },
    }),
  });
  const release = await bucket.acquire("autocomplete", 5);
  expect(calls[0]!.args[0]).toContain("redis.call('TIME')");
  expect(calls[0]!.args.slice(1)).toEqual([
    "2",
    "geo:{admission}:v1:bucket",
    "geo:{admission}:v1:flight:autocomplete",
    "5",
    "3500",
    "13",
    "fixed-lease",
  ]);
  await release();
  expect(calls[1]).toEqual({ command: "ZREM", args: ["geo:{admission}:v1:flight:autocomplete", "fixed-lease"] });
});
test("denied admission preserves retry time; invalid replies and failures refuse safely", async () => {
  for (const [reply, seconds] of [
    [[0, 4], 4],
    [[0, 0], 1],
    [null, 1],
    [[1], 1],
    [[1, "bad"], 1],
  ] as const) {
    const bucket = createGeoBucket({ randomId: () => "fixed", redis: async () => ({ send: async () => reply }) });
    await expect(bucket.acquire("places", 5)).rejects.toMatchObject({ code: "GEO_BUSY", details: { retryAfterSeconds: seconds } });
  }
});
test("the default lease id works without an injected generator", async () => {
  const calls: string[][] = [];
  const bucket = createGeoBucket({
    redis: async () => ({
      send: async (_command, args) => {
        calls.push(args);
        return [1, 0];
      },
    }),
  });
  await (await bucket.acquire("geocode", 5))();
  expect(calls[0]!.at(-1)).toMatch(/^[0-9a-f-]{36}$/);
});
