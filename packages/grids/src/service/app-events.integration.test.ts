import { beforeAll, expect } from "bun:test";
import { sql } from "@k2b/cloud";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { AppEventEnvelope } from "@k2b/cloud/events";
import { createAppEventBroker } from "@k2b/cloud/services/app-events";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { MAX_RECORD_EVENTS_PER_BASE_TRANSACTION, publishGridsLifecycleEvent } from "../app-events";
import { gridsCapabilities } from "../capabilities";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import * as bases from "./bases";
import * as durableHistory from "./durable-history";
import * as finalization from "./record-finalization";
import * as records from "./record-write";
import * as tables from "./tables";

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

const fixture = async () => {
  const baseId = testUuid(),
    tableId = testUuid(),
    fieldId = testUuid(),
    baseShortId = testShortId();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Private base')`;
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${testShortId()}, ${baseId}::uuid, 'Private table')`;
  await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config) VALUES (${fieldId}::uuid, ${testShortId()}, ${tableId}::uuid, 'Private name', 'text', '{}'::jsonb)`;
  const events = async () =>
    (
      await sql<{ payload: AppEventEnvelope }[]>`
    SELECT payload FROM events.outbox WHERE app_id = 'grids' AND kind = 'event'
      AND payload->'place'->>'id' = ${baseShortId} ORDER BY seq
  `
    ).map((row) => row.payload);
  const cleanup = async () => {
    await sql`DELETE FROM events.app_events WHERE envelope->'place'->>'id' = ${baseShortId}`;
    await sql`DELETE FROM events.outbox WHERE app_id = 'grids' AND payload->'place'->>'id' = ${baseShortId}`;
    await sql`UPDATE grids.records SET finalized_at = NULL, finalized_by = NULL, final_revision_id = NULL WHERE table_id = ${tableId}::uuid`;
    await sql`DELETE FROM grids.record_revisions WHERE table_id = ${tableId}::uuid`;
    await sql`DELETE FROM grids.table_finalization_activations WHERE table_id = ${tableId}::uuid`;
    await sql`DELETE FROM grids.durable_history_activations WHERE table_id = ${tableId}::uuid`;
    await sql`DELETE FROM grids.table_schema_revisions WHERE table_id = ${tableId}::uuid`;
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  };
  return { baseId, tableId, fieldId, baseShortId, events, cleanup };
};

postgresTest("committed changes publish exactly one public event without workflow demand; no-ops and refusals publish none", async () => {
  const f = await fixture();
  try {
    const created = await records.create(f.tableId, { [f.fieldId]: "private value" }, null, "direct");
    if (!created.ok) throw created.error;
    expect((await records.update(f.tableId, created.data.id, { [f.fieldId]: "private value" }, null, "direct")).ok).toBe(true);
    expect((await records.update(f.tableId, created.data.id, { [f.fieldId]: "changed value" }, null, "direct", 99)).ok).toBe(false);
    expect((await f.events()).map((e) => e.type)).toEqual(["grids.record.created"]);
    expect((await records.update(f.tableId, created.data.id, { [f.fieldId]: "changed value" }, null, "direct")).ok).toBe(true);
    expect((await records.softDelete(f.tableId, created.data.id, null, "direct")).ok).toBe(true);
    expect((await records.softDelete(f.tableId, created.data.id, null, "direct")).ok).toBe(false);
    const events = await f.events();
    expect(events.map((e) => e.type)).toEqual(["grids.record.created", "grids.record.updated", "grids.record.deleted"]);
    for (const event of events) {
      expect(event.subject).toEqual({ type: "grids.record", id: created.data.shortId });
      expect(event.place).toEqual({ type: "grids.base", id: f.baseShortId });
      expect(event.data).toEqual({});
      expect(JSON.stringify(event)).not.toContain("private");
      expect(JSON.stringify(event)).not.toContain(f.baseId);
    }
    // Exercise Core's actual manifest reconciliation, acceptance, and event-ID deduplication.
    const broker = createAppEventBroker({
      registry: async () => [
        {
          appId: "grids",
          appName: "Grids",
          appIcon: "ti ti-table",
          appDescription: "Records",
          endpoint: "http://grids.test",
          manifest: compileCapabilityManifest("grids", gridsCapabilities),
        },
      ],
    });
    for (const [index, event] of events.entries()) {
      await broker.accept(event, index + 1);
      await broker.accept(event, index + 1);
    }
    const accepted = await sql<{ state: string; subject_key: string }[]>`
      SELECT state, subject_key FROM events.app_events WHERE envelope->'place'->>'id' = ${f.baseShortId}`;
    expect(accepted).toHaveLength(3);
    expect(accepted.every((row) => row.state === "accepted" && row.subject_key === `grids.record:${created.data.shortId}`)).toBe(true);
  } finally {
    await f.cleanup();
  }
});

postgresTest("relation changes count once, unchanged targets count zero, and payloads never contain targets", async () => {
  const f = await fixture();
  try {
    const created = await records.createMany(f.tableId, [{}, {}, {}], null, "direct");
    if (!created.ok) throw created.error;
    const [source, first, second] = created.data;
    if (!source || !first || !second) throw new Error("Missing relation fixtures");
    const relationId = testUuid();
    await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config)
      VALUES (${relationId}::uuid, ${testShortId()}, ${f.tableId}::uuid, 'Private relation', 'relation',
        ${{ targetTableId: f.tableId, cardinality: "multiple" }}::jsonb)`;
    const update = (targets: string[]) => records.update(f.tableId, source.id, { [relationId]: targets }, null, "direct");
    expect((await update([first.id, second.id])).ok).toBe(true);
    expect((await update([first.id, second.id])).ok).toBe(true);
    expect((await update([second.id, first.id])).ok).toBe(true);
    expect((await update([])).ok).toBe(true);
    const events = (await f.events()).filter((event) => event.type === "grids.record.updated");
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.subject).toEqual({ type: "grids.record", id: source.shortId });
      expect(event.data).toEqual({});
      expect(JSON.stringify(event)).not.toContain(first.shortId);
      expect(JSON.stringify(event)).not.toContain(second.shortId);
      expect(JSON.stringify(event)).not.toContain(relationId);
    }
  } finally {
    await f.cleanup();
  }
});

postgresTest("bulk writes publish once per record, and caller rollback discards records and platform events together", async () => {
  const f = await fixture();
  try {
    const bulk = await records.createMany(f.tableId, [{ [f.fieldId]: "a" }, { [f.fieldId]: "b" }], null, "direct");
    if (!bulk.ok) throw bulk.error;
    expect((await f.events()).map((e) => e.subject.id).sort()).toEqual(bulk.data.map((r) => r.shortId).sort());
    await expect(
      sql.begin(async (tx) => {
        const updated = await records.updateInTransaction(tx, f.tableId, bulk.data[0]!.id, { [f.fieldId]: "rolled back" }, null, "direct");
        expect(updated.ok).toBe(true);
        expect((await records.softDeleteInTransaction(tx, f.tableId, bulk.data[1]!.id, null, "direct")).ok).toBe(true);
        expect((await records.createInTransaction(tx, f.tableId, {}, null, "direct")).ok).toBe(true);
        const pending =
          await tx`SELECT id FROM events.outbox WHERE app_id = 'grids' AND kind = 'event' AND payload->'place'->>'id' = ${f.baseShortId}`;
        expect(pending).toHaveLength(5);
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    expect(await f.events()).toHaveLength(2);
    const stored = await sql<
      { data: Record<string, unknown>; deleted_at: Date | null }[]
    >`SELECT data, deleted_at FROM grids.records WHERE table_id = ${f.tableId}::uuid`;
    expect(stored).toHaveLength(2);
    expect(stored.every((r) => r.deleted_at === null && r.data[f.fieldId] !== "rolled back")).toBe(true);
  } finally {
    await f.cleanup();
  }
});

postgresTest(
  "more than 10,000 service writes commit with capped individual events and one overflow summary; parent deletion never fans out",
  async () => {
    const f = await fixture();
    try {
      const count = MAX_RECORD_EVENTS_PER_BASE_TRANSACTION + 2;
      const bulk = await records.createMany(
        f.tableId,
        Array.from({ length: count }, () => ({})),
        null,
        "direct",
      );
      if (!bulk.ok) throw bulk.error;
      expect(bulk.data).toHaveLength(count);
      const events = await f.events();
      expect(events.filter((e) => e.type === "grids.record.created")).toHaveLength(MAX_RECORD_EVENTS_PER_BASE_TRANSACTION);
      const summaries = events.filter((e) => e.type === "grids.records.changed");
      expect(summaries).toHaveLength(1);
      const table = await tables.get(f.tableId);
      expect(summaries[0]).toMatchObject({
        version: 1,
        subject: { type: "grids.table", id: table!.shortId },
        place: { type: "grids.base", id: f.baseShortId },
        data: { counts: { created: 2, updated: 0, deleted: 0, finalized: 0 } },
      });
      expect(JSON.stringify(summaries[0]).length).toBeLessThan(500);
      expect(await sql`SELECT * FROM grids.record_event_batches WHERE table_id = ${f.tableId}::uuid`).toHaveLength(0);
      const broker = createAppEventBroker({
        registry: async () => [
          {
            appId: "grids",
            appName: "Grids",
            appIcon: "ti ti-table",
            appDescription: "Records",
            endpoint: "http://grids.test",
            manifest: compileCapabilityManifest("grids", gridsCapabilities),
          },
        ],
      });
      await broker.accept(summaries[0]!, 1);
      await broker.accept(summaries[0]!, 1);
      expect(await sql`SELECT id FROM events.app_events WHERE id = ${summaries[0]!.id}::uuid AND state = 'accepted'`).toHaveLength(1);

      expect((await tables.remove(f.tableId, null)).ok).toBe(true);
      expect((await tables.restore(f.tableId, null)).ok).toBe(true);
      expect((await bases.remove(f.baseId, null)).ok).toBe(true);
      expect((await bases.restore(f.baseId, null)).ok).toBe(true);
      const tableOrderingKeys = await sql`
        SELECT DISTINCT ordering_key FROM events.outbox WHERE app_id = 'grids' AND kind = 'event'
          AND payload->'place'->>'id' = ${f.baseShortId} AND payload->'subject'->>'type' = 'grids.table'
      `;
      expect(tableOrderingKeys).toHaveLength(1);
      const lifecycle = (await f.events()).slice(events.length);
      expect(lifecycle.map((e) => e.type)).toEqual([
        "grids.table.deleted",
        "grids.table.restored",
        "grids.base.deleted",
        "grids.base.restored",
      ]);
      for (const event of lifecycle) {
        expect(event.place).toEqual({ type: "grids.base", id: f.baseShortId });
        expect(event.subject).toEqual(
          event.type.startsWith("grids.table.") ? { type: "grids.table", id: table!.shortId } : { type: "grids.base", id: f.baseShortId },
        );
        expect(event.data).toEqual({});
      }
      const [stored] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${f.tableId}::uuid AND deleted_at IS NULL`;
      expect(stored!.count).toBe(count);
    } finally {
      await f.cleanup();
    }
  },
  180_000,
);

postgresTest("overflow counts are combined per table across change kinds and rollback discards summaries and writes", async () => {
  const f = await fixture();
  const otherTableId = testUuid(),
    otherTableRef = testShortId();
  try {
    await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${otherTableId}::uuid, ${otherTableRef}, ${f.baseId}::uuid, 'Other')`;
    const change = async (rollback: boolean) =>
      sql.begin(async (tx) => {
        // Exercise mixed changes past the boundary without repeating the full large-import fixture.
        await tx`SELECT set_config(${"grids.record_events_" + f.baseId.replaceAll("-", "")}, ${String(MAX_RECORD_EVENTS_PER_BASE_TRANSACTION)}, true)`;
        const created = await records.createInTransaction(tx, f.tableId, {}, null, "direct");
        if (!created.ok) throw created.error;
        expect(
          (await records.updateInTransaction(tx, f.tableId, created.data.record.id, { [f.fieldId]: "private" }, null, "direct")).ok,
        ).toBe(true);
        expect((await records.softDeleteInTransaction(tx, f.tableId, created.data.record.id, null, "direct")).ok).toBe(true);
        expect((await records.createInTransaction(tx, otherTableId, {}, null, "direct")).ok).toBe(true);
        if (rollback) throw new Error("force overflow rollback");
      });
    await expect(change(true)).rejects.toThrow("force overflow rollback");
    expect(await f.events()).toHaveLength(0);
    expect(
      await sql`SELECT * FROM grids.record_event_batches WHERE table_id = ANY(${sql.array([f.tableId, otherTableId], "UUID")})`,
    ).toHaveLength(0);
    expect(await sql`SELECT id FROM grids.records WHERE table_id = ANY(${sql.array([f.tableId, otherTableId], "UUID")})`).toHaveLength(0);
    await change(false);
    const summaries = await f.events();
    expect(summaries).toHaveLength(2);
    expect(summaries.find((e) => e.subject.id === otherTableRef)?.data).toEqual({
      counts: { created: 1, updated: 0, deleted: 0, finalized: 0 },
    });
    expect(summaries.find((e) => e.subject.id !== otherTableRef)?.data).toEqual({
      counts: { created: 1, updated: 1, deleted: 1, finalized: 0 },
    });
  } finally {
    await f.cleanup();
  }
});

postgresTest("a savepoint rollback restores the per-base event budget and other bases keep independent budgets", async () => {
  const f = await fixture(),
    other = await fixture();
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config(${"grids.record_events_" + f.baseId.replaceAll("-", "")}, ${String(MAX_RECORD_EVENTS_PER_BASE_TRANSACTION - 1)}, true)`;
      await tx`SAVEPOINT record_event_budget`;
      expect((await records.createInTransaction(tx, f.tableId, {}, null, "direct")).ok).toBe(true);
      await tx`ROLLBACK TO SAVEPOINT record_event_budget`;
      await tx`RELEASE SAVEPOINT record_event_budget`;
      expect((await records.createInTransaction(tx, f.tableId, {}, null, "direct")).ok).toBe(true);
      expect((await records.createInTransaction(tx, other.tableId, {}, null, "direct")).ok).toBe(true);
    });
    expect(await f.events()).toHaveLength(1);
    expect(await other.events()).toHaveLength(1);
  } finally {
    await f.cleanup();
    await other.cleanup();
  }
});

postgresTest("savepoint rollback discards overflow increments and an inserted summary without losing earlier counts", async () => {
  const f = await fixture();
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config(${"grids.record_events_" + f.baseId.replaceAll("-", "")}, ${String(MAX_RECORD_EVENTS_PER_BASE_TRANSACTION)}, true)`;
      await tx`SAVEPOINT first_overflow`;
      expect((await records.createInTransaction(tx, f.tableId, {}, null, "direct")).ok).toBe(true);
      await tx`ROLLBACK TO SAVEPOINT first_overflow`;
      await tx`RELEASE SAVEPOINT first_overflow`;
      expect(await tx`SELECT * FROM grids.record_event_batches WHERE table_id = ${f.tableId}::uuid`).toHaveLength(0);
      const created = await records.createInTransaction(tx, f.tableId, {}, null, "direct");
      if (!created.ok) throw created.error;
      await tx`SAVEPOINT later_overflow`;
      expect((await records.createInTransaction(tx, f.tableId, {}, null, "direct")).ok).toBe(true);
      expect((await records.softDeleteInTransaction(tx, f.tableId, created.data.record.id, null, "direct")).ok).toBe(true);
      await tx`ROLLBACK TO SAVEPOINT later_overflow`;
      await tx`RELEASE SAVEPOINT later_overflow`;
      expect((await records.createInTransaction(tx, f.tableId, {}, null, "direct")).ok).toBe(true);
    });
    const events = await f.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "grids.records.changed",
      data: { counts: { created: 2, updated: 0, deleted: 0, finalized: 0 } },
    });
    expect(await sql`SELECT id FROM grids.records WHERE table_id = ${f.tableId}::uuid AND deleted_at IS NULL`).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
});

postgresTest("lifecycle publication rejects mismatched table refs and concurrent restores emit one event", async () => {
  const f = await fixture();
  try {
    await expect(sql.begin((tx) => publishGridsLifecycleEvent(tx, "table.deleted", f.baseId, testUuid()))).rejects.toThrow(
      "mismatched table",
    );
    expect(await f.events()).toHaveLength(0);
    expect((await tables.remove(f.tableId, null)).ok).toBe(true);
    const restored = await Promise.all([tables.restore(f.tableId, null), tables.restore(f.tableId, null)]);
    expect(restored.every((result) => result.ok)).toBe(true);
    expect((await tables.restore(f.tableId, null)).ok).toBe(true);
    expect((await f.events()).map((event) => event.type)).toEqual(["grids.table.deleted", "grids.table.restored"]);
  } finally {
    await f.cleanup();
  }
});

postgresTest("finalization publishes one distinct event, none for replay or rollback", async () => {
  const f = await fixture();
  try {
    expect((await durableHistory.enable(f.tableId, null)).ok).toBe(true);
    expect((await finalization.enable(f.tableId, { mode: "direct" }, null)).ok).toBe(true);
    const created = await records.create(f.tableId, { [f.fieldId]: "private" }, null, "direct");
    if (!created.ok) throw created.error;
    const params = { tableId: f.tableId, recordId: created.data.id, actorId: null, origin: "direct" as const };
    await expect(
      sql.begin(async (tx) => {
        expect((await finalization.finalizeInTransaction(tx, params)).ok).toBe(true);
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    expect((await f.events()).map((e) => e.type)).toEqual(["grids.record.created"]);
    expect((await finalization.finalize(params)).ok).toBe(true);
    await finalization.finalize(params);
    expect((await f.events()).map((e) => e.type)).toEqual(["grids.record.created", "grids.record.finalized"]);
    expect((await f.events())[1]!.subject.id).toBe(created.data.shortId);
  } finally {
    await f.cleanup();
  }
});
