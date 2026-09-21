import { beforeAll, describe, expect, test } from "bun:test";
import type { ServiceAccount } from "@k2b/cloud/contracts";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import type { PulseResourceRef } from "../contracts";
import { newShortId } from "../lib/short-id";
import { initializeSchema } from "../schema";
import { ingestBatch, ingestByApiKey } from "./ingest-writer";
import { type CurrentStateRow, mapCurrentState } from "./telemetry-values";

const enabled = testInfra.database !== undefined;
const databaseTest = enabled ? test : test.skip;
beforeAll(async () => {
  if (enabled) await initializeSchema();
}, 30_000);

const fixture = async () => {
  const baseId = crypto.randomUUID();
  const sources: [string, string] = [crypto.randomUUID(), crypto.randomUUID()];
  await sql`INSERT INTO pulse.bases (id, short_id, name) VALUES (${baseId}::uuid, ${newShortId()}, 'Identity test')`;
  for (const sourceId of sources) {
    await sql`INSERT INTO pulse.sources (id, short_id, base_id, kind, name)
      VALUES (${sourceId}::uuid, ${newShortId()}, ${baseId}::uuid, 'http_ingest', 'Test source')`;
  }
  return { baseId, sources };
};

describe("Pulse canonical ingest", () => {
  databaseTest(
    "isolates resources and sources, and keeps identity through labels and source deletion",
    async () => {
      const { baseId, sources } = await fixture();
      const resources: (PulseResourceRef | null)[] = [
        { type: "host", id: "same" },
        { type: "service", id: "same" },
        { type: "host", id: "other" },
        null,
      ];
      const batch = {
        metrics: resources.map((resource) => ({ name: "load", value: 1, resource, dimensions: { region: "eu" } })),
        states: resources.map((resource) => ({ key: "online", value: true, resource, dimensions: { region: "eu" } })),
      };
      try {
        for (const sourceId of sources) expect((await ingestBatch({ baseId, sourceId, batch })).ok).toBe(true);
        const [counts] = await sql`SELECT
        (SELECT count(*)::int FROM pulse.metric_series WHERE base_id=${baseId}::uuid) AS metrics,
        (SELECT count(*)::int FROM pulse.states_current WHERE base_id=${baseId}::uuid) AS states`;
        expect(counts).toMatchObject({ metrics: 8, states: 8 });
        expect(
          (
            await ingestBatch({
              baseId,
              sourceId: sources[0],
              batch: {
                metrics: [
                  { name: "load", value: 2, resource: { type: "host", id: "same", label: "Renamed" }, dimensions: { region: "eu" } },
                ],
              },
            })
          ).ok,
        ).toBe(true);
        await sql`DELETE FROM pulse.sources WHERE base_id=${baseId}::uuid`;
        const rows = await sql<{ variant_key: string }[]>`SELECT variant_key FROM pulse.states_current WHERE base_id=${baseId}::uuid`;
        expect(new Set(rows.map((row) => row.variant_key)).size).toBe(8);
        const [series] = await sql`SELECT count(*)::int AS count FROM pulse.metric_series WHERE base_id=${baseId}::uuid`;
        expect(series?.count).toBe(8);
      } finally {
        await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
      }
    },
    30_000,
  );

  databaseTest(
    "round-trips JSON primitives and records every ordered batch transition",
    async () => {
      const { baseId, sources } = await fixture();
      const values = ["123", "true", "null", "plain", 123, true, null];
      try {
        const result = await ingestBatch({
          baseId,
          sourceId: sources[0],
          batch: {
            states: values.map((value, index) => ({ key: "status", value, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() })),
            events: [{ kind: "page.viewed", attributes: { numeric: "123", boolean: "true", null: "null" }, payload: { count: 123 } }],
          },
        });
        expect(result.ok).toBe(true);
        const changes = await sql<
          { value: unknown }[]
        >`SELECT value FROM pulse.state_changes WHERE base_id=${baseId}::uuid ORDER BY changed_at`;
        expect(changes.map((row) => row.value)).toEqual(values);
        const [event] = await sql`SELECT attributes,payload FROM pulse.events WHERE base_id=${baseId}::uuid`;
        expect(event?.attributes).toEqual({ numeric: "123", boolean: "true", null: "null" });
        expect(event?.payload).toEqual({ count: 123 });
        for (const value of values) {
          expect((await ingestBatch({ baseId, sourceId: sources[0], batch: { states: [{ key: "current", value }] } })).ok).toBe(true);
          const [row] = await sql<
            CurrentStateRow[]
          >`SELECT * FROM pulse.states_current WHERE base_id=${baseId}::uuid AND state_key='current'`;
          if (!row) throw Error("missing state");
          expect(mapCurrentState(row).value).toEqual(value);
        }
        const [before] = await sql`SELECT count(*)::int AS count FROM pulse.state_changes WHERE base_id=${baseId}::uuid`;
        expect(
          (
            await ingestBatch({
              baseId,
              sourceId: sources[0],
              batch: { states: [{ key: "status", value: "stale", ts: "2025-01-01T00:00:00Z" }] },
            })
          ).ok,
        ).toBe(true);
        const [after] = await sql`SELECT count(*)::int AS count FROM pulse.state_changes WHERE base_id=${baseId}::uuid`;
        expect(after?.count).toBe(before?.count);
      } finally {
        await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
      }
    },
    30_000,
  );

  databaseTest(
    "rejects a disabled, foreign, missing, or clearing source scope without partial writes",
    async () => {
      const first = await fixture();
      const second = await fixture();
      try {
        await sql`UPDATE pulse.sources SET enabled=false WHERE id=${first.sources[0]}::uuid`;
        const batch = { metrics: [{ name: "load", value: 1 }], events: [{ kind: "view" }], states: [{ key: "online", value: true }] };
        for (const sourceId of [first.sources[0], second.sources[0], ""]) {
          expect((await ingestBatch({ baseId: first.baseId, sourceId, batch })).ok).toBe(false);
        }
        await sql`UPDATE pulse.bases SET data_clear_started_at=now() WHERE id=${first.baseId}::uuid`;
        expect((await ingestBatch({ baseId: first.baseId, sourceId: first.sources[1], batch })).ok).toBe(false);
        const [row] = await sql`SELECT count(*)::int AS count FROM pulse.metric_defs WHERE base_id=${first.baseId}::uuid`;
        expect(row?.count).toBe(0);
      } finally {
        await sql`DELETE FROM pulse.bases WHERE id=${first.baseId}::uuid OR id=${second.baseId}::uuid`;
      }
    },
    30_000,
  );
  databaseTest(
    "serializes concurrent idempotent requests and replays without extra writes",
    async () => {
      const { baseId, sources } = await fixture();
      try {
        const [source] = await sql`SELECT short_id FROM pulse.sources WHERE id=${sources[0]}::uuid`;
        const serviceAccount: ServiceAccount = {
          id: crypto.randomUUID(),
          name: "Test source",
          kind: "resource_bound",
          status: "active",
          delegatedUserId: null,
          appId: "pulse",
          resourceType: "pulse_source",
          resourceId: source!.short_id,
          createdBy: null,
          createdAt: new Date().toISOString(),
        };
        const batch = { events: [{ kind: "page.viewed" }] };
        const send = (key: string) => ingestByApiKey({ serviceAccount, scopes: ["pulse:ingest"], batch, idempotencyKey: key });
        const keys = Array.from({ length: 8 }, (_, i) => `request-${i}`);
        const first = await Promise.all(keys.map(send));
        expect(first.every((result) => result.ok)).toBe(true);
        const replay = await Promise.all([...keys, ...keys].map(send));
        expect(replay.every((result) => result.ok)).toBe(true);
        const [count] = await sql`SELECT count(*)::int AS count FROM pulse.events WHERE base_id=${baseId}::uuid`;
        expect(count?.count).toBe(8);
        const conflict = await ingestByApiKey({
          serviceAccount,
          scopes: ["pulse:ingest"],
          batch: { events: [{ kind: "different" }] },
          idempotencyKey: keys[0],
        });
        expect(conflict).toMatchObject({ ok: false, error: { status: 409 } });
        await sql`UPDATE pulse.bases SET data_clear_started_at=now(),data_clear_failed_at=now() WHERE id=${baseId}::uuid`;
        expect((await send(keys[0]!)).ok).toBe(false);
      } finally {
        await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
      }
    },
    30_000,
  );

  databaseTest(
    "preserves the order of equal-timestamp state transitions",
    async () => {
      const { baseId, sources } = await fixture();
      try {
        expect(
          (
            await ingestBatch({
              baseId,
              sourceId: sources[0],
              batch: { states: [false, true, false].map((value) => ({ key: "online", value, ts: "2026-01-01T00:00:00Z" })) },
            })
          ).ok,
        ).toBe(true);
        const rows = await sql<
          { value: boolean }[]
        >`SELECT value FROM pulse.state_changes WHERE base_id=${baseId}::uuid ORDER BY changed_at, sequence`;
        expect(rows.map((row) => row.value)).toEqual([false, true, false]);
      } finally {
        await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
      }
    },
    30_000,
  );
});
