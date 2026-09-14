import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import type { PulseState } from "../contracts";
import { newShortId } from "../lib/short-id";
import { ingestBatch } from "./ingest-writer";

const runDbSmoke = process.env.PULSE_STATE_TRANSITIONS_DB_TEST === "1";
const postgresTest = runDbSmoke ? test : test.skip;

beforeAll(async () => {
  if (!runDbSmoke) return;
  const { initializeSchema } = await import("../schema");
  await initializeSchema();
}, 60_000);

describe("Pulse state transition Postgres smoke", () => {
  postgresTest(
    "stores initial and changed values without repeated or stale snapshots",
    async () => {
      const baseId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      await sql`INSERT INTO pulse.bases (id, short_id, name) VALUES (${baseId}::uuid, ${newShortId()}, 'State transition smoke')`;
      await sql`
      INSERT INTO pulse.sources (id, short_id, base_id, kind, name)
      VALUES (${sourceId}::uuid, ${newShortId()}, ${baseId}::uuid, 'http_ingest'::pulse.source_kind, 'State transition source')
    `;

      const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
      const state = (value: boolean, seconds: number): PulseState => ({
        key: "service.online",
        value,
        ts: at(seconds),
        resource: { type: "service", id: "service:api" },
        dimensions: { region: "eu" },
      });
      const writeBatch = (value: boolean, seconds: number) => ingestBatch({ baseId, sourceId, batch: { states: [state(value, seconds)] } });

      try {
        expect((await writeBatch(true, 10)).ok).toBe(true);
        expect((await writeBatch(true, 20)).ok).toBe(true);
        expect((await writeBatch(false, 5)).ok).toBe(true);
        expect((await writeBatch(false, 30)).ok).toBe(true);

        const concurrent = await Promise.all([
          ingestBatch({ baseId, sourceId, batch: { states: [state(true, 40)] } }),
          ingestBatch({ baseId, sourceId, batch: { states: [state(true, 40)] } }),
        ]);
        expect(concurrent.every((result) => result.ok)).toBe(true);

        const [current] = await sql<{ value: boolean; updated_at: Date }[]>`
        SELECT (value #>> '{}')::boolean AS value, updated_at
        FROM pulse.states_current
        WHERE base_id = ${baseId}::uuid AND state_key = 'service.online'
      `;
        expect(current?.value).toBe(true);
        expect(current?.updated_at.toISOString()).toBe(at(40));

        const changes = await sql<{ value: boolean; changed_at: Date }[]>`
        SELECT (value #>> '{}')::boolean AS value, changed_at
        FROM pulse.state_changes
        WHERE base_id = ${baseId}::uuid AND state_key = 'service.online'
        ORDER BY changed_at
      `;
        expect(changes.map((change) => ({ value: change.value, at: change.changed_at.toISOString() }))).toEqual([
          { value: true, at: at(10) },
          { value: false, at: at(30) },
          { value: true, at: at(40) },
        ]);
      } finally {
        await sql`DELETE FROM pulse.bases WHERE id = ${baseId}::uuid`;
      }
    },
    60_000,
  );
});
