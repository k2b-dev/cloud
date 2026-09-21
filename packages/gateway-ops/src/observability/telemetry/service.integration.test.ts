import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { getTelemetryTimeseries } from "./service";

const suite = databaseSuite();

suite("telemetry timeseries", () => {
  test("separates server errors and weights interval duration by request count", async () => {
    const appId = `timeseries-${crypto.randomUUID()}`;

    try {
      await sql`
        INSERT INTO gateway.telemetry_rollups_minute (
          bucket, app_id, route_prefix, path_template, method, status_code,
          request_count, error_count, slow_count, total_duration_ms, max_duration_ms
        )
        VALUES
          (date_trunc('minute', now()), ${appId}, '/fixture', '/fixture', 'GET', 200, 2, 0, 0, 20, 10),
          (date_trunc('minute', now()), ${appId}, '/fixture', '/fixture', 'GET', 404, 3, 3, 0, 300, 100),
          (date_trunc('minute', now()), ${appId}, '/fixture', '/fixture', 'GET', 503, 4, 4, 0, 4000, 1000)
      `;

      const points = await getTelemetryTimeseries({ range: "1h", appId });

      expect(points).toHaveLength(1);
      expect(points[0]).toMatchObject({ requests: 9, errors: 7, serverErrors: 4, avgDurationMs: 480, maxDurationMs: 1000 });
    } finally {
      await sql`DELETE FROM gateway.telemetry_rollups_minute WHERE app_id = ${appId}`;
    }
  });
});
