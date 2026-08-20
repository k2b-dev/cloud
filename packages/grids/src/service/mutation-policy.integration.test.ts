import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import type { TableMutationPolicy } from "../contracts";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { enable as enableDurableHistory } from "./durable-history";
import { remove as removeFile, replace as replaceFile, upload } from "./files";
import { submitForm } from "./form-submission";
import type { Form } from "./forms";
import { parseJsonbRow } from "./jsonb";
import { getImpact, update as updateMutationPolicy } from "./mutation-policy";
import { enable as enableFinalization, finalize } from "./record-finalization";
import { create, createInTransaction, restore, softDelete, update } from "./record-write";
import { deleteTestWorkflowScope, insertTestWorkflow } from "./workflow-test-fixture";

type Fixture = {
  baseId: string;
  tableId: string;
  targetTableId: string;
  textFieldId: string;
  relationFieldId: string;
  fileFieldId: string;
  targetRecordIds: [string, string];
};

const fixture = (): Fixture => ({
  baseId: testUuid(),
  tableId: testUuid(),
  targetTableId: testUuid(),
  textFieldId: testUuid(),
  relationFieldId: testUuid(),
  fileFieldId: testUuid(),
  targetRecordIds: [testUuid(), testUuid()],
});

const insertFixture = async (item: Fixture): Promise<void> => {
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${item.baseId}::uuid, ${testShortId("B")}, 'Mutation policy')`;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position) VALUES
      (${item.tableId}::uuid, ${testShortId("T")}, ${item.baseId}::uuid, 'Requests', 0),
      (${item.targetTableId}::uuid, ${testShortId("T")}, ${item.baseId}::uuid, 'Targets', 1)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position, presentable) VALUES
      (${item.textFieldId}::uuid, ${testShortId("F")}, ${item.tableId}::uuid, 'Name', 'text', '{}'::jsonb, 0, TRUE),
      (
        ${item.relationFieldId}::uuid,
        ${testShortId("F")},
        ${item.tableId}::uuid,
        'Target',
        'relation',
        ${{ targetTableId: item.targetTableId, cardinality: "single" }}::jsonb,
        1,
        FALSE
      ),
      (${item.fileFieldId}::uuid, ${testShortId("F")}, ${item.tableId}::uuid, 'Attachment', 'file', '{}'::jsonb, 2, FALSE)
  `;
  await sql`
    INSERT INTO grids.records (id, short_id, table_id, data) VALUES
      (${item.targetRecordIds[0]}::uuid, ${testShortId("R")}, ${item.targetTableId}::uuid, '{}'::jsonb),
      (${item.targetRecordIds[1]}::uuid, ${testShortId("R")}, ${item.targetTableId}::uuid, '{}'::jsonb)
  `;
};

const cleanup = async (item: Fixture): Promise<void> => {
  await sql`DELETE FROM grids.file_protected_references WHERE base_id = ${item.baseId}::uuid`;
  await sql`DELETE FROM grids.record_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${item.baseId}::uuid)`;
  await sql`DELETE FROM grids.table_finalization_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${item.baseId}::uuid)`;
  await sql`DELETE FROM grids.durable_history_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${item.baseId}::uuid)`;
  await sql`DELETE FROM grids.table_schema_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${item.baseId}::uuid)`;
  await sql`DELETE FROM grids.bases WHERE id = ${item.baseId}::uuid`;
  await deleteTestWorkflowScope(item.baseId);
};

const formFor = (item: Fixture, id = testUuid(), shortId = testShortId("M")): Form => ({
  id,
  shortId,
  tableId: item.tableId,
  name: "Request form",
  config: { fields: [{ kind: "user_input", fieldId: item.textFieldId, required: true }] },
  publicToken: null,
  isActive: true,
  ownerUserId: null,
  position: 0,
  isDefault: false,
  deletedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const createPayload = (item: Fixture, name: string) => ({ [item.textFieldId]: name });

const mutationPlan = (tableId: string) => ({
  schemaVersion: 2,
  languageId: "grids",
  languageVersion: 1,
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  catalogHash: "c".repeat(64),
  maxLoopItems: 100,
  actionPolicies: {},
  inputs: [{ name: "record", type: "record", config: { required: true } }],
  triggers: [],
  steps: [
    {
      kind: "action",
      action: "updateRecord",
      sourcePath: ["steps", 0],
      config: { record: "inputs.record", values: {} },
    },
  ],
  bindings: { "inputs.record.table": tableId },
});

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("mutation policy integration", () => {
  postgresTest("keeps the migration default and gates direct, Form, and Workflow origins fail-closed", async () => {
    const item = fixture();
    try {
      await insertFixture(item);
      const [stored] = await sql<Array<{ mutation_policy: unknown }>>`
        SELECT mutation_policy FROM grids.tables WHERE id = ${item.tableId}::uuid
      `;
      expect(parseJsonbRow<TableMutationPolicy | null>(stored?.mutation_policy, null)).toEqual({ mode: "all" });

      expect((await create(item.tableId, createPayload(item, "Direct default"), null, "direct")).ok).toBe(true);
      expect((await updateMutationPolicy(item.tableId, { mode: "selected", sources: ["form", "workflow"] }, null)).ok).toBe(true);

      const directDenied = await create(item.tableId, createPayload(item, "Denied direct"), null, "direct");
      expect(directDenied.ok).toBe(false);
      if (!directDenied.ok) expect(directDenied.error.status).toBe(403);

      const formAllowed = await submitForm({
        form: formFor(item),
        actorId: null,
        dateConfig: { timeZone: "UTC" },
        submission: { data: createPayload(item, "Allowed form"), inlineCreates: {} },
      });
      expect(formAllowed.ok).toBe(true);
      expect((await create(item.tableId, createPayload(item, "Allowed workflow"), null, "workflow")).ok).toBe(true);

      expect((await updateMutationPolicy(item.tableId, { mode: "selected", sources: ["direct"] }, null)).ok).toBe(true);
      expect(
        (
          await submitForm({
            form: formFor(item),
            actorId: null,
            dateConfig: { timeZone: "UTC" },
            submission: { data: createPayload(item, "Denied form"), inlineCreates: {} },
          })
        ).ok,
      ).toBe(false);
      expect((await create(item.tableId, createPayload(item, "Denied workflow"), null, "workflow")).ok).toBe(false);
      expect((await create(item.tableId, createPayload(item, "Allowed direct"), null, "direct")).ok).toBe(true);

      expect((await updateMutationPolicy(item.tableId, { mode: "selected", sources: [] }, null)).ok).toBe(true);
      expect((await create(item.tableId, createPayload(item, "Frozen"), null, "direct")).ok).toBe(false);

      await sql`UPDATE grids.tables SET mutation_policy = '{"mode":"broken"}'::jsonb WHERE id = ${item.tableId}::uuid`;
      const invalid = await create(item.tableId, createPayload(item, "Invalid"), null, "direct");
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) expect(invalid.error.message).toContain("policy is invalid");

      await sql`UPDATE grids.tables SET mutation_policy = 'null'::jsonb WHERE id = ${item.tableId}::uuid`;
      const nullPolicy = await create(item.tableId, createPayload(item, "Invalid null"), null, "direct");
      expect(nullPolicy.ok).toBe(false);
      if (!nullPolicy.ok) expect(nullPolicy.error.message).toContain("policy is invalid");

      const [{ count } = { count: 0 }] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${item.tableId}::uuid
      `;
      expect(count).toBe(4);
    } finally {
      await cleanup(item);
    }
  });

  postgresTest("denied relation and file mutations leave records, links, files, audit, and events unchanged", async () => {
    const item = fixture();
    try {
      await insertFixture(item);
      const created = await create(
        item.tableId,
        { ...createPayload(item, "Linked"), [item.relationFieldId]: [item.targetRecordIds[0]] },
        null,
        "direct",
      );
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.message);
      await updateMutationPolicy(item.tableId, { mode: "selected", sources: ["form"] }, null);

      const [before] = await sql<Array<{ audits: number; events: number; files: number; attachments: number }>>`
        SELECT
          (SELECT count(*)::int FROM grids.audit_log WHERE table_id = ${item.tableId}::uuid) AS audits,
          (SELECT count(*)::int FROM grids.record_event_outbox WHERE table_id = ${item.tableId}::uuid) AS events,
          (SELECT count(*)::int FROM grids.files) AS files,
          (SELECT count(*)::int FROM grids.file_attachments attachment JOIN grids.records record ON record.id = attachment.record_id WHERE record.table_id = ${item.tableId}::uuid) AS attachments
      `;

      const relationDenied = await update(
        item.tableId,
        created.data.id,
        { [item.relationFieldId]: [item.targetRecordIds[1]] },
        null,
        "direct",
      );
      expect(relationDenied.ok).toBe(false);
      const fileDenied = await upload({
        tableId: item.tableId,
        recordId: created.data.id,
        fieldId: item.fileFieldId,
        filename: "evidence.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("must not persist"),
        userId: null,
        origin: "direct",
      });
      expect(fileDenied.ok).toBe(false);

      const [link] = await sql<Array<{ to_record_id: string }>>`
        SELECT to_record_id::text FROM grids.record_links
        WHERE from_record_id = ${created.data.id}::uuid AND from_field_id = ${item.relationFieldId}::uuid
      `;
      expect(link?.to_record_id).toBe(item.targetRecordIds[0]);
      const [after] = await sql<Array<{ audits: number; events: number; files: number; attachments: number }>>`
        SELECT
          (SELECT count(*)::int FROM grids.audit_log WHERE table_id = ${item.tableId}::uuid) AS audits,
          (SELECT count(*)::int FROM grids.record_event_outbox WHERE table_id = ${item.tableId}::uuid) AS events,
          (SELECT count(*)::int FROM grids.files) AS files,
          (SELECT count(*)::int FROM grids.file_attachments attachment JOIN grids.records record ON record.id = attachment.record_id WHERE record.table_id = ${item.tableId}::uuid) AS attachments
      `;
      expect(after).toEqual(before);
    } finally {
      await cleanup(item);
    }
  });

  postgresTest("gates every direct record and attachment lifecycle operation", async () => {
    const item = fixture();
    try {
      await insertFixture(item);
      const created = await create(item.tableId, createPayload(item, "Lifecycle"), null, "direct");
      if (!created.ok) throw created.error;
      const uploaded = await upload({
        tableId: item.tableId,
        recordId: created.data.id,
        fieldId: item.fileFieldId,
        filename: "original.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("original"),
        userId: null,
        origin: "direct",
      });
      if (!uploaded.ok) throw uploaded.error;
      const history = await enableDurableHistory(item.tableId, null);
      if (!history.ok) throw history.error;
      const finalization = await enableFinalization(item.tableId, { mode: "direct" }, null);
      if (!finalization.ok) throw finalization.error;
      const restricted = await updateMutationPolicy(item.tableId, { mode: "selected", sources: ["form"] }, null);
      if (!restricted.ok) throw restricted.error;

      const [before] = await sql<Array<{ audits: number; events: number }>>`
        SELECT
          (SELECT count(*)::int FROM grids.audit_log WHERE table_id = ${item.tableId}::uuid) AS audits,
          (SELECT count(*)::int FROM grids.record_event_outbox WHERE table_id = ${item.tableId}::uuid) AS events
      `;
      if (!before) throw new Error("Mutation lifecycle baseline was not returned");
      expect((await update(item.tableId, created.data.id, createPayload(item, "Denied"), null, "direct")).ok).toBe(false);
      expect((await softDelete(item.tableId, created.data.id, null, "direct")).ok).toBe(false);
      expect((await finalize({ tableId: item.tableId, recordId: created.data.id, actorId: null, origin: "direct" })).ok).toBe(false);
      expect(
        (
          await replaceFile({
            tableId: item.tableId,
            recordId: created.data.id,
            fieldId: item.fileFieldId,
            fileId: uploaded.data.id,
            filename: "replacement.txt",
            mimeType: "text/plain",
            bytes: new TextEncoder().encode("replacement"),
            userId: null,
            origin: "direct",
          })
        ).ok,
      ).toBe(false);
      expect(
        (
          await removeFile({
            tableId: item.tableId,
            recordId: created.data.id,
            fieldId: item.fileFieldId,
            fileId: uploaded.data.id,
            userId: null,
            origin: "direct",
          })
        ).ok,
      ).toBe(false);
      const [after] = await sql<Array<{ audits: number; events: number; attachments: number }>>`
        SELECT
          (SELECT count(*)::int FROM grids.audit_log WHERE table_id = ${item.tableId}::uuid) AS audits,
          (SELECT count(*)::int FROM grids.record_event_outbox WHERE table_id = ${item.tableId}::uuid) AS events,
          (SELECT count(*)::int FROM grids.file_attachments WHERE file_id = ${uploaded.data.id}::uuid) AS attachments
      `;
      expect(after).toEqual({ ...before, attachments: 1 });

      const reopened = await updateMutationPolicy(item.tableId, { mode: "all" }, null);
      if (!reopened.ok) throw reopened.error;
      expect((await softDelete(item.tableId, created.data.id, null, "direct")).ok).toBe(true);
      const blockedRestore = await updateMutationPolicy(item.tableId, { mode: "selected", sources: ["form"] }, null);
      if (!blockedRestore.ok) throw blockedRestore.error;
      expect((await restore(item.tableId, created.data.id, null, "direct")).ok).toBe(false);
      const [deleted] = await sql<Array<{ deleted_at: Date | null }>>`
        SELECT deleted_at FROM grids.records WHERE id = ${created.data.id}::uuid
      `;
      expect(deleted?.deleted_at).toBeTruthy();
    } finally {
      await cleanup(item);
    }
  });

  postgresTest("serializes policy updates and audits an unbroken old-to-new chain", async () => {
    const item = fixture();
    try {
      await insertFixture(item);
      const policies: [TableMutationPolicy, TableMutationPolicy] = [
        { mode: "selected", sources: ["direct"] },
        { mode: "selected", sources: ["workflow"] },
      ];
      const results = await Promise.all(policies.map((policy) => updateMutationPolicy(item.tableId, policy, null)));
      expect(results.every((result) => result.ok)).toBe(true);

      const rows = await sql<Array<{ diff: unknown }>>`
        SELECT diff FROM grids.audit_log
        WHERE table_id = ${item.tableId}::uuid AND action = 'mutation_policy.updated'
      `;
      expect(rows).toHaveLength(2);
      const changes = rows.map((row) => {
        const diff = parseJsonbRow<{ mutationPolicy: { old: TableMutationPolicy; new: TableMutationPolicy } }>(row.diff, {
          mutationPolicy: { old: { mode: "all" }, new: { mode: "all" } },
        });
        return diff.mutationPolicy;
      });
      const first = changes.find((change) => change.old.mode === "all");
      expect(first).toBeDefined();
      const second = changes.find((change) => change !== first);
      expect(second).toBeDefined();
      expect(second?.old).toEqual(first?.new);
      const [stored] = await sql<Array<{ mutation_policy: unknown }>>`
        SELECT mutation_policy FROM grids.tables WHERE id = ${item.tableId}::uuid
      `;
      expect(parseJsonbRow<TableMutationPolicy | null>(stored?.mutation_policy, null)).toEqual(second?.new ?? null);
    } finally {
      await cleanup(item);
    }
  });

  postgresTest("serializes a policy restriction behind an admitted mutation transaction", async () => {
    const item = fixture();
    try {
      await insertFixture(item);
      let signalMutationWritten!: () => void;
      let releaseMutation!: () => void;
      const mutationWritten = new Promise<void>((resolve) => {
        signalMutationWritten = resolve;
      });
      const mutationRelease = new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
      const mutation = sql.begin(async (tx) => {
        const result = await createInTransaction(tx, item.tableId, createPayload(item, "Admitted before restriction"), null, "direct");
        signalMutationWritten();
        await mutationRelease;
        return result;
      });
      await mutationWritten;

      let restrictionSettled = false;
      const restriction = updateMutationPolicy(item.tableId, { mode: "selected", sources: ["form"] }, null).then((result) => {
        restrictionSettled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(restrictionSettled).toBe(false);

      releaseMutation();
      expect((await mutation).ok).toBe(true);
      expect((await restriction).ok).toBe(true);
      expect((await create(item.tableId, createPayload(item, "Denied after restriction"), null, "direct")).ok).toBe(false);
      const [{ count } = { count: 0 }] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${item.tableId}::uuid
      `;
      expect(count).toBe(1);
    } finally {
      await cleanup(item);
    }
  });

  postgresTest("reports only active Form, Workflow, and Action impact with bounded truncation", async () => {
    const item = fixture();
    try {
      await insertFixture(item);
      const forms = [
        { name: "Active one", active: true, deleted: false },
        { name: "Active two", active: true, deleted: false },
        { name: "Active three", active: true, deleted: false },
        { name: "Inactive", active: false, deleted: false },
        { name: "Deleted", active: true, deleted: true },
      ];
      for (let index = 0; index < forms.length; index++) {
        const form = forms[index]!;
        await sql`
          INSERT INTO grids.forms (id, short_id, table_id, name, config, is_active, position, deleted_at)
          VALUES (
            ${testUuid()}::uuid,
            ${testShortId("M")},
            ${item.tableId}::uuid,
            ${form.name},
            ${{ fields: [{ kind: "user_input", fieldId: item.textFieldId }] }}::jsonb,
            ${form.active},
            ${index},
            ${form.deleted ? new Date() : null}
          )
        `;
      }
      const inlineFormShortId = testShortId("M");
      await sql`
        INSERT INTO grids.forms (id, short_id, table_id, name, config, is_active, position)
        VALUES (
          ${testUuid()}::uuid,
          ${inlineFormShortId},
          ${item.tableId}::uuid,
          'Inline target creator',
          ${{
            fields: [
              {
                kind: "user_input",
                fieldId: item.relationFieldId,
                inlineCreate: { enabled: true, fields: [] },
              },
            ],
          }}::jsonb,
          TRUE,
          10
        )
      `;
      const inlineTargetImpact = await getImpact(item.targetTableId, { mode: "selected", sources: ["direct", "workflow"] }, { limit: 100 });
      if (!inlineTargetImpact.ok) throw inlineTargetImpact.error;
      expect(inlineTargetImpact.data.items).toEqual([{ kind: "form", id: inlineFormShortId, name: "Inline target creator" }]);

      const activeWorkflowId = await insertTestWorkflow({
        baseId: item.baseId,
        name: "Active mutation",
        enabled: true,
        plan: mutationPlan(item.tableId),
      });
      await insertTestWorkflow({ baseId: item.baseId, name: "Inactive mutation", enabled: false, plan: mutationPlan(item.tableId) });
      const deletedWorkflowId = await insertTestWorkflow({
        baseId: item.baseId,
        name: "Deleted mutation",
        enabled: true,
        plan: mutationPlan(item.tableId),
      });
      await sql`UPDATE grids.workflow_profile SET deleted_at = now() WHERE id = ${deletedWorkflowId}::uuid`;
      await insertTestWorkflow({ baseId: item.baseId, name: "Read only", enabled: true });

      const launchers = [
        { name: "Valid action", enabled: true, deleted: false, revision: 1, diagnostics: [] },
        { name: "Disabled action", enabled: false, deleted: false, revision: 1, diagnostics: [] },
        { name: "Deleted action", enabled: true, deleted: true, revision: 1, diagnostics: [] },
        { name: "Stale action", enabled: true, deleted: false, revision: 2, diagnostics: [] },
        { name: "Broken action", enabled: true, deleted: false, revision: 1, diagnostics: [{ severity: "error", message: "broken" }] },
      ];
      for (const launcher of launchers) {
        await sql`
          INSERT INTO grids.workflow_launchers (
            id, short_id, base_id, workflow_id, name, kind, config, enabled, validated_revision, diagnostics, deleted_at
          ) VALUES (
            ${testUuid()}::uuid,
            ${testShortId("L")},
            ${item.baseId}::uuid,
            ${activeWorkflowId}::uuid,
            ${launcher.name},
            'customApp',
            '{"kind":"customApp"}'::jsonb,
            ${launcher.enabled},
            ${launcher.revision},
            ${launcher.diagnostics}::jsonb,
            ${launcher.deleted ? new Date() : null}
          )
        `;
      }

      const policy: TableMutationPolicy = { mode: "selected", sources: ["direct"] };
      const full = await getImpact(item.tableId, policy, { limit: 100 });
      expect(full.ok).toBe(true);
      if (!full.ok) throw new Error(full.error.message);
      expect(full.data.total).toBe(6);
      expect(full.data.truncated).toBe(false);
      expect(full.data.complete).toBe(true);
      expect(full.data.items.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
        "form:Active one",
        "form:Active two",
        "form:Active three",
        "form:Inline target creator",
        "workflow:Active mutation",
        "action:Valid action",
      ]);

      const bounded = await getImpact(item.tableId, policy, { limit: 2 });
      expect(bounded.ok).toBe(true);
      if (!bounded.ok) throw new Error(bounded.error.message);
      expect(bounded.data).toMatchObject({ total: 6, limit: 2, truncated: true });
      expect(bounded.data.items).toHaveLength(2);

      const workflowAlreadyBlocked = await updateMutationPolicy(item.tableId, { mode: "selected", sources: ["direct", "form"] }, null);
      if (!workflowAlreadyBlocked.ok) throw workflowAlreadyBlocked.error;
      const newlyAffected = await getImpact(item.tableId, { mode: "selected", sources: ["direct"] }, { limit: 100 });
      if (!newlyAffected.ok) throw newlyAffected.error;
      expect(newlyAffected.data.items.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
        "form:Active one",
        "form:Active two",
        "form:Active three",
        "form:Inline target creator",
      ]);
    } finally {
      await cleanup(item);
    }
  });
});
