import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { previewDslQuery } from "../query-dsl/preview";
import { resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import * as durableHistory from "./durable-history";
import * as fields from "./fields";
import * as files from "./files";
import * as finalization from "./record-finalization";
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
      const competingEnables = await Promise.all([
        finalization.enable(tableId, { mode: "direct" }, null),
        finalization.enable(tableId, { mode: "fourEyes", approverGroupId: groupId }, null),
      ]);
      expect(competingEnables.filter((result) => result.ok)).toHaveLength(1);
      expect(competingEnables.filter((result) => !result.ok)).toHaveLength(1);
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
        message: "A linked record is no longer available.",
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

  postgresTest("enforces a different current approver for Four-eyes Finalization and invalidates stale requests", async () => {
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
    await sql`INSERT INTO auth.groups (id, cn, provider, name) VALUES (${groupId}::uuid, ${`approvers-${groupId}`}, 'local', 'Service final reviewers')`;
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
      const staleRequest = await finalization.requestFinalization({ tableId: item.tableId, recordId: stale.data.id, actorId: requesterId });
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
  });
});
