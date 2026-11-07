import assert from "node:assert/strict";

assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/cloud_identity_bench_[a-z0-9]+$/);
assert(process.send, "Provider fixture requires its benchmark parent");
const { initializePlatform } = await import("@k2b/cloud/start");
await initializePlatform({ appId: "bench-provider", source: "env" });
const { createProviderFixture } = await import("./provider-fixture");
const fixture = createProviderFixture(true);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fixture.fetch });
process.send({ url: server.url.origin, pid: process.pid });
// The parent owns this process; no persistent state needs to survive its exit.
process.on("SIGTERM", async () => {
  await server.stop(true);
  fixture.dispose();
  process.exit(0);
});
