import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { prepareIngestBatch, writePreparedIngestBatchInTransaction } from "./ingest-bulk";
import { ingestBatch } from "./ingest-writer";
import { queryEventsData } from "./query-execution";

const runDbSmoke = testInfra.database !== undefined;
const postgresTest = runDbSmoke ? test : test.skip;

beforeAll(async () => {
  if (!runDbSmoke) return;
  const { initializeSchema } = await import("../schema");
  await initializeSchema();
}, 60_000);

describe("Pulse field catalog Postgres smoke", () => {
  postgresTest(
    "stores field definitions and counts without field values",
    async () => {
      const baseId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      await sql`INSERT INTO pulse.bases (id, short_id, name) VALUES (${baseId}::uuid, ${newShortId()}, 'Field catalog smoke')`;
      await sql`
      INSERT INTO pulse.sources (id, short_id, base_id, kind, name)
      VALUES (${sourceId}::uuid, ${newShortId()}, ${baseId}::uuid, 'http_ingest'::pulse.source_kind, 'Field catalog source')
    `;

      try {
        // Catalog assertions must not race the query's exclusive upper time boundary.
        const [clock] = await sql<{ ts: Date }[]>`SELECT now()-interval '1 minute' AS ts`;
        if (!clock) throw Error("Missing database clock");
        const ts = clock.ts.toISOString();
        const batch = prepareIngestBatch(
          {
            events: [
              {
                kind: "page.viewed",
                ts,
                dimensions: { campaign: "summer" },
                attributes: { request_id: "request-secret-1", result: 200 },
                sensitive: { ip: "203.0.113.42" },
              },
              {
                kind: "page.viewed",
                ts,
                dimensions: { campaign: "winter" },
                attributes: { request_id: "request-secret-2", result: "cached" },
                sensitive: { ip: "198.51.100.9" },
              },
            ],
          },
          sourceId,
        );
        await sql.begin((tx) => writePreparedIngestBatchInTransaction({ baseId, sourceId, batch, db: tx }));
        const single = await ingestBatch({
          baseId,
          sourceId,
          batch: {
            events: [
              {
                kind: "page.viewed",
                ts,
                dimensions: { campaign: "spring" },
                attributes: { request_id: "request-secret-3", result: 201 },
                sensitive: { ip: "192.0.2.15" },
              },
            ],
          },
        });
        expect(single.ok).toBe(true);

        const rows = await sql<Array<{ role: string; key: string; value_type: string; observed_count: number }>>`
        SELECT role, key, value_type, observed_count::int
        FROM pulse.signal_fields
        WHERE base_id = ${baseId}::uuid
        ORDER BY role, key
      `;
        expect(rows).toEqual([
          { role: "attribute", key: "request_id", value_type: "string", observed_count: 3 },
          { role: "attribute", key: "result", value_type: "mixed", observed_count: 3 },
          { role: "dimension", key: "campaign", value_type: "string", observed_count: 3 },
          { role: "sensitive", key: "ip", value_type: "string", observed_count: 3 },
        ]);

        const [containsValues] = await sql<{ contains_values: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM pulse.signal_fields
          WHERE base_id = ${baseId}::uuid
            AND row_to_json(signal_fields)::text LIKE '%request-secret%'
        ) AS contains_values
      `;
        expect(containsValues?.contains_values).toBe(false);

        const [stored] = await sql<{ sensitive_count: number }[]>`
        SELECT COUNT(*)::int AS sensitive_count
        FROM pulse.events
        WHERE base_id = ${baseId}::uuid
          AND sensitive ? 'ip'
      `;
        expect(stored?.sensitive_count).toBe(3);

        const events = await queryEventsData({
          kind: "events",
          baseId,
          event: "page.viewed",
          since: "1h",
          limit: 10,
        });
        expect(events.ok).toBe(true);
        if (events.ok) {
          expect(events.data).toHaveLength(3);
          expect(JSON.stringify(events.data)).not.toContain("203.0.113.42");
          expect(JSON.stringify(events.data)).not.toContain("192.0.2.15");
        }
      } finally {
        await sql`DELETE FROM pulse.bases WHERE id = ${baseId}::uuid`;
      }
    },
    30_000,
  );
});
