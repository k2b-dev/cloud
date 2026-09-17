import { beforeAll, expect, spyOn } from "bun:test";
import { sql } from "bun";
import * as objectLists from "../field-types/object-list";
import * as evaluator from "../formula/evaluator";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import * as durableHistory from "./durable-history";
import * as fields from "./fields";
import * as finalization from "./record-finalization";
import * as records from "./record-write";
import { buildRelationLabelCacheForIds, lookupRecords } from "./relation-labels";
import { loadRelationTargetsBatch } from "./relation-targets";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
}, 30_000);

const fixture = async () => {
  const baseId = testUuid();
  const tableId = testUuid();
  await sql`INSERT INTO grids.bases(id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Relation calculations')`;
  await sql`INSERT INTO grids.tables(id, short_id, base_id, name) VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Labels')`;
  const amount = await fields.create({ tableId, name: "Amount", type: "number" }, null);
  const label = await fields.create(
    { tableId, name: "Label", type: "formula", config: { expression: "Amount * 2" }, presentable: true },
    null,
  );
  if (!amount.ok || !label.ok) throw new Error("Label fixture creation failed");
  const record = await records.create(tableId, { [amount.data.id]: "3" }, null, "direct");
  if (!record.ok) throw record.error;
  return { baseId, tableId, amount: amount.data, label: label.data, record: record.data };
};

postgresTest("stored relation labels and pickers do not evaluate local formulas in JavaScript", async () => {
  const item = await fixture();
  const list = await fields.create(
    {
      tableId: item.tableId,
      name: "Items",
      type: "object_list",
      config: {
        fields: [
          { id: "Amount", name: "Amount", type: "number" },
          { id: "Total1", name: "Total", type: "number", formula: { expression: "Amount * 2" } },
        ],
      },
    },
    null,
  );
  if (!list.ok) throw list.error;
  const update = await records.update(
    item.tableId,
    item.record.id,
    { [list.data.id]: [{ Amount: "4" }] },
    null,
    "direct",
    item.record.version,
  );
  if (!update.ok) throw update.error;
  const validateList = spyOn(objectLists, "validateObjectList");
  const evaluate = spyOn(evaluator, "evaluate").mockImplementation(() => {
    throw new Error("local formula recomputed during read");
  });
  try {
    const labels = await buildRelationLabelCacheForIds(new Map([[item.tableId, new Set([item.record.id])]]));
    expect(labels[item.record.id]).toBe("6");
    const choices = await lookupRecords({ targetTableId: item.tableId, q: "6" });
    expect(choices.items).toEqual([{ id: item.record.id, label: "6" }]);
    expect(evaluate).not.toHaveBeenCalled();
    expect(validateList).not.toHaveBeenCalled();
  } finally {
    evaluate.mockRestore();
    validateList.mockRestore();
    await sql`DELETE FROM grids.bases WHERE id = ${item.baseId}::uuid`;
  }
});

postgresTest("stored label batches isolate table signatures and reject stale calculations on every label read", async () => {
  const left = await fixture();
  const right = await fixture();
  try {
    const ids = new Map([
      [left.tableId, new Set([left.record.id])],
      [right.tableId, new Set([right.record.id])],
    ]);
    const targets = await loadRelationTargetsBatch(ids);
    expect(targets.get(left.tableId)?.records[0]?.data[left.label.id]).toBe("6");
    expect(targets.get(right.tableId)?.records[0]?.data[right.label.id]).toBe("6");
    const narrowed = await loadRelationTargetsBatch(ids, new Set([left.tableId]));
    expect(narrowed.get(right.tableId)?.records).toEqual([]);
    await sql`UPDATE grids.records SET local_calculations = jsonb_set(local_calculations, '{signature}', '"stale"'::jsonb) WHERE id = ${left.record.id}::uuid`;
    await expect(loadRelationTargetsBatch(ids)).rejects.toThrow("grids: stale local calculation");
    await expect(lookupRecords({ targetTableId: left.tableId })).rejects.toThrow("grids: stale local calculation");
  } finally {
    await sql`DELETE FROM grids.bases WHERE id = ANY(${sql.array([left.baseId, right.baseId], "UUID")})`;
  }
});

postgresTest("stored errors remain available to live clock-dependent label recovery", async () => {
  const item = await fixture();
  try {
    const broken = await fields.create({ tableId: item.tableId, name: "Broken", type: "formula", config: { expression: "1 / 0" } }, null);
    const recovery = await fields.create(
      {
        tableId: item.tableId,
        name: "Recovery",
        type: "formula",
        config: { expression: "IFERROR(Broken, YEAR(TODAY()))" },
        presentable: true,
      },
      null,
    );
    if (!broken.ok || !recovery.ok) throw new Error("Error fixture creation failed");
    const hidden = await fields.update(item.label.id, { presentable: false }, null);
    if (!hidden.ok) throw hidden.error;
    const targets = await loadRelationTargetsBatch(new Map([[item.tableId, new Set([item.record.id])]]));
    const read = targets.get(item.tableId)?.records[0];
    expect(read?.fieldErrors?.[broken.data.id]).toBeTruthy();
    expect(read?.data[broken.data.id]).toBeNull();
    const year = new Date().getUTCFullYear();
    expect(read?.data[recovery.data.id]).toBe(year);
    expect((await lookupRecords({ targetTableId: item.tableId })).items).toEqual([{ id: item.record.id, label: String(year) }]);
  } finally {
    await sql`DELETE FROM grids.bases WHERE id = ${item.baseId}::uuid`;
  }
});

postgresTest("frozen relation labels retain captured values and dependency authorization", async () => {
  const item = await fixture();
  try {
    const history = await durableHistory.enable(item.tableId, null);
    if (!history.ok) throw history.error;
    const enabled = await finalization.enable(item.tableId, { mode: "direct" }, null);
    if (!enabled.ok) throw enabled.error;
    const frozen = await finalization.finalize({ tableId: item.tableId, recordId: item.record.id, actorId: null, origin: "direct" });
    if (!frozen.ok) throw frozen.error;
    const changed = await fields.update(item.label.id, { config: { expression: "Amount * 3" } }, null);
    if (!changed.ok) throw changed.error;
    await sql`UPDATE grids.records SET local_calculations = '{}'::jsonb WHERE id = ${item.record.id}::uuid`;
    const ids = new Map([[item.tableId, new Set([item.record.id])]]);
    const targets = await loadRelationTargetsBatch(ids, new Set([item.tableId]));
    expect(targets.get(item.tableId)?.records[0]?.data[item.label.id]).toBe("6");
    expect((await lookupRecords({ targetTableId: item.tableId, q: "6" })).items).toEqual([{ id: item.record.id, label: "6" }]);
    const hiddenTableId = testUuid();
    await sql`UPDATE grids.records SET finalized_computed_dependencies = jsonb_set(finalized_computed_dependencies, ARRAY[${item.label.id}], ${[hiddenTableId]}::jsonb) WHERE id = ${item.record.id}::uuid`;
    const denied = await loadRelationTargetsBatch(ids, new Set([item.tableId]));
    expect(denied.get(item.tableId)?.records[0]?.data[item.label.id]).toBeNull();
    await sql`UPDATE grids.records SET finalized_computed_types = finalized_computed_types - ${item.label.id} WHERE id = ${item.record.id}::uuid`;
    const missing = await loadRelationTargetsBatch(ids);
    expect(missing.get(item.tableId)?.records[0]?.data[item.label.id]).toBeNull();
    expect(missing.get(item.tableId)?.records[0]?.fieldErrors?.[item.label.id]).toBeTruthy();
    expect((await lookupRecords({ targetTableId: item.tableId })).items).toEqual([{ id: item.record.id, label: "Untitled record" }]);
  } finally {
    await sql`UPDATE grids.records SET finalized_at = NULL, finalized_by = NULL, final_revision_id = NULL WHERE table_id = ${item.tableId}::uuid`;
    await sql`DELETE FROM grids.record_revisions WHERE table_id = ${item.tableId}::uuid`;
    await sql`DELETE FROM grids.record_finalization_requests WHERE table_id = ${item.tableId}::uuid`;
    await sql`DELETE FROM grids.table_finalization_activations WHERE table_id = ${item.tableId}::uuid`;
    await sql`DELETE FROM grids.durable_history_activations WHERE table_id = ${item.tableId}::uuid`;
    await sql`DELETE FROM grids.table_schema_revisions WHERE table_id = ${item.tableId}::uuid`;
    await sql`DELETE FROM grids.bases WHERE id = ${item.baseId}::uuid`;
  }
});
