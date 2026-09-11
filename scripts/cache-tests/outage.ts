import assert from "node:assert/strict";
import { createServer, connect, type Socket } from "node:net";
import { RedisClient, sql } from "bun";

const target = new URL(process.env.REDIS_URL!);
assert.equal(target.hostname, "127.0.0.1");
assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/cloud_cache_test");
assert.equal(process.env.CLOUD_CACHE_TEST, "1");
const sockets = new Set<Socket>();
const proxy = createServer((client) => {
  const upstream = connect(Number(target.port), target.hostname);
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on("error", () => {
      client.destroy();
      upstream.destroy();
    });
    socket.on("close", () => {
      sockets.delete(socket);
      client.destroy();
      upstream.destroy();
    });
  }
  client.pipe(upstream).pipe(client);
});
const listen = (port: number) => new Promise<void>((resolve) => proxy.listen(port, "127.0.0.1", resolve));
const disconnect = async () => {
  const closed = new Promise<void>((resolve) => proxy.close(() => resolve()));
  for (const socket of sockets) socket.destroy();
  await closed;
};
await listen(0);
const address = proxy.address();
assert(address && typeof address !== "string");
process.env.REDIS_URL = process.env.VALKEY_URL = `redis://127.0.0.1:${address.port}`;
const baseline = new RedisClient(process.env.REDIS_URL);
const { requestCacheRedis } = await import("../../packages/cloud/src/services/request-cache-redis");
const { readKey } = await import("../../packages/cloud/src/services/settings/store");
const { encryptValue } = await import("../../packages/cloud/src/services/settings/crypto");
const { announcements } = await import("../../packages/cloud/src/services/announcements");
const { readRailSnapshot } = await import("../../packages/cloud/src/services/rail-snapshot");
const { buildProjectedUser } = await import("../../packages/cloud/src/services/session/user");
const userId = crypto.randomUUID();
const user = buildProjectedUser({ id: userId, uid: userId, provider: "local", profile: "user", rail_cache_version: "outage-test" });
const { migrate } = await import("../../packages/core/src/migrate/core/settings");
const cache = await requestCacheRedis();
const key = `test.outage.${crypto.randomUUID()}`;
const state = { seenAnnouncementVersion: 0, dismissedBannerVersions: [] };
// A test deadline detects offline queue regressions; it is not a runtime timeout.
const within = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Cache operation still waiting after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
try {
  assert.equal(await baseline.send("PING", []), "PONG");
  await sql`INSERT INTO settings.entries(key, value) VALUES (${key}, ${await encryptValue("before")})`;
  assert.equal(await readKey(key), "before");
  assert.equal(await cache.get(`settings:${key}`), '"before"');
  await announcements.active.forState({ state });
  await sql`INSERT INTO auth.users(id, uid, provider, profile) VALUES (${userId}, ${userId}, 'local', 'user')`;
  await readRailSnapshot(user);
  // Real established sockets are dropped and the listening port is removed.
  // Neither client under test is closed, so reconnect behavior remains real.
  await disconnect();
  for (let i = 0; cache.connected && i < 100; i++) await Bun.sleep(10);
  assert.equal(cache.connected, false);
  const baselineResult = await Promise.race([
    baseline.get(key).then(
      () => "resolved",
      () => "rejected",
    ),
    Bun.sleep(1500).then(() => "pending"),
  ]);
  console.log(`Default Redis client after TCP disconnect: ${baselineResult} after up to 1500 ms`);
  await sql`UPDATE settings.entries SET value = ${await encryptValue("after")} WHERE key = ${key}`;
  const start = performance.now();
  assert.equal(await within(readKey(key), 1500), "after");
  await within(announcements.active.forState({ state }), 1500);
  await within(readRailSnapshot(user), 1500);
  const created = await within(
    announcements.admin.create({
      actorId: userId,
      data: {
        kind: "banner",
        title: "Outage fixture",
        body: "Test",
        tone: "info",
        publishedAt: new Date().toISOString(),
        expiresAt: null,
      },
    }),
    1500,
  );
  assert(created.ok, "Committed announcement creation must succeed while cache invalidation is offline");
  assert((await within(announcements.active.forState({ state }), 1500)).banners.some((entry) => entry.id === created.data.id));
  await sql`DELETE FROM announcements.entries WHERE id = ${created.data.id}`;
  // A committed migration remains successful while its cache is disconnected.
  await within(migrate(), 1500);
  console.log(`Cache DB fallback and migration after TCP disconnect: ${Math.round(performance.now() - start)} ms`);
  await listen(address.port);
  await within(
    (async () => {
      while (!(await requestCacheRedis()).connected) await Bun.sleep(25);
    })(),
    15000,
  );
  await cache.del(`settings:${key}`);
  assert.equal(await readKey(key), "after");
  assert.equal(await cache.get(`settings:${key}`), '"after"');
  console.log("Cache reconnect and refill: passed");
} finally {
  console.log("Outage probe: releasing clients and proxy");
  baseline.close();
  cache.close();
  await disconnect();
  console.log("Outage probe: removing database fixtures");
  await sql`DELETE FROM settings.entries WHERE key = ${key}`;
  await sql`DELETE FROM auth.users WHERE id = ${userId}`;
  await sql.close();
  console.log("Outage probe: cleanup complete");
}
// The intentionally disconnected baseline client can retain native reconnect
// handles even after close(). All assertions and explicit cleanup completed;
// exit this isolated probe process rather than keeping the test runner alive.
process.exit(0);
