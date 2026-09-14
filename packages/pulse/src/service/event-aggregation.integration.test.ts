import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import type { EventQuery } from "../contracts";
import { newShortId } from "../lib/short-id";
import { queryEventAggregateData } from "./query-execution";

const runDbSmoke = process.env.PULSE_EVENT_AGGREGATION_DB_TEST === "1";
const postgresTest = runDbSmoke ? test : test.skip;

beforeAll(async () => {
  if (!runDbSmoke) return;
  const { initializeSchema } = await import("../schema");
  await initializeSchema();
}, 30_000);

describe("Pulse event aggregation Postgres smoke", () => {
  postgresTest("groups event counts and counts unique actors in SQL", async () => {
    const baseId = crypto.randomUUID();
    await sql`INSERT INTO pulse.bases (id, short_id, name) VALUES (${baseId}::uuid, ${newShortId()}, 'Event aggregation smoke')`;
    try {
      const events = [
        { campaign: "summer", country: "DE", actor: "visitor-a", session: "session-a" },
        { campaign: "summer", country: "DE", actor: "visitor-b", session: "session-b" },
        { campaign: "winter", country: "US", actor: "visitor-a", session: "session-c" },
      ];
      for (const event of events) {
        await sql`
          INSERT INTO pulse.events (
            base_id, ts, kind, actor_id, session_id, dimensions_hash, dimensions, attributes, payload
          ) VALUES (
            ${baseId}::uuid, now(), 'page.viewed', ${event.actor}, ${event.session}, ${crypto.randomUUID()},
            (${JSON.stringify({ campaign: event.campaign, country: event.country })}::jsonb #>> '{}')::jsonb,
            (${JSON.stringify({ url: `https://example.com/${event.campaign}` })}::jsonb #>> '{}')::jsonb,
            '{}'::jsonb
          )
        `;
      }

      const baseQuery: EventQuery = {
        kind: "events",
        baseId,
        event: "page.viewed",
        since: "1h",
        dimensions: {},
        bucket: "1h",
        groupBy: ["campaign", "country"],
        aggregation: "count",
        limit: 500,
      };
      const [rawCount] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM pulse.events WHERE base_id = ${baseId}::uuid
      `;
      expect(rawCount?.count).toBe(3);
      const grouped = await queryEventAggregateData(baseQuery);
      expect(grouped.ok).toBe(true);
      if (!grouped.ok) return;
      expect(grouped.data.map((point) => ({ group: point.group, value: point.value }))).toEqual([
        { group: { campaign: "summer", country: "DE" }, value: 2 },
        { group: { campaign: "winter", country: "US" }, value: 1 },
      ]);

      const uniqueActors = await queryEventAggregateData({
        ...baseQuery,
        aggregation: "unique_actor",
        groupBy: [],
      });
      expect(uniqueActors.ok).toBe(true);
      if (!uniqueActors.ok) return;
      expect(uniqueActors.data[0]?.value).toBe(2);
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id = ${baseId}::uuid`;
    }
  });
});
