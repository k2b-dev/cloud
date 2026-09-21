import { beforeAll, expect, spyOn } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import * as projections from "./computed-projections";
import * as history from "./durable-history";
import * as fields from "./fields";
import * as finalization from "./record-finalization";
import { createReader } from "./record-read";
import * as records from "./record-write";

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

const fixture = async () => {
  const baseId = testUuid();
  const tableId = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Frozen reader')`;
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Records')`;
  const amount = await fields.create({ tableId, name: "Amount", type: "number" }, null);
  const total = await fields.create({ tableId, name: "Total", type: "formula", config: { expression: "Amount * 2" } }, null);
  const positive = await fields.create({ tableId, name: "Positive", type: "formula", config: { expression: "Amount > 0" } }, null);
  const relation = await fields.create(
    { tableId, name: "Related", type: "relation", config: { targetTableId: tableId, cardinality: "single" } },
    null,
  );
  if (!amount.ok || !total.ok || !positive.ok || !relation.ok) throw new Error("Field setup failed");
  const enabledHistory = await history.enable(tableId, null);
  const enabledFinalization = await finalization.enable(tableId, { mode: "direct" }, null);
  if (!enabledHistory.ok || !enabledFinalization.ok) throw new Error("Finalization setup failed");
  const draft = await records.create(tableId, { [amount.data.id]: "3.25" }, null, "direct");
  if (!draft.ok) throw draft.error;
  const frozen = await records.create(tableId, { [amount.data.id]: "12.5", [relation.data.id]: [draft.data.id] }, null, "direct");
  if (!frozen.ok) throw frozen.error;
  const finalized = await finalization.finalize({ tableId, recordId: frozen.data.id, actorId: null, origin: "direct" });
  if (!finalized.ok) throw finalized.error;
  return {
    baseId,
    tableId,
    amount: amount.data.id,
    total: total.data.id,
    positive: positive.data.id,
    relation: relation.data.id,
    draftId: draft.data.id,
    frozenId: frozen.data.id,
  };
};

const cleanup = async (baseId: string) => {
  await sql`UPDATE grids.records SET finalized_at = NULL, finalized_by = NULL, final_revision_id = NULL WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.record_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.record_finalization_requests WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.table_finalization_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.durable_history_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.table_schema_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
};

postgresTest("failed draft planning can retry while cancellation remains terminal", async () => {
  const item = await fixture();
  const compute = spyOn(projections, "buildComputedProjections").mockRejectedValueOnce(new Error("transient plan failure"));
  try {
    const abort = new AbortController();
    const reader = await createReader(item.tableId, { signal: abort.signal });
    await expect(reader.get(item.draftId)).rejects.toThrow("transient plan failure");
    expect((await reader.get(item.draftId))?.data[item.total]).toBe("6.5");
    abort.abort();
    await expect(reader.get(item.draftId)).rejects.toThrow();
  } finally {
    compute.mockRestore();
    await cleanup(item.baseId);
  }
});

postgresTest("frozen reads skip live SQL planning, preserve types and relations, and mix with drafts", async () => {
  const item = await fixture();
  const computed = spyOn(projections, "buildComputedProjections");
  const formulas = spyOn(projections, "buildFormulaSqlProjections");
  try {
    const reader = await createReader(item.tableId);
    const frozen = await reader.get(item.frozenId);
    expect(frozen?.data[item.total]).toBe("25");
    expect(frozen?.data[item.positive]).toBe(true);
    expect(frozen?.data[item.relation]).toEqual([item.draftId]);
    expect(computed).not.toHaveBeenCalled();
    expect(formulas).not.toHaveBeenCalled();
    const mixed = await reader.getMany([item.draftId, item.frozenId, item.draftId, testUuid()]);
    expect(mixed.map((record) => record.id)).toEqual([item.draftId, item.frozenId, item.draftId]);
    expect(mixed.map((record) => record.data[item.total])).toEqual(["6.5", "25", "6.5"]);
    expect(computed.mock.calls.length).toBeGreaterThan(0);
    const computedCalls = computed.mock.calls.length;
    const calls = formulas.mock.calls.length;
    expect((await reader.get(item.draftId))?.data[item.total]).toBe("6.5");
    expect((await reader.get(item.frozenId))?.data[item.total]).toBe("25");
    expect(computed.mock.calls.length).toBe(computedCalls);
    expect(formulas.mock.calls.length).toBe(calls);
    await sql`UPDATE grids.tables SET deleted_at = now() WHERE id = ${item.tableId}::uuid`;
    expect(await reader.get(item.frozenId)).toBeNull();
  } finally {
    computed.mockRestore();
    formulas.mockRestore();
    await cleanup(item.baseId);
  }
});

postgresTest("a draft finalized between raw read and projection read returns its complete captured row", async () => {
  const item = await fixture();
  const original = projections.buildComputedProjections;
  const compute = spyOn(projections, "buildComputedProjections").mockImplementation(async (...args) => {
    compute.mockRestore();
    const saved = await records.update(item.tableId, item.draftId, { [item.amount]: "9.75" }, null, "direct");
    if (!saved.ok) throw saved.error;
    const finalized = await finalization.finalize({ tableId: item.tableId, recordId: item.draftId, actorId: null, origin: "direct" });
    if (!finalized.ok) throw finalized.error;
    return original(...args);
  });
  try {
    const result = await (await createReader(item.tableId)).get(item.draftId);
    expect(result?.finalizedAt).not.toBeNull();
    expect(result?.data[item.amount]).toBe("9.75");
    expect(result?.data[item.total]).toBe("19.5");
    expect(result?.data[item.positive]).toBe(true);
  } finally {
    compute.mockRestore();
    await cleanup(item.baseId);
  }
});
