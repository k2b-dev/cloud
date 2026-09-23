import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import type { EventQuery } from "../contracts";
import { newShortId } from "../lib/short-id";
import { queryEventMapData } from "./event-map-query";
import { withEventQuerySnapshot } from "./event-query-window";

const runDbSmoke = testInfra.database !== undefined;
const postgresTest = runDbSmoke ? test : test.skip;

beforeAll(async () => {
  if (!runDbSmoke) return;
  const { initializeSchema } = await import("../schema");
  await initializeSchema();
}, 30_000);

describe("Pulse event map Postgres smoke", () => {
  postgresTest("aggregates valid event coordinates without exposing sensitive fields", async () => {
    const baseId = crypto.randomUUID();
    await sql`INSERT INTO pulse.bases (id, short_id, name) VALUES (${baseId}::uuid, ${newShortId()}, 'Event map smoke')`;
    try {
      const longCity = "M".repeat(300);
      const events = [
        { city: "Berlin", campaign: "summer", latitude: 52.52, longitude: 13.405, value: 2 },
        { city: "Berlin", campaign: "summer", latitude: 52.52, longitude: 13.405, value: 3 },
        { city: longCity, campaign: "autumn", latitude: 48.137, longitude: 11.575, value: -4 },
        { city: "Invalid", campaign: "winter", latitude: 120, longitude: 13.405, value: 10 },
      ];
      for (const event of events) {
        await sql`
          INSERT INTO pulse.events (
            source_identity, base_id, ts, kind, value, dimensions_hash, dimensions, attributes, sensitive, payload
          ) VALUES (
            ${baseId}::uuid, ${baseId}::uuid, now(), 'qr.opened', ${event.value}, ${crypto.randomUUID()},
            (${JSON.stringify({ campaign: event.campaign })}::jsonb #>> '{}')::jsonb,
            (${JSON.stringify({ geo: { city: event.city, latitude: event.latitude, longitude: event.longitude } })}::jsonb #>> '{}')::jsonb,
            '{"ip":"203.0.113.42"}'::jsonb,
            '{}'::jsonb
          )
        `;
      }

      const query: EventQuery = {
        kind: "events",
        baseId,
        event: "qr.opened",
        since: "1h",
        dimensions: {},
        aggregation: "rows",
        bucket: "1h",
        groupBy: [],
        limit: 500,
      };
      const result = await queryEventMapData({
        query,
        latitude: { role: "attribute", path: "geo.latitude" },
        longitude: { role: "attribute", path: "geo.longitude" },
        label: { role: "attribute", path: "geo.city" },
        series: { role: "dimension", path: "campaign" },
        size: "sum",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([
        {
          label: "summer",
          data: [{ latitude: 52.52, longitude: 13.405, label: "Berlin", size: 5 }],
        },
        {
          label: "autumn",
          data: [{ latitude: 48.137, longitude: 11.575, label: longCity.slice(0, 240), size: 0 }],
        },
      ]);
      expect(JSON.stringify(result.data)).not.toContain("203.0.113.42");
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id = ${baseId}::uuid`;
    }
  });

  postgresTest("a window ending now includes every event visible in the snapshot", async () => {
    const baseId = crypto.randomUUID();
    await sql`INSERT INTO pulse.bases (id, short_id, name) VALUES (${baseId}::uuid, ${newShortId()}, 'Event window end')`;
    try {
      const query: EventQuery = {
        kind: "events",
        baseId,
        event: "qr.opened",
        since: "1h",
        dimensions: {},
        aggregation: "rows",
        bucket: "1h",
        groupBy: [],
        limit: 1,
      };
      const result = await withEventQuerySnapshot(query, async (db, range) => {
        const [row] = await db<{ covered: boolean }[]>`SELECT now() <= ${range.to} AS covered`;
        return { ok: true as const, data: row!.covered };
      });
      expect(result).toEqual({ ok: true, data: true });
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id = ${baseId}::uuid`;
    }
  });
});
