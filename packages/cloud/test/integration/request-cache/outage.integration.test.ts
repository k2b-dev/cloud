import { expect, test } from "bun:test";
import { suiteFor, testInfra } from "../../../../../scripts/fixtures/test-infra";

suiteFor("database", "valkey")("request cache outage", () => {
  test("reads fall back to Postgres while Valkey is unreachable and the cache refills after reconnect", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", new URL("./outage-probe.ts", import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        DATABASE_URL: testInfra.database,
        VALKEY_URL: testInfra.valkey,
        REDIS_URL: testInfra.valkey,
        APP_SECRET: process.env.APP_SECRET,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // The probe asserts the fallback itself. While Valkey is cut, committed
    // writes log "cache invalidation failed/unavailable" warnings to stderr;
    // those are the expected degraded behavior, not a failure.
    if (code !== 0) console.error(stderr);
    expect(code).toBe(0);
    expect(stdout).toContain("Cache reconnect and refill: passed");
  }, 60_000);
});
