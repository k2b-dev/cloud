import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { previewDslQuery } from "../query-dsl/preview";
import { resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import { createRecordSnapshotDraft } from "./document-snapshots";
import * as durableHistory from "./durable-history";
import * as fields from "./fields";
import * as files from "./files";
import * as finalization from "./record-finalization";
import { get as getRecord } from "./record-read";
import * as records from "./record-write";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

const fixture = async (policy: { mode: "direct" } | { mode: "fourEyes"; approverGroupId: string } = { mode: "direct" }) => {
  const baseId = testUuid();
  const tableId = testUuid();
  const tableShortId = testShortId("T");
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Finalization')`;
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Cases')`;
  const name = await fields.create({ tableId, name: "Name", type: "text", presentable: true }, null);
  const attachment = await fields.create({ tableId, name: "Attachment", type: "file" }, null);
  if (!name.ok || !attachment.ok) throw new Error("fixture fields failed");
  const history = await durableHistory.enable(tableId, null);
  if (!history.ok || !history.data.enabled || history.data.status !== "active") throw new Error("history activation failed");
  const enabled = await finalization.enable(tableId, policy, null);
  if (!enabled.ok) throw enabled.error;
  const number = await fields.create(
    {
      tableId,
      name: "Final number",
      type: "id",
      config: { strategy: "sequence", prefix: "FIN-", padding: 3, assignment: "finalization" },
    },
    null,
  );
  if (!number.ok) throw number.error;
  const relation = await fields.create(
    { tableId, name: "Related case", type: "relation", config: { targetTableId: tableId, cardinality: "single" } },
    null,
  );
  if (!relation.ok) throw relation.error;
  return { baseId, tableId, tableShortId, name: name.data, attachment: attachment.data, number: number.data, relation: relation.data };
};

const cleanup = async (baseId: string) => {
  await sql`
    UPDATE grids.records SET finalized_at = NULL, finalized_by = NULL, final_revision_id = NULL
    WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)
  `;
  await sql`DELETE FROM grids.file_protected_references WHERE base_id = ${baseId}::uuid`;
  await sql`DELETE FROM grids.record_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.record_finalization_requests WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.table_finalization_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.durable_history_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.table_schema_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
};

const recordsInFinalizationState = async (
  item: { tableId: string; tableShortId: string },
  state: "draft" | "awaitingReview" | "finalized",
): Promise<string[]> => {
  const tableFields = await fields.listByTable(item.tableId);
  const parsed = parseGridsQueryDsl(`from table {${item.tableShortId}}\nwhere record.finalizationState = '${state}'`);
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  const resolved = resolveDslQueryToQueryPlan(parsed.ast, {
    currentTable: { kind: "table", id: item.tableId, shortId: item.tableShortId, name: "Cases" },
    tables: [{ kind: "table", id: item.tableId, shortId: item.tableShortId, name: "Cases" }],
    views: [],
    fieldsByTableId: { [item.tableId]: tableFields },
  });
  if (!resolved.ok) throw new Error(resolved.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  const preview = await previewDslQuery(resolved.plan, { fieldsByTableId: { [item.tableId]: tableFields }, limit: 100 });
  if (!preview.ok || preview.data.mode !== "rows") throw new Error("Finalization state preview failed");
  return preview.data.rows.flatMap((row) => (row.recordId ? [row.recordId] : []));
};

describe("record finalization Postgres integration", () => {
  postgresTest(
    "recalculates list formulas while draft and freezes their typed results at finalization",
    async () => {
      const item = await fixture();
      try {
        const amount = { id: "Amount", name: "Amount", type: "number", config: { decimalPlaces: 2 } };
        const total = { id: "Total1", name: "Total", type: "number", config: { decimalPlaces: 2 }, formula: { expression: "Amount * 2" } };
        const list = await fields.create(
          { tableId: item.tableId, name: "Lines", type: "object_list", config: { fields: [amount, total] } },
          null,
        );
        if (!list.ok) throw list.error;
        const sum = await fields.create(
          { tableId: item.tableId, name: "Invoice total", type: "formula", config: { expression: "LIST_SUM(Lines, 'Total')" } },
          null,
        );
        if (!sum.ok) throw sum.error;
        const record = await records.create(
          item.tableId,
          { [item.name.id]: "Calculated invoice", [list.data.id]: [{ Amount: "0.10" }] },
          null,
          "direct",
        );
        if (!record.ok) throw record.error;
        expect(record.data.data[list.data.id]).toEqual([{ Amount: "0.10", Total1: "0.20" }]);
        expect(record.data.data[sum.data.id]).toBe("0.2");
        const changed = await fields.update(
          list.data.id,
          { config: { fields: [amount, { ...total, formula: { expression: "Amount * 3" } }] } },
          null,
        );
        if (!changed.ok) throw changed.error;
        expect((await getRecord(item.tableId, record.data.id))?.data[list.data.id]).toEqual([{ Amount: "0.10", Total1: "0.30" }]);
        const finalized = await finalization.finalize({ tableId: item.tableId, recordId: record.data.id, actorId: null, origin: "direct" });
        if (!finalized.ok) throw finalized.error;
        expect(finalized.data.data[list.data.id]).toEqual([{ Amount: "0.10", Total1: "0.30" }]);
        expect(finalized.data.data[sum.data.id]).toBe("0.3");
        const later = await fields.update(
          list.data.id,
          { config: { fields: [amount, { ...total, formula: { expression: "Amount * 4" } }] } },
          null,
        );
        if (!later.ok) throw later.error;
        expect((await getRecord(item.tableId, record.data.id))?.data[list.data.id]).toEqual([{ Amount: "0.10", Total1: "0.30" }]);
        expect((await getRecord(item.tableId, record.data.id))?.data[sum.data.id]).toBe("0.3");
        const changedAfterFreeze = await fields.update(
          list.data.id,
          { config: { fields: [amount, { ...total, formula: { expression: "Amount / 0" } }] } },
          null,
        );
        expect(changedAfterFreeze.ok).toBe(true);
        expect((await getRecord(item.tableId, record.data.id))?.data[list.data.id]).toEqual([{ Amount: "0.10", Total1: "0.30" }]);
        const restoredCalculation = await fields.update(
          list.data.id,
          { config: { fields: [amount, { ...total, formula: { expression: "Amount * 4" } }] } },
          null,
        );
        if (!restoredCalculation.ok) throw restoredCalculation.error;
        const draft = await records.create(
          item.tableId,
          { [item.name.id]: "Next invoice", [list.data.id]: [{ Amount: "0.10" }] },
          null,
          "direct",
        );
        if (!draft.ok) throw draft.error;
        const invalidatesDraft = await fields.update(
          list.data.id,
          { config: { fields: [amount, { ...total, formula: { expression: "Amount / 0" } }] } },
          null,
        );
        expect(invalidatesDraft.ok).toBe(false);
        expect((await getRecord(item.tableId, draft.data.id))?.data[list.data.id]).toEqual([{ Amount: "0.10", Total1: "0.40" }]);
        const tableFields = await fields.listByTable(item.tableId);
        for (const [recordId, expectedCell, expectedSum] of [
          [record.data.id, "0.30", "0.3"],
          [draft.data.id, "0.40", "0.4"],
        ] as const) {
          const snapshot = await createRecordSnapshotDraft({
            baseId: item.baseId,
            tableId: item.tableId,
            recordId,
            actorId: null,
            canReadTable: async (target) => target.tableId === item.tableId,
          });
          if (!snapshot.ok) throw snapshot.error;
          expect(snapshot.data.root).toMatchObject({
            data: {
              [list.data.id]: [{ Amount: "0.10", Total1: expectedCell }],
              [sum.data.id]: expectedSum,
            },
          });
        }
        const source = { kind: "table" as const, id: item.tableId, shortId: item.tableShortId, name: "Cases" };
        for (const clause of [
          "select Lines, formula(LIST_SUM(Lines, 'Total')) as total",
          "aggregate sum(formula(LIST_SUM(Lines, 'Total'))) as total",
        ]) {
          const parsed = parseGridsQueryDsl(`from table {${item.tableShortId}}\n${clause}`);
          if (!parsed.ok) throw new Error(parsed.diagnostics.map((issue) => issue.message).join("\n"));
          const resolved = resolveDslQueryToQueryPlan(parsed.ast, {
            currentTable: source,
            tables: [source],
            views: [],
            fieldsByTableId: { [item.tableId]: tableFields },
          });
          if (!resolved.ok) throw new Error(resolved.diagnostics.map((issue) => issue.message).join("\n"));
          const preview = await previewDslQuery(resolved.plan, { fieldsByTableId: { [item.tableId]: tableFields }, limit: 100 });
          if (!preview.ok) throw preview.error;
          if (clause.startsWith("aggregate")) expect(Object.values(preview.data.rows[0]!.values)).toEqual(["0.7"]);
          else {
            expect(preview.data.rows.map((row) => Object.values(row.values)[1]).sort()).toEqual(["0.3", "0.4"]);
            expect(preview.data.rows.every((row) => Array.isArray(Object.values(row.values)[0]))).toBe(true);
          }
        }
        // The ordinary formula field must also retain its frozen numeric type
        // for filtering, ordering and grouped aggregates across mixed states.
        for (const [clause, expected] of [
          [`select {${sum.data.shortId}}\nsort {${sum.data.shortId}} desc`, [["0.4"], ["0.3"]]],
          [`select {${sum.data.shortId}}\nwhere {${sum.data.shortId}} < 0.35`, [["0.3"]]],
          [
            `group by {${item.name.shortId}}\naggregate sum({${sum.data.shortId}}) as total\nsort {${item.name.shortId}} asc`,
            [
              ["Calculated invoice", "0.3"],
              ["Next invoice", "0.4"],
            ],
          ],
        ] satisfies Array<[string, string[][]]>) {
          const parsed = parseGridsQueryDsl(`from table {${item.tableShortId}}\n${clause}`);
          if (!parsed.ok) throw new Error(parsed.diagnostics.map((issue) => issue.message).join("\n"));
          const resolved = resolveDslQueryToQueryPlan(parsed.ast, {
            currentTable: source,
            tables: [source],
            views: [],
            fieldsByTableId: { [item.tableId]: tableFields },
          });
          if (!resolved.ok) throw new Error(resolved.diagnostics.map((issue) => issue.message).join("\n"));
          const preview = await previewDslQuery(resolved.plan, { fieldsByTableId: { [item.tableId]: tableFields }, limit: 100 });
          if (!preview.ok) throw preview.error;
          expect(preview.data.rows.map((row) => Object.values(row.values))).toEqual(expected);
        }
      } finally {
        await cleanup(item.baseId);
      }
    },
    15_000,
  );

  postgresTest(
    "keeps owned object-list values typed, atomic and immutable",
    async () => {
      const item = await fixture();
      try {
        const columns = [
          { id: "Label1", name: "Description", type: "text", required: true },
          { id: "Amount", name: "Amount", type: "number", config: { decimalPlaces: 2, unit: "EUR" } },
          { id: "Rate01", name: "Rate", type: "percent", config: { range: "percent" } },
        ];
        const list = await fields.create({ tableId: item.tableId, name: "Items", type: "object_list", config: { fields: columns } }, null);
        if (!list.ok) throw list.error;
        const data = [{ Label1: "Consulting", Amount: "9007199254740993.25", Rate01: 0.25 }];
        const record = await records.create(item.tableId, { [item.name.id]: "Invoice", [list.data.id]: data }, null, "direct");
        if (!record.ok) throw record.error;
        expect((await getRecord(item.tableId, record.data.id))?.data[list.data.id]).toEqual(data);
        const invalid = await records.update(item.tableId, record.data.id, { [list.data.id]: [{ Label1: "" }] }, null, "direct");
        expect(invalid.ok).toBe(false);
        expect((await getRecord(item.tableId, record.data.id))?.version).toBe(record.data.version);
        const renamedColumns = columns.map((column) => ({ ...column, name: column.id === "Label1" ? "Item description" : column.name }));
        expect((await fields.update(list.data.id, { config: { fields: renamedColumns } }, null)).ok).toBe(true);
        const removedColumn = await fields.update(list.data.id, { config: { fields: [columns[0]] } }, null);
        expect(removedColumn.ok).toBe(false);
        const retypedColumn = await fields.update(
          list.data.id,
          { config: { fields: columns.map((column) => (column.id === "Amount" ? { ...column, type: "text", config: {} } : column)) } },
          null,
        );
        expect(retypedColumn.ok).toBe(false);
        const finalized = await finalization.finalize({ tableId: item.tableId, recordId: record.data.id, actorId: null, origin: "direct" });
        if (!finalized.ok) throw finalized.error;
        const updated = await records.update(item.tableId, record.data.id, { [list.data.id]: [] }, null, "direct");
        expect(updated.ok).toBe(false);
        const changedCurrency = await fields.update(
          list.data.id,
          {
            config: {
              fields: columns.map((column) => (column.id === "Amount" ? { ...column, config: { decimalPlaces: 2, unit: "USD" } } : column)),
            },
          },
          null,
        );
        expect(changedCurrency.ok).toBe(false);
        const changedScale = await fields.update(
          list.data.id,
          { config: { fields: columns.map((column) => (column.id === "Rate01" ? { ...column, config: { range: "fraction" } } : column)) } },
          null,
        );
        expect(changedScale.ok).toBe(false);
        expect((await getRecord(item.tableId, record.data.id))?.data[list.data.id]).toEqual(data);
        const [revision] = await sql<
          Array<{ data: Record<string, unknown> }>
        >`SELECT data FROM grids.record_revisions WHERE id = ${finalized.data.finalRevisionId}::uuid`;
        expect(revision?.data[list.data.id]).toEqual(data);
      } finally {
        await cleanup(item.baseId);
      }
    },
    15_000,
  );

  postgresTest(
    "freezes formula lookup and rollup values and rejects target calculation errors",
    async () => {
      const item = await fixture();
      try {
        const targetTableId = testUuid();
        await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${targetTableId}::uuid, ${testShortId("T")}, ${item.baseId}::uuid, 'Lines')`;
        const amount = await fields.create({ tableId: targetTableId, name: "Amount", type: "number" }, null);
        if (!amount.ok) throw amount.error;
        const calculated = await fields.create(
          { tableId: targetTableId, name: "Calculated", type: "formula", config: { expression: "Amount * 2" } },
          null,
        );
        if (!calculated.ok) throw calculated.error;
        const relation = await fields.create(
          { tableId: item.tableId, name: "Line", type: "relation", config: { targetTableId, cardinality: "single" } },
          null,
        );
        if (!relation.ok) throw relation.error;
        const lookup = await fields.create(
          {
            tableId: item.tableId,
            name: "Line value",
            type: "lookup",
            config: { relationFieldId: relation.data.id, targetFieldId: calculated.data.id },
          },
          null,
        );
        const rollup = await fields.create(
          {
            tableId: item.tableId,
            name: "Lines total",
            type: "rollup",
            config: { relationFieldId: relation.data.id, targetFieldId: calculated.data.id, agg: "sum" },
          },
          null,
        );
        if (!lookup.ok) throw lookup.error;
        if (!rollup.ok) throw rollup.error;
        const target = await records.create(targetTableId, { [amount.data.id]: "11.11" }, null, "direct");
        if (!target.ok) throw target.error;
        const parent = await records.create(
          item.tableId,
          { [item.name.id]: "Parent", [relation.data.id]: [target.data.id] },
          null,
          "direct",
        );
        if (!parent.ok) throw parent.error;
        const finalized = await finalization.finalize({ tableId: item.tableId, recordId: parent.data.id, actorId: null, origin: "direct" });
        if (!finalized.ok) throw finalized.error;
        expect(finalized.data.data[lookup.data.id]).toBe("22.22");
        expect(finalized.data.data[rollup.data.id]).toBe("22.22");
        const updated = await records.update(targetTableId, target.data.id, { [amount.data.id]: "20" }, null, "direct");
        if (!updated.ok) throw updated.error;
        const reread = await getRecord(item.tableId, parent.data.id);
        expect(reread?.data[lookup.data.id]).toBe("22.22");
        expect(reread?.data[rollup.data.id]).toBe("22.22");
        const broken = await fields.update(calculated.data.id, { config: { expression: "Amount / 0" } }, null);
        if (!broken.ok) throw broken.error;
        const draft = await records.create(
          item.tableId,
          { [item.name.id]: "Invalid", [relation.data.id]: [target.data.id] },
          null,
          "direct",
        );
        if (!draft.ok) throw draft.error;
        const rejected = await finalization.finalize({ tableId: item.tableId, recordId: draft.data.id, actorId: null, origin: "direct" });
        expect(rejected.ok).toBe(false);
        if (!rejected.ok) expect(rejected.error.status).toBe(400);
        const [stored] = await sql<
          Array<{ finalized_at: Date | null; number: string | null }>
        >`SELECT finalized_at, data->>${item.number.id} AS number FROM grids.records WHERE id = ${draft.data.id}::uuid`;
        expect(stored?.finalized_at).toBeNull();
        expect(stored?.number).toBeNull();
        expect((await getRecord(item.tableId, parent.data.id))?.data[lookup.data.id]).toBe("22.22");
      } finally {
        await cleanup(item.baseId);
      }
    },
    15_000,
  );

  postgresTest(
    "binds computed definitions and the reviewed instant to Four-eyes approval",
    async () => {
      const requesterId = testUuid();
      const approverId = testUuid();
      const groupId = testUuid();
      await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn) VALUES
      (${requesterId}::uuid, ${requesterId}, 'local', 'user', 'Requester', 'Request', 'User'),
      (${approverId}::uuid, ${approverId}, 'local', 'user', 'Approver', 'Approve', 'User')`;
      await sql`INSERT INTO auth.groups (id, cn, provider, name) VALUES (${groupId}::uuid, ${groupId}, 'local', ${groupId})`;
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${approverId}::uuid, ${groupId}::uuid)`;
      const item = await fixture({ mode: "fourEyes", approverGroupId: groupId });
      try {
        const approvalFormula = await fields.create(
          { tableId: item.tableId, name: "Reviewed amount", type: "formula", config: { expression: "10 + 1" } },
          requesterId,
        );
        if (!approvalFormula.ok) throw approvalFormula.error;
        const reviewedTime = await fields.create(
          { tableId: item.tableId, name: "Reviewed instant", type: "formula", config: { expression: "NOW()" } },
          requesterId,
        );
        if (!reviewedTime.ok) throw reviewedTime.error;
        const calculationTarget = await records.create(item.tableId, { [item.name.id]: "Calculation review" }, requesterId, "direct");
        if (!calculationTarget.ok) throw calculationTarget.error;
        const initialRequest = await finalization.requestFinalization({
          tableId: item.tableId,
          recordId: calculationTarget.data.id,
          actorId: requesterId,
        });
        if (!initialRequest.ok) throw initialRequest.error;
        const retriedRequest = await finalization.requestFinalization({
          tableId: item.tableId,
          recordId: calculationTarget.data.id,
          actorId: requesterId,
        });
        expect(retriedRequest.ok && retriedRequest.data.id).toBe(initialRequest.data.id);
        const formulaChange = await fields.update(approvalFormula.data.id, { config: { expression: "10 + 2" } }, requesterId);
        if (!formulaChange.ok) throw formulaChange.error;
        const outdatedApproval = await finalization.approveFinalization({
          tableId: item.tableId,
          recordId: calculationTarget.data.id,
          requestId: initialRequest.data.id,
          actorId: approverId,
        });
        expect(outdatedApproval.ok).toBe(false);
        if (!outdatedApproval.ok) expect(outdatedApproval.error.status).toBe(409);
        const replacement = await finalization.requestFinalization({
          tableId: item.tableId,
          recordId: calculationTarget.data.id,
          actorId: requesterId,
        });
        if (!replacement.ok) throw replacement.error;
        expect(replacement.data.id).not.toBe(initialRequest.data.id);
        const currentApproval = await finalization.approveFinalization({
          tableId: item.tableId,
          recordId: calculationTarget.data.id,
          requestId: replacement.data.id,
          actorId: approverId,
        });
        if (!currentApproval.ok) throw currentApproval.error;
        expect(currentApproval.data.data[approvalFormula.data.id]).toBe("12");
        expect(currentApproval.data.data[reviewedTime.data.id]).toBe(replacement.data.requestedAt);
      } finally {
        await cleanup(item.baseId);
        await sql`DELETE FROM auth.user_groups_v2 WHERE group_id = ${groupId}::uuid`;
        await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
        await sql`DELETE FROM auth.users WHERE id IN (${requesterId}::uuid, ${approverId}::uuid)`;
      }
    },
    15_000,
  );

  postgresTest(
    "serializes a result-type edit against an in-flight finalization",
    async () => {
      const item = await fixture();
      const held = Promise.withResolvers<number>();
      const finish = Promise.withResolvers<void>();
      const tasks: Promise<unknown>[] = [];
      try {
        const formula = await fields.create(
          { tableId: item.tableId, name: "Total", type: "formula", config: { expression: "12.34" } },
          null,
        );
        if (!formula.ok) throw formula.error;
        const record = await records.create(item.tableId, { [item.name.id]: "Concurrent" }, null, "direct");
        if (!record.ok) throw record.error;
        const finalized = sql.begin(async (tx) => {
          await tx`SELECT id FROM grids.tables WHERE id = ${item.tableId}::uuid FOR SHARE`;
          const [backend] = await tx<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          held.resolve(backend!.pid);
          await finish.promise;
          return finalization.finalizeInTransaction(tx, {
            tableId: item.tableId,
            recordId: record.data.id,
            actorId: null,
            origin: "direct",
          });
        });
        tasks.push(finalized);
        const pid = await held.promise;
        const changed = fields.update(formula.data.id, { config: { expression: "'text'" } }, null);
        tasks.push(changed);
        const deadline = Date.now() + 5_000;
        let waiting = false;
        while (Date.now() < deadline) {
          const [state] = await sql<
            Array<{ waiting: boolean }>
          >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS waiting`;
          if (state?.waiting) {
            waiting = true;
            break;
          }
          await Bun.sleep(10);
        }
        expect(waiting).toBe(true);
        finish.resolve();
        expect((await finalized).ok).toBe(true);
        const result = await changed;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.status).toBe(409);
        expect((await getRecord(item.tableId, record.data.id))?.data[formula.data.id]).toBe("12.34");
      } finally {
        finish.resolve();
        await Promise.allSettled(tasks);
        await cleanup(item.baseId);
      }
    },
    15_000,
  );

  postgresTest("captures exact computed values and keeps them after a same-type formula change", async () => {
    const item = await fixture();
    try {
      const amount = await fields.create({ tableId: item.tableId, name: "Amount", type: "number", config: { unit: "EUR" } }, null);
      if (!amount.ok) throw amount.error;
      const rate = await fields.create({ tableId: item.tableId, name: "Rate", type: "percent", config: {} }, null);
      if (!rate.ok) throw rate.error;
      const total = await fields.create(
        { tableId: item.tableId, name: "Total", type: "formula", config: { expression: "9007199254740993.25 + 0.10" } },
        null,
      );
      if (!total.ok) throw total.error;
      const power = await fields.create(
        { tableId: item.tableId, name: "Fractional power", type: "formula", config: { expression: "POW(2, 0.5)" } },
        null,
      );
      if (!power.ok) throw power.error;
      const created = await records.create(
        item.tableId,
        { [item.name.id]: "Exact", [amount.data.id]: "12.34", [rate.data.id]: 0.25 },
        null,
        "direct",
      );
      if (!created.ok) throw created.error;
      const finalized = await finalization.finalize({ tableId: item.tableId, recordId: created.data.id, actorId: null, origin: "direct" });
      if (!finalized.ok) throw finalized.error;
      expect(finalized.data.data[total.data.id]).toBe("9007199254740993.35");
      expect(finalized.data.data[power.data.id]).toBe(created.data.data[power.data.id]);
      expect(typeof finalized.data.data[power.data.id]).toBe("string");
      const changed = await fields.update(total.data.id, { config: { expression: "1 + 1" } }, null);
      if (!changed.ok) throw changed.error;
      const reread = await getRecord(item.tableId, created.data.id);
      expect(reread?.data[total.data.id]).toBe("9007199254740993.35");
      expect(reread?.data[power.data.id]).toBe(created.data.data[power.data.id]);
      const retyped = await fields.update(total.data.id, { config: { expression: "'not a number'" } }, null);
      expect(retyped.ok).toBe(false);
      if (!retyped.ok) expect(retyped.error.status).toBe(409);
      const definition = await fields.get(total.data.id);
      expect(definition?.config).toEqual({ expression: "1 + 1" });
      const differentUnit = await fields.update(amount.data.id, { config: { unit: "USD" } }, null);
      expect(differentUnit.ok).toBe(false);
      if (!differentUnit.ok) expect(differentUnit.error.status).toBe(409);
      expect((await fields.get(amount.data.id))?.config).toEqual({ unit: "EUR" });
      const differentScale = await fields.update(rate.data.id, { config: { range: "fraction" } }, null);
      expect(differentScale.ok).toBe(false);
      if (!differentScale.ok) expect(differentScale.error.status).toBe(409);
      expect((await fields.get(rate.data.id))?.config).toEqual({});
      const [revision] = await sql<
        Array<{ data: Record<string, unknown> }>
      >`SELECT data FROM grids.record_revisions WHERE id = ${finalized.data.finalRevisionId}::uuid`;
      expect(revision?.data[total.data.id]).toBe("9007199254740993.35");
    } finally {
      await cleanup(item.baseId);
    }
  });

  for (const change of ["policy", "disable"] as const) {
    postgresTest(`a Four Eyes request and ${change} settle without inverted Table locks`, async () => {
      const actorId = testUuid();
      const groupId = testUuid();
      await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
        VALUES (${actorId}::uuid, ${`lock-order-${actorId}`}, 'local', 'user', 'Requester', 'Request', 'User')`;
      await sql`INSERT INTO auth.groups (id, cn, provider, name)
        VALUES (${groupId}::uuid, ${`lock-order-${groupId}`}, 'local', 'Approvers')`;
      const item = await fixture({ mode: "fourEyes", approverGroupId: groupId });
      const releaseRecord = Promise.withResolvers<void>();
      const recordLocked = Promise.withResolvers<number>();
      const requestStarted = Promise.withResolvers<number>();
      const tasks: Promise<unknown>[] = [];
      const waitForBlock = async (blockingPid: number, blockedPid?: number): Promise<void> => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const rows = await sql<Array<{ pid: number }>>`
            SELECT pid FROM pg_stat_activity
            WHERE ${blockingPid}::int = ANY(pg_blocking_pids(pid))
              AND (${blockedPid ?? null}::int IS NULL OR pid = ${blockedPid ?? null}::int)
          `;
          if (rows.length > 0) return;
          await Bun.sleep(10);
        }
        throw new Error("Expected finalization transaction did not reach its lock wait");
      };
      try {
        if (change === "disable") {
          // Finalization-number fields intentionally prohibit disabling. This
          // race needs a Table whose policy can actually be disabled.
          const removed = await fields.softDelete(item.number.id, actorId);
          if (!removed.ok) throw removed.error;
        }
        const record = await records.create(item.tableId, { [item.name.id]: "Lock ordering" }, actorId, "direct");
        if (!record.ok) throw record.error;
        const blocker = sql.begin(async (tx) => {
          await tx`SELECT id FROM grids.records WHERE id = ${record.data.id}::uuid FOR UPDATE`;
          const [backend] = await tx<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          if (!backend) throw new Error("Missing record locker backend");
          recordLocked.resolve(backend.pid);
          await releaseRecord.promise;
        });
        tasks.push(blocker);
        void blocker.catch(recordLocked.reject);
        const blockerPid = await recordLocked.promise;
        const request = sql.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '10s'`;
          const [backend] = await tx<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          if (!backend) throw new Error("Missing request backend");
          requestStarted.resolve(backend.pid);
          return finalization.requestFinalizationInTransaction(tx, { tableId: item.tableId, recordId: record.data.id, actorId });
        });
        tasks.push(request);
        void request.catch(requestStarted.reject);
        const requestPid = await requestStarted.promise;
        // The request has its activation lock and is waiting for the Record.
        await waitForBlock(blockerPid, requestPid);
        const mutation =
          change === "policy"
            ? finalization.setPolicy(item.tableId, { mode: "direct" }, actorId)
            : finalization.disable(item.tableId, actorId);
        tasks.push(mutation);
        void mutation.catch(() => undefined);
        await waitForBlock(requestPid);
        releaseRecord.resolve();
        const outcomes = await Promise.allSettled([request, mutation]);
        expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
        expect(outcomes.every((outcome) => outcome.status === "fulfilled" && outcome.value.ok)).toBe(true);
        const [pending] = await sql<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM grids.record_finalization_requests
          WHERE table_id = ${item.tableId}::uuid AND status = 'pending'
        `;
        expect(pending?.count).toBe(0);
      } finally {
        releaseRecord.resolve();
        await Promise.allSettled(tasks);
        await cleanup(item.baseId);
        await sql`DELETE FROM auth.users WHERE id = ${actorId}::uuid`;
        await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
      }
    });
  }

  postgresTest("keeps tables in draft mode until history-backed finalization is explicitly enabled", async () => {
    const baseId = testUuid();
    const tableId = testUuid();
    const groupId = testUuid();
    await sql`INSERT INTO auth.groups (id, cn, provider, name) VALUES (${groupId}::uuid, ${`finalization-policy-${groupId}`}, 'local', 'Other policy')`;
    await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Draft default')`;
    await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Drafts')`;
    try {
      expect(await finalization.getStatus(tableId)).toEqual({ ok: true, data: { enabled: false, durableHistory: "disabled" } });
      const withoutHistory = await finalization.enable(tableId, { mode: "direct" }, null);
      expect(withoutHistory.ok).toBe(false);
      if (!withoutHistory.ok) expect(withoutHistory.error.status).toBe(400);
      const prematureField = await fields.create(
        {
          tableId,
          name: "Final number",
          type: "id",
          config: { strategy: "sequence", prefix: "FIN-", padding: 3, assignment: "finalization" },
        },
        null,
      );
      expect(prematureField.ok).toBe(false);

      const history = await durableHistory.enable(tableId, null);
      if (!history.ok) throw history.error;
      const competingEnables = await Promise.allSettled([
        finalization.enable(tableId, { mode: "direct" }, null),
        finalization.enable(tableId, { mode: "fourEyes", approverGroupId: groupId }, null),
      ]);
      // Wait for both transactions before cleanup, even when a lock regression rejects one.
      expect(competingEnables.filter((result) => result.status === "rejected")).toEqual([]);
      expect(competingEnables.filter((result) => result.status === "fulfilled" && result.value.ok)).toHaveLength(1);
      expect(competingEnables.filter((result) => result.status === "fulfilled" && !result.value.ok)).toHaveLength(1);
      const status = await finalization.getStatus(tableId);
      if (!status.ok || !status.data.enabled) throw new Error("Finalization activation failed");
      const winningPolicy =
        status.data.mode === "fourEyes" ? { mode: "fourEyes" as const, approverGroupId: groupId } : { mode: "direct" as const };
      expect((await finalization.enable(tableId, winningPolicy, null)).ok).toBe(true);
      expect(await finalization.disable(tableId, null)).toEqual({
        ok: true,
        data: { enabled: false, durableHistory: "active" },
      });
    } finally {
      await cleanup(baseId);
      await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    }
  });

  postgresTest("finalizes once, allocates one final number, and blocks every record mutation owner", async () => {
    const item = await fixture();
    try {
      const incomplete = await records.create(item.tableId, {}, null, "direct");
      if (!incomplete.ok) throw incomplete.error;
      const required = await fields.update(item.name.id, { required: true }, null);
      if (!required.ok) throw required.error;
      const readiness = await finalization.inspect({ tableId: item.tableId, recordId: incomplete.data.id });
      expect(readiness.ok && readiness.data.missing).toEqual([
        { fieldId: item.name.id, fieldName: "Name", message: "A value is required." },
      ]);
      expect(
        (await finalization.finalize({ tableId: item.tableId, recordId: incomplete.data.id, actorId: null, origin: "direct" })).ok,
      ).toBe(false);

      const target = await records.create(item.tableId, { [item.name.id]: "Target" }, null, "direct");
      if (!target.ok) throw target.error;
      const created = await records.create(item.tableId, { [item.name.id]: "Ready", [item.relation.id]: [target.data.id] }, null, "direct");
      if (!created.ok) throw created.error;
      expect(created.data.data[item.number.id]).toBeUndefined();
      const attached = await files.upload({
        tableId: item.tableId,
        recordId: created.data.id,
        fieldId: item.attachment.id,
        filename: "evidence.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("original"),
        userId: null,
        origin: "direct",
      });
      if (!attached.ok) throw attached.error;

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          finalization.finalize({ tableId: item.tableId, recordId: created.data.id, actorId: null, origin: "direct" }),
        ),
      );
      expect(results.every((result) => result.ok)).toBe(true);
      const finalNumbers = results.flatMap((result) => (result.ok ? [result.data.data[item.number.id]] : []));
      expect(new Set(finalNumbers).size).toBe(1);
      expect(finalNumbers[0]).toBe("FIN-001");

      const [state] = await sql<Array<{ finalized_at: Date; final_revision_id: string; allocations: number; revisions: number }>>`
        SELECT record.finalized_at, record.final_revision_id::text,
          (SELECT COUNT(*)::int FROM grids.number_allocations allocation
           JOIN grids.number_series series ON series.id = allocation.series_id
           WHERE series.field_id = ${item.number.id}::uuid AND allocation.consumer_id = record.id) AS allocations,
          (SELECT COUNT(*)::int FROM grids.record_revisions revision
           WHERE revision.id = record.final_revision_id AND revision.action = 'finalized') AS revisions
        FROM grids.records record WHERE record.id = ${created.data.id}::uuid
      `;
      expect(state?.finalized_at).toBeTruthy();
      expect(state?.final_revision_id).toBeTruthy();
      expect(state?.allocations).toBe(1);
      expect(state?.revisions).toBe(1);

      const tableFields = await fields.listByTable(item.tableId);
      const parsed = parseGridsQueryDsl(`from table {${item.tableShortId}}\nselect {${item.name.shortId}}`);
      if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
      const resolved = resolveDslQueryToQueryPlan(parsed.ast, {
        currentTable: { kind: "table", id: item.tableId, shortId: item.tableShortId, name: "Cases" },
        tables: [{ kind: "table", id: item.tableId, shortId: item.tableShortId, name: "Cases" }],
        views: [],
        fieldsByTableId: { [item.tableId]: tableFields },
      });
      if (!resolved.ok) throw new Error(resolved.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
      const preview = await previewDslQuery(resolved.plan, { fieldsByTableId: { [item.tableId]: tableFields }, limit: 20 });
      if (!preview.ok) throw preview.error;
      expect(preview.data.rows.find((row) => row.recordId === created.data.id)?.recordMeta?.finalizedAt).toBeTruthy();

      const update = await records.update(item.tableId, created.data.id, { [item.name.id]: "Changed" }, null, "direct");
      expect(update.ok).toBe(false);
      if (!update.ok) expect(update.error.status).toBe(409);
      expect((await records.softDelete(item.tableId, created.data.id, null, "direct")).ok).toBe(false);
      const upload = await files.upload({
        tableId: item.tableId,
        recordId: created.data.id,
        fieldId: item.attachment.id,
        filename: "late.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("late"),
        userId: null,
        origin: "direct",
      });
      expect(upload.ok).toBe(false);
      if (!upload.ok) expect(upload.error.status).toBe(409);
      const replaced = await files.replace({
        tableId: item.tableId,
        recordId: created.data.id,
        fieldId: item.attachment.id,
        fileId: attached.data.id,
        filename: "replacement.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("replacement"),
        userId: null,
        origin: "direct",
      });
      expect(replaced.ok).toBe(false);
      if (!replaced.ok) expect(replaced.error.status).toBe(409);
      const removed = await files.remove({
        tableId: item.tableId,
        recordId: created.data.id,
        fieldId: item.attachment.id,
        fileId: attached.data.id,
        userId: null,
        origin: "direct",
      });
      expect(removed.ok).toBe(false);
      if (!removed.ok) expect(removed.error.status).toBe(409);
      const disabled = await finalization.disable(item.tableId, null);
      expect(disabled.ok).toBe(false);
      if (!disabled.ok) expect(disabled.error.status).toBe(409);
    } finally {
      await cleanup(item.baseId);
    }
  });

  postgresTest("refuses finalization when a linked record is no longer live", async () => {
    const item = await fixture();
    try {
      const target = await records.create(item.tableId, { [item.name.id]: "Temporary target" }, null, "direct");
      if (!target.ok) throw target.error;
      const source = await records.create(item.tableId, { [item.name.id]: "Source", [item.relation.id]: [target.data.id] }, null, "direct");
      if (!source.ok) throw source.error;
      const removed = await records.softDelete(item.tableId, target.data.id, null, "direct");
      if (!removed.ok) throw removed.error;

      const readiness = await finalization.inspect({ tableId: item.tableId, recordId: source.data.id });
      expect(readiness.ok && readiness.data.missing).toContainEqual({
        fieldId: item.relation.id,
        fieldName: "Related case",
        message: "A linked Record is no longer available.",
      });
      const finalized = await finalization.finalize({ tableId: item.tableId, recordId: source.data.id, actorId: null, origin: "direct" });
      expect(finalized.ok).toBe(false);
      if (!finalized.ok) expect(finalized.error.status).toBe(400);
    } finally {
      await cleanup(item.baseId);
    }
  });

  postgresTest("rolls back the marker, revision, and allocation while preserving the intentional number gap", async () => {
    const item = await fixture();
    const triggerName = `fail_final_${item.tableId.replaceAll("-", "")}`;
    const functionName = `${triggerName}_fn`;
    try {
      const primer = await records.create(item.tableId, { [item.name.id]: "Primer" }, null, "direct");
      if (!primer.ok) throw primer.error;
      const primed = await finalization.finalize({ tableId: item.tableId, recordId: primer.data.id, actorId: null, origin: "direct" });
      if (!primed.ok) throw primed.error;
      expect(primed.data.data[item.number.id]).toBe("FIN-001");
      const draft = await records.create(item.tableId, { [item.name.id]: "Rollback" }, null, "direct");
      if (!draft.ok) throw draft.error;
      await sql.unsafe(`
        CREATE FUNCTION grids.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action = 'finalized' THEN RAISE EXCEPTION 'forced final revision failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER ${triggerName} BEFORE INSERT ON grids.record_revisions
        FOR EACH ROW EXECUTE FUNCTION grids.${functionName}();
      `);
      await expect(
        finalization.finalize({ tableId: item.tableId, recordId: draft.data.id, actorId: null, origin: "direct" }),
      ).rejects.toThrow("forced final revision failure");
      const [rolledBack] = await sql<Array<{ finalized_at: Date | null; value: string | null; allocations: number }>>`
        SELECT finalized_at, data->>${item.number.id} AS value,
          (SELECT COUNT(*)::int FROM grids.number_allocations allocation
           JOIN grids.number_series series ON series.id = allocation.series_id WHERE series.field_id = ${item.number.id}::uuid) AS allocations
        FROM grids.records WHERE id = ${draft.data.id}::uuid
      `;
      expect(rolledBack).toEqual({ finalized_at: null, value: null, allocations: 1 });
      await sql.unsafe(`DROP TRIGGER ${triggerName} ON grids.record_revisions; DROP FUNCTION grids.${functionName}()`);
      const finalized = await finalization.finalize({ tableId: item.tableId, recordId: draft.data.id, actorId: null, origin: "direct" });
      if (!finalized.ok) throw finalized.error;
      expect(finalized.data.data[item.number.id]).toBe("FIN-003");
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON grids.record_revisions`).catch(() => undefined);
      await sql.unsafe(`DROP FUNCTION IF EXISTS grids.${functionName}()`).catch(() => undefined);
      await cleanup(item.baseId);
    }
  });

  postgresTest("rejects a previewed policy revision under the activation lock", async () => {
    const actorId = testUuid();
    const groupId = testUuid();
    await sql`
      INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
      VALUES (${actorId}::uuid, ${`policy-actor-${actorId}`}, 'local', 'user', 'Policy actor', 'Policy', 'Actor')
    `;
    await sql`
      INSERT INTO auth.groups (id, cn, provider, name)
      VALUES (${groupId}::uuid, ${`policy-reviewers-${groupId}`}, 'local', 'Policy reviewers')
    `;
    const item = await fixture({ mode: "fourEyes", approverGroupId: groupId });
    try {
      const previewed = await finalization.getStatus(item.tableId);
      if (!previewed.ok || !previewed.data.enabled) throw new Error("Finalization policy fixture failed");
      const target = await records.create(item.tableId, { [item.name.id]: "Policy revision" }, actorId, "direct");
      if (!target.ok) throw target.error;

      const direct = await finalization.setPolicy(item.tableId, { mode: "direct" }, actorId);
      if (!direct.ok) throw direct.error;
      const current = await finalization.setPolicy(item.tableId, { mode: "fourEyes", approverGroupId: groupId }, actorId);
      if (!current.ok || !current.data.enabled) throw new Error("Finalization policy update failed");
      const currentPolicyRevision = current.data.policyRevision;

      const staleRequest = await finalization.requestFinalization({
        tableId: item.tableId,
        recordId: target.data.id,
        actorId,
        expectedPolicyRevision: previewed.data.policyRevision,
      });
      expect(staleRequest.ok).toBe(false);
      if (!staleRequest.ok) expect(staleRequest.error.status).toBe(409);
      const [requestCount] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.record_finalization_requests WHERE record_id = ${target.data.id}::uuid
      `;
      expect(requestCount?.count).toBe(0);

      const validRequest = await finalization.requestFinalization({
        tableId: item.tableId,
        recordId: target.data.id,
        actorId,
        expectedPolicyRevision: currentPolicyRevision,
      });
      expect(validRequest.ok).toBe(true);

      const directAgain = await finalization.setPolicy(item.tableId, { mode: "direct" }, actorId);
      if (!directAgain.ok || !directAgain.data.enabled) throw new Error("Direct Finalization policy update failed");
      const directTarget = await records.create(item.tableId, { [item.name.id]: "Direct revision" }, actorId, "direct");
      if (!directTarget.ok) throw directTarget.error;
      const staleFinalize = await sql.begin((tx) =>
        finalization.finalizeInTransaction(tx, {
          tableId: item.tableId,
          recordId: directTarget.data.id,
          actorId,
          origin: "direct",
          expectedPolicyRevision: currentPolicyRevision,
        }),
      );
      expect(staleFinalize.ok).toBe(false);
      if (!staleFinalize.ok) expect(staleFinalize.error.status).toBe(409);
      const [stored] = await sql<Array<{ finalized_at: Date | null }>>`
        SELECT finalized_at FROM grids.records WHERE id = ${directTarget.data.id}::uuid
      `;
      expect(stored?.finalized_at).toBeNull();
    } finally {
      await cleanup(item.baseId);
      await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${actorId}::uuid`;
    }
  });

  postgresTest(
    "enforces a different current approver for Four-eyes Finalization and invalidates stale requests",
    async () => {
      const requesterId = testUuid();
      const approverId = testUuid();
      const outsiderId = testUuid();
      const groupId = testUuid();
      await sql`
      INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn) VALUES
        (${requesterId}::uuid, ${`requester-${requesterId}`}, 'local', 'user', 'Requester', 'Request', 'User'),
        (${approverId}::uuid, ${`approver-${approverId}`}, 'local', 'user', 'Approver', 'Approve', 'User'),
        (${outsiderId}::uuid, ${`outsider-${outsiderId}`}, 'local', 'user', 'Outsider', 'Outside', 'User')
    `;
      await sql`INSERT INTO auth.groups (id, cn, provider, name) VALUES (${groupId}::uuid, ${`approvers-${groupId}`}, 'local', ${`Service final reviewers ${groupId}`})`;
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${approverId}::uuid, ${groupId}::uuid)`;
      const item = await fixture({ mode: "fourEyes", approverGroupId: groupId });
      try {
        const policy = await finalization.getStatus(item.tableId);
        expect(policy.ok && policy.data.enabled && policy.data.mode).toBe("fourEyes");

        const first = await records.create(item.tableId, { [item.name.id]: "Needs review" }, requesterId, "direct");
        if (!first.ok) throw first.error;
        expect(await recordsInFinalizationState(item, "draft")).toContain(first.data.id);
        const direct = await finalization.finalize({
          tableId: item.tableId,
          recordId: first.data.id,
          actorId: requesterId,
          origin: "direct",
        });
        expect(direct.ok).toBe(false);
        if (!direct.ok) expect(direct.error.status).toBe(409);

        const requested = await finalization.requestFinalization({
          tableId: item.tableId,
          recordId: first.data.id,
          actorId: requesterId,
          comment: "Reviewed and ready",
        });
        expect(requested.ok && requested.data.status).toBe("pending");
        if (!requested.ok) throw requested.error;
        expect(await recordsInFinalizationState(item, "awaitingReview")).toContain(first.data.id);
        expect(await recordsInFinalizationState(item, "draft")).not.toContain(first.data.id);
        expect(
          (
            await finalization.approveFinalization({
              tableId: item.tableId,
              recordId: first.data.id,
              requestId: requested.data.id,
              actorId: requesterId,
            })
          ).ok,
        ).toBe(false);
        expect(
          (
            await finalization.approveFinalization({
              tableId: item.tableId,
              recordId: first.data.id,
              requestId: requested.data.id,
              actorId: outsiderId,
            })
          ).ok,
        ).toBe(false);
        const approved = await finalization.approveFinalization({
          tableId: item.tableId,
          recordId: first.data.id,
          requestId: requested.data.id,
          actorId: approverId,
          comment: "Approved",
        });
        expect(approved.ok && approved.data.finalizedAt).toBeTruthy();
        expect(await recordsInFinalizationState(item, "finalized")).toContain(first.data.id);
        expect(await recordsInFinalizationState(item, "awaitingReview")).not.toContain(first.data.id);
        const approvalRetry = await finalization.approveFinalization({
          tableId: item.tableId,
          recordId: first.data.id,
          requestId: requested.data.id,
          actorId: approverId,
          comment: "Approved",
        });
        expect(approvalRetry.ok && approvalRetry.data.finalizedAt).toBeTruthy();

        const stale = await records.create(item.tableId, { [item.name.id]: "Changes later" }, requesterId, "direct");
        if (!stale.ok) throw stale.error;
        const staleRequest = await finalization.requestFinalization({
          tableId: item.tableId,
          recordId: stale.data.id,
          actorId: requesterId,
        });
        if (!staleRequest.ok) throw staleRequest.error;
        const changed = await records.update(item.tableId, stale.data.id, { [item.name.id]: "Changed" }, requesterId, "direct");
        if (!changed.ok) throw changed.error;
        const staleState = await finalization.inspect({ tableId: item.tableId, recordId: stale.data.id });
        expect(staleState.ok && staleState.data.request?.status).toBe("superseded");
        const staleApproval = await finalization.approveFinalization({
          tableId: item.tableId,
          recordId: stale.data.id,
          requestId: staleRequest.data.id,
          actorId: approverId,
        });
        expect(staleApproval.ok).toBe(false);
        if (!staleApproval.ok) expect(staleApproval.error.status).toBe(409);
        const resubmitted = await finalization.requestFinalization({
          tableId: item.tableId,
          recordId: stale.data.id,
          actorId: requesterId,
        });
        expect(resubmitted.ok && resubmitted.data.status).toBe("pending");
        expect(resubmitted.ok && resubmitted.data.recordVersion).toBe(changed.data.version);

        const withFile = await records.create(item.tableId, { [item.name.id]: "File review" }, requesterId, "direct");
        if (!withFile.ok) throw withFile.error;
        const originalFile = await files.upload({
          tableId: item.tableId,
          recordId: withFile.data.id,
          fieldId: item.attachment.id,
          filename: "review.txt",
          mimeType: "text/plain",
          bytes: new TextEncoder().encode("reviewed"),
          userId: requesterId,
          origin: "direct",
        });
        if (!originalFile.ok) throw originalFile.error;
        const fileRequest = await finalization.requestFinalization({
          tableId: item.tableId,
          recordId: withFile.data.id,
          actorId: requesterId,
        });
        if (!fileRequest.ok) throw fileRequest.error;
        const replaced = await files.replace({
          tableId: item.tableId,
          recordId: withFile.data.id,
          fieldId: item.attachment.id,
          fileId: originalFile.data.id,
          filename: "changed.txt",
          mimeType: "text/plain",
          bytes: new TextEncoder().encode("not reviewed"),
          userId: requesterId,
          origin: "direct",
        });
        if (!replaced.ok) throw replaced.error;
        const afterFileChange = await finalization.inspect({ tableId: item.tableId, recordId: withFile.data.id });
        expect(afterFileChange.ok && afterFileChange.data.request?.status).toBe("superseded");
        const fileApproval = await finalization.approveFinalization({
          tableId: item.tableId,
          recordId: withFile.data.id,
          requestId: fileRequest.data.id,
          actorId: approverId,
        });
        expect(fileApproval.ok).toBe(false);

        const lifecycleRequest = await finalization.requestFinalization({
          tableId: item.tableId,
          recordId: withFile.data.id,
          actorId: requesterId,
        });
        if (!lifecycleRequest.ok) throw lifecycleRequest.error;
        expect((await records.softDelete(item.tableId, withFile.data.id, requesterId, "direct")).ok).toBe(true);
        expect((await records.restore(item.tableId, withFile.data.id, requesterId, "direct")).ok).toBe(true);
        const afterRestore = await finalization.inspect({ tableId: item.tableId, recordId: withFile.data.id });
        expect(afterRestore.ok && afterRestore.data.request?.id).toBe(lifecycleRequest.data.id);
        expect(afterRestore.ok && afterRestore.data.request?.status).toBe("superseded");

        const rejectedTarget = await records.create(item.tableId, { [item.name.id]: "Reject me" }, requesterId, "direct");
        if (!rejectedTarget.ok) throw rejectedTarget.error;
        const rejectRequest = await finalization.requestFinalization({
          tableId: item.tableId,
          recordId: rejectedTarget.data.id,
          actorId: requesterId,
        });
        if (!rejectRequest.ok) throw rejectRequest.error;
        const rejected = await finalization.rejectFinalization({
          tableId: item.tableId,
          recordId: rejectedTarget.data.id,
          requestId: rejectRequest.data.id,
          actorId: approverId,
          comment: "Needs work",
        });
        expect(rejected.ok && rejected.data.status).toBe("rejected");
        const rejectRetry = await finalization.rejectFinalization({
          tableId: item.tableId,
          recordId: rejectedTarget.data.id,
          requestId: rejectRequest.data.id,
          actorId: approverId,
          comment: "Needs work",
        });
        expect(rejectRetry).toEqual(rejected);

        const concurrentTarget = await records.create(item.tableId, { [item.name.id]: "Concurrent review" }, requesterId, "direct");
        if (!concurrentTarget.ok) throw concurrentTarget.error;
        const concurrentRequest = await finalization.requestFinalization({
          tableId: item.tableId,
          recordId: concurrentTarget.data.id,
          actorId: requesterId,
        });
        if (!concurrentRequest.ok) throw concurrentRequest.error;
        await sql`UPDATE grids.records SET version = version + 1 WHERE id = ${concurrentTarget.data.id}::uuid`;
        const concurrentResolution = await Promise.all([
          finalization.requestFinalization({
            tableId: item.tableId,
            recordId: concurrentTarget.data.id,
            actorId: requesterId,
          }),
          finalization.approveFinalization({
            tableId: item.tableId,
            recordId: concurrentTarget.data.id,
            requestId: concurrentRequest.data.id,
            actorId: approverId,
          }),
        ]);
        expect(concurrentResolution.some((result) => result.ok)).toBe(true);
        expect(concurrentResolution.some((result) => !result.ok)).toBe(true);

        const pending = await records.create(item.tableId, { [item.name.id]: "Policy change" }, requesterId, "direct");
        if (!pending.ok) throw pending.error;
        const pendingRequest = await finalization.requestFinalization({
          tableId: item.tableId,
          recordId: pending.data.id,
          actorId: requesterId,
        });
        if (!pendingRequest.ok) throw pendingRequest.error;
        const directPolicy = await finalization.setPolicy(item.tableId, { mode: "direct" }, requesterId);
        expect(directPolicy.ok && directPolicy.data.enabled && directPolicy.data.mode).toBe("direct");
        const stalePolicyApproval = await finalization.approveFinalization({
          tableId: item.tableId,
          recordId: pending.data.id,
          requestId: pendingRequest.data.id,
          actorId: approverId,
        });
        expect(stalePolicyApproval.ok).toBe(false);
        if (!stalePolicyApproval.ok) expect(stalePolicyApproval.error.status).toBe(409);
        const [falseApprovalAudit] = await sql<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM grids.audit_log
        WHERE record_id = ${pending.data.id}::uuid AND action = 'finalization.request.approved'
      `;
        expect(falseApprovalAudit?.count).toBe(0);
        const replayAfterPolicyChange = await finalization.approveFinalization({
          tableId: item.tableId,
          recordId: first.data.id,
          requestId: requested.data.id,
          actorId: approverId,
        });
        expect(replayAfterPolicyChange.ok && replayAfterPolicyChange.data.finalizedAt).toBeTruthy();
        const [approvalAudit] = await sql<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM grids.audit_log
        WHERE record_id = ${first.data.id}::uuid AND action = 'finalization.request.approved'
      `;
        expect(approvalAudit?.count).toBe(1);
        const rejectReplayAfterPolicyChange = await finalization.rejectFinalization({
          tableId: item.tableId,
          recordId: rejectedTarget.data.id,
          requestId: rejectRequest.data.id,
          actorId: approverId,
          comment: "Needs work",
        });
        expect(rejectReplayAfterPolicyChange).toEqual(rejected);
        const [rejectionAudit] = await sql<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM grids.audit_log
        WHERE record_id = ${rejectedTarget.data.id}::uuid AND action = 'finalization.request.rejected'
      `;
        expect(rejectionAudit?.count).toBe(1);
        const pendingState = await finalization.inspect({ tableId: item.tableId, recordId: pending.data.id });
        expect(pendingState.ok && pendingState.data.request?.status).toBe("superseded");
        expect(
          (await finalization.finalize({ tableId: item.tableId, recordId: pending.data.id, actorId: requesterId, origin: "direct" })).ok,
        ).toBe(true);
      } finally {
        await cleanup(item.baseId);
        await sql`DELETE FROM auth.user_groups_v2 WHERE group_id = ${groupId}::uuid`;
        await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
        await sql`DELETE FROM auth.users WHERE id IN (${requesterId}::uuid, ${approverId}::uuid, ${outsiderId}::uuid)`;
      }
    },
    15_000,
  );
});
