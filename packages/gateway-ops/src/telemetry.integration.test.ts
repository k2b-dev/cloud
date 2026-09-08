import { expect, test } from "bun:test";
import { sql } from "bun";

const dbTest = process.env.GATEWAY_OPS_DB_TEST === "1" ? test : test.skip;

dbTest("cleanupTelemetry deletes expired rows in bounded batches and heartbeats after each batch", async () => {
  const { cleanupTelemetry } = await import("./telemetry");
  const appId = `test-${crypto.randomUUID()}`;
  try {
    await sql`
      INSERT INTO gateway.telemetry_events (event_id, cursor, kind, app_id, route_prefix, method, status_code, status_class, duration_ms, occurred_at)
      SELECT ${appId} || ':' || n, 'c' || n, 'request', ${appId}, '/x', 'GET', 200, 2, 1, now() - interval '30 days'
      FROM generate_series(1, 10001) AS n
    `;
    await sql`
      INSERT INTO gateway.telemetry_rollups_minute (bucket, app_id, route_prefix, method, status_code)
      VALUES (date_trunc('minute', now() - interval '400 days'), ${appId}, '/x', 'GET', 200)
    `;
    let heartbeats = 0;
    const result = await cleanupTelemetry({
      eventsDays: 14,
      rollupsDays: 90,
      heartbeat: async () => {
        heartbeats += 1;
      },
    });
    expect(result.events).toBeGreaterThanOrEqual(10_001);
    expect(result.rollups).toBeGreaterThanOrEqual(1);
    // Two event batches (10 000 + 1) and one rollup batch, plus whatever else was stale.
    expect(heartbeats).toBeGreaterThanOrEqual(3);
    const [events] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM gateway.telemetry_events WHERE app_id = ${appId}`;
    const [rollups] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM gateway.telemetry_rollups_minute WHERE app_id = ${appId}`;
    expect(events?.count).toBe(0);
    expect(rollups?.count).toBe(0);
  } finally {
    await sql`DELETE FROM gateway.telemetry_events WHERE app_id = ${appId}`;
    await sql`DELETE FROM gateway.telemetry_rollups_minute WHERE app_id = ${appId}`;
  }
});
