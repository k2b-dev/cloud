import { beforeAll, expect } from "bun:test";
import { sql } from "@k2b/cloud";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { AppEventEnvelope } from "@k2b/cloud/events";
import { createAppEventBroker } from "@k2b/cloud/services/app-events";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { MAX_RECORD_EVENTS_PER_BASE_TRANSACTION } from "../app-events";
import { gridsCapabilities } from "../capabilities";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import * as durableHistory from "./durable-history";
import * as finalization from "./record-finalization";
import * as records from "./record-write";

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

postgresTest("the per-base transaction cap accepts its boundary and rolls back an oversized batch without truncation", async () => {
  const f = await fixture();
  try {
    await expect(
      sql.begin(async (tx) => {
        // Put this transaction at the boundary without materializing 10,000 record/snapshot fixtures.
        await tx`SELECT set_config(${"grids.record_events_" + f.baseId.replaceAll("-", "")}, ${String(MAX_RECORD_EVENTS_PER_BASE_TRANSACTION - 1)}, true)`;
        expect((await records.createInTransaction(tx, f.tableId, {}, null, "direct")).ok).toBe(true);
        expect(
          await tx`SELECT id FROM events.outbox WHERE app_id = 'grids' AND kind = 'event' AND payload->'place'->>'id' = ${f.baseShortId}`,
        ).toHaveLength(1);
        await records.createInTransaction(tx, f.tableId, {}, null, "direct");
      }),
    ).rejects.toThrow("split the batch");
    expect(await f.events()).toHaveLength(0);
    expect(await sql`SELECT id FROM grids.records WHERE table_id = ${f.tableId}::uuid`).toHaveLength(0);
    // A new transaction gets a fresh budget.
    expect((await records.create(f.tableId, {}, null, "direct")).ok).toBe(true);
    expect(await f.events()).toHaveLength(1);
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
