/**
 * The declared Grids actions, driven the way the runtime drives them.
 *
 * Nothing here is checkable by the type system. An action names a field with
 * `ctx.binding`, writes through a service that speaks SQL, and leaves its
 * evidence in `workflows.step_outcome` — three couplings that live in string
 * keys and SQL template literals, and every one of them fails silently. So the
 * plan, the run and the grants are real, the run is carried by the worker's own
 * ports, and the assertions are about rows.
 */
import { beforeAll, describe, expect } from "bun:test";
import type { WorkflowBoundPlan, WorkflowIrStep, WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import { hashWorkflowJson } from "@valentinkolb/cloud/workflows/language";
import { createWorkflowRun } from "@valentinkolb/cloud/workflows/store";
import { sql } from "bun";
import { postgresTest, testShortId as shortId, testUuid as uuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import type { GridsWorkflowPrincipal } from "../workflows/contracts";
import { gridsWorkflows } from "../workflows/module";
import { enable as enableDurableHistory, listRecordRevisions } from "./durable-history";
import { update as updateMutationPolicy } from "./mutation-policy";
import { provisionFieldNumberSeries } from "./number-series";
import {
  disable as disableFinalization,
  enable as enableFinalization,
  finalize as finalizeRecord,
  setPolicy as setFinalizationPolicy,
} from "./record-finalization";
import { listReferencedBy } from "./referenced-by";
import { invokeRecordLauncher } from "./workflow-launcher-invocations";
import { createLauncher } from "./workflow-launchers";
import { getWorkflow } from "./workflow-read";
import { GRIDS_APP_ID, gridsAuthorizationSnapshot } from "./workflow-runs";
import { dryRunGridsWorkflowRun, runGridsWorkflowRun } from "./workflow-runtime";
import { deleteTestWorkflowScope, insertTestWorkflow, publishTestWorkflowVersion } from "./workflow-test-fixture";

type Fixture = {
  actorId: string;
  baseId: string;
  tableId: string;
  assetIdFieldId: string;
  nameFieldId: string;
  statusFieldId: string;
  jsonFieldId: string;
  correctionTypeFieldId: string;
  originalRelationFieldId: string;
  recordId: string;
  emailTemplateId: string;
  documentTemplateId: string;
  workflowId: string;
};

const createFixture = (): Fixture => ({
  actorId: uuid(),
  baseId: uuid(),
  tableId: uuid(),
  assetIdFieldId: uuid(),
  nameFieldId: uuid(),
  statusFieldId: uuid(),
  jsonFieldId: uuid(),
  correctionTypeFieldId: uuid(),
  originalRelationFieldId: uuid(),
  recordId: uuid(),
  emailTemplateId: uuid(),
  documentTemplateId: uuid(),
  workflowId: uuid(),
});

const insertFixture = async (fixture: Fixture): Promise<void> => {
  await sql`
    INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
    VALUES (${fixture.actorId}::uuid, ${`workflow-action-${fixture.actorId}`}, 'local', 'user', 'Workflow Actor', 'Workflow', 'Actor')
  `;
  await sql`
    INSERT INTO grids.bases (id, short_id, name, created_by)
    VALUES (${fixture.baseId}::uuid, ${shortId("B")}, 'Workflow actions integration', ${fixture.actorId}::uuid)
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES (${fixture.tableId}::uuid, ${shortId("T")}, ${fixture.baseId}::uuid, 'Tasks', 0)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
    VALUES
      (${fixture.assetIdFieldId}::uuid, ${shortId("F")}, ${fixture.tableId}::uuid, 'Asset ID', 'id', '{"strategy":"sequence","prefix":"ITEM-","padding":4}'::jsonb, 0),
      (${fixture.nameFieldId}::uuid, ${shortId("F")}, ${fixture.tableId}::uuid, 'Name', 'text', '{}'::jsonb, 1),
      (${fixture.statusFieldId}::uuid, ${shortId("F")}, ${fixture.tableId}::uuid, 'Status', 'text', '{}'::jsonb, 2),
      (${fixture.jsonFieldId}::uuid, ${shortId("F")}, ${fixture.tableId}::uuid, 'Metadata', 'json', '{}'::jsonb, 3),
      (${fixture.correctionTypeFieldId}::uuid, ${shortId("F")}, ${fixture.tableId}::uuid, 'Document type', 'select',
        ${{
          options: [
            { id: "original", label: "Original" },
            { id: "correction", label: "Correction" },
            { id: "cancellation", label: "Cancellation" },
          ],
        }}::jsonb, 4),
      (${fixture.originalRelationFieldId}::uuid, ${shortId("F")}, ${fixture.tableId}::uuid, 'Corrects', 'relation',
        ${{ targetTableId: fixture.tableId, cardinality: "single" }}::jsonb, 5)
  `;
  await provisionFieldNumberSeries(sql, fixture.assetIdFieldId, { strategy: "sequence", prefix: "ITEM-", padding: 4 });
  await sql`
    INSERT INTO grids.records (id, short_id, table_id, data, created_by, updated_by)
    VALUES (
      ${fixture.recordId}::uuid,
      ${shortId("R")},
      ${fixture.tableId}::uuid,
      ${{
        [fixture.assetIdFieldId]: "ITEM-0001",
        [fixture.nameFieldId]: "Draft task",
        [fixture.statusFieldId]: "Open",
        [fixture.jsonFieldId]: "123",
      }}::jsonb,
      ${fixture.actorId}::uuid,
      ${fixture.actorId}::uuid
    )
  `;
  await sql`
    INSERT INTO grids.email_templates (id, short_id, base_id, name, subject, html, created_by, updated_by)
    VALUES (
      ${fixture.emailTemplateId}::uuid, ${shortId("E")}, ${fixture.baseId}::uuid, 'Task notice',
      'Task update', '<p>A task changed.</p>', ${fixture.actorId}::uuid, ${fixture.actorId}::uuid
    )
  `;
  await sql`
    INSERT INTO grids.document_templates (
      id, short_id, table_id, name, source, renderer_kind, html, number_template, filename_template, created_by, updated_by
    )
    VALUES (
      ${fixture.documentTemplateId}::uuid, ${shortId("D")}, ${fixture.tableId}::uuid, 'Task sheet',
      ${`from table {${fixture.tableId}} limit 1`}, 'html', '<p>Task</p>', 'TASK-{{ document.id }}', '{{ document.number }}.pdf',
      ${fixture.actorId}::uuid, ${fixture.actorId}::uuid
    )
  `;
  // Without this the actions are all correct to refuse, and every assertion
  // below would pass for the wrong reason.
  const [access] = await sql<Array<{ id: string }>>`
    INSERT INTO auth.access (user_id, permission) VALUES (${fixture.actorId}::uuid, 'write') RETURNING id::text AS id
  `;
  if (!access) throw new Error("Workflow action fixture could not grant base access");
  await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${fixture.baseId}::uuid, ${access.id}::uuid)`;
  await insertTestWorkflow({
    id: fixture.workflowId,
    shortId: shortId("W"),
    baseId: fixture.baseId,
    name: "Task workflow",
    source: "steps: []",
    enabled: true,
    ownerUserId: fixture.actorId,
  });
};

const cleanupFixture = async (fixture: Fixture): Promise<void> => {
  await sql`
    UPDATE grids.records SET finalized_at = NULL, finalized_by = NULL, final_revision_id = NULL
    WHERE table_id = ${fixture.tableId}::uuid
  `;
  await sql`DELETE FROM grids.record_revisions WHERE table_id = ${fixture.tableId}::uuid`;
  await sql`DELETE FROM grids.record_finalization_requests WHERE table_id = ${fixture.tableId}::uuid`;
  await sql`DELETE FROM grids.table_finalization_activations WHERE table_id = ${fixture.tableId}::uuid`;
  await sql`DELETE FROM grids.durable_history_activations WHERE table_id = ${fixture.tableId}::uuid`;
  await sql`DELETE FROM grids.table_schema_revisions WHERE table_id = ${fixture.tableId}::uuid`;
  await sql`DELETE FROM grids.audit_log WHERE base_id = ${fixture.baseId}::uuid`;
  await deleteTestWorkflowScope(fixture.baseId);
  await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
  await sql`DELETE FROM workflows.workflow WHERE id = ${fixture.workflowId}::uuid`;
  await sql`DELETE FROM auth.access WHERE user_id = ${fixture.actorId}::uuid`;
  await sql`DELETE FROM auth.users WHERE id = ${fixture.actorId}::uuid`;
};

const hash = (seed: string): string => new Bun.CryptoHasher("sha256").update(seed).digest("hex");

/**
 * The policies the compiler would bind, derived from the declarations rather
 * than restated — a plan whose policy disagrees with the action's effect class
 * would test a runtime nobody ships.
 */
const ACTION_POLICIES = Object.fromEntries(
  gridsWorkflows.manifest.actions.map((descriptor) => [descriptor.kind, { effect: descriptor.effect, dryRun: descriptor.dryRun }]),
);
const CURRENT_MANIFEST_HASH = await hashWorkflowJson(gridsWorkflows.manifest);

const actionStep = (index: number, action: string, config: Record<string, WorkflowJsonValue>): WorkflowIrStep => ({
  kind: "action",
  action,
  config,
  sourcePath: ["steps", index],
});

const boundPlan = (steps: WorkflowIrStep[], bindings: Record<string, WorkflowJsonValue>): WorkflowBoundPlan => ({
  schemaVersion: 2,
  languageId: "grids",
  languageVersion: 1,
  sourceHash: hash("workflow-actions-integration"),
  manifestHash: CURRENT_MANIFEST_HASH,
  catalogHash: hash("workflow-actions-catalog"),
  actionPolicies: ACTION_POLICIES,
  inputs: [],
  triggers: [],
  steps,
  bindings,
});

type QueuedRun = {
  plan: WorkflowBoundPlan;
  mode?: "execute" | "dryRun";
  inputs?: Record<string, WorkflowJsonValue>;
};

/**
 * A run exactly as `startWorkflowRun` leaves one, ready to claim.
 *
 * Two rows, because that is what a Grids run is now: the kernel's, pinned to a
 * published version so the plan cannot drift under it, and the profile that
 * says which base and which button it belongs to. The authorization snapshot is
 * built by the same helper the service uses — every declared action reads its
 * actor back out of it.
 */
const queueRun = async (fixture: Fixture, input: QueuedRun): Promise<string> => {
  const revision = await publishTestWorkflowVersion(fixture.workflowId, `steps: [] # ${uuid()}`, input.plan);
  const [version] = await sql<Array<{ id: string }>>`
    SELECT id::text AS id FROM workflows.version
    WHERE workflow_id = ${fixture.workflowId}::uuid AND revision = ${revision}
  `;
  if (!version) throw new Error("Workflow action fixture could not publish a version");

  const principal: GridsWorkflowPrincipal = { userId: fixture.actorId, groupIds: [], serviceAccountId: null };
  const runId = await createWorkflowRun({
    appId: GRIDS_APP_ID,
    scopeId: fixture.baseId,
    workflowId: fixture.workflowId,
    workflowVersionId: version.id,
    mode: input.mode ?? "execute",
    inputs: input.inputs ?? {},
    context: {},
    authorization: gridsAuthorizationSnapshot(principal, { kind: "workflow" }, null) as unknown as WorkflowJsonValue,
    idempotencyKey: uuid(),
    occurredAt: new Date(),
  });
  await sql`
    INSERT INTO grids.workflow_run_profile (run_id, short_id, base_id, workflow_id, channel, actor_user_id, request_fingerprint)
    VALUES (
      ${runId}::uuid, ${shortId("R")}, ${fixture.baseId}::uuid, ${fixture.workflowId}::uuid,
      'api', ${fixture.actorId}::uuid, ${runId}
    )
  `;
  return runId;
};

/**
 * Carries one run to its outcome and answers with the state it settled in.
 *
 * The same two entry points the worker drives, so an action that only works
 * under a port this test invented would fail here rather than in production.
 */
const drive = async (runId: string, mode: "execute" | "dryRun" = "execute"): Promise<string> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const outcome = mode === "execute" ? await runGridsWorkflowRun(runId) : await dryRunGridsWorkflowRun(runId);
    if (outcome.state === "finished") return (await runRow(runId)).state;

    const state = (await runRow(runId)).state;
    if (["succeeded", "failed", "canceled", "needs_attention"].includes(state)) return state;
    if (outcome.state !== "idle") throw new Error(`Workflow run ${runId} did not finish: ${outcome.state}`);
    await Bun.sleep(10);
  }
  throw new Error(`Workflow run ${runId} did not reach a terminal state`);
};

const recordData = async (recordId: string): Promise<Record<string, unknown>> => {
  const [row] = await sql<Array<{ data: Record<string, unknown> }>>`
    SELECT data FROM grids.records WHERE id = ${recordId}::uuid
  `;
  if (!row) throw new Error(`Record ${recordId} is missing`);
  return row.data;
};

type StepRow = {
  step_key: string;
  state: string;
  outcome: { state?: string; output?: WorkflowJsonValue; error?: { code?: string } } | null;
  effect_state: string | null;
  effect_output: WorkflowJsonValue;
};

// The journal stores the pair the executor hands it, so that a restored step
// knows which of the two outcome shapes it has. Every assertion below is about
// the outcome itself, which is also what a run view is given.
const stepRuns = (runId: string): Promise<StepRow[]> => sql<StepRow[]>`
  SELECT step_key, state, outcome -> 'outcome' AS outcome, effect_state, effect_output
  FROM workflows.step_outcome
  WHERE run_id = ${runId}::uuid
  ORDER BY step_key
`;

const runRow = async (
  runId: string,
): Promise<{
  state: string;
  result: WorkflowJsonValue;
  error: { code?: string; message?: string } | null;
}> => {
  const [row] = await sql<Array<{ state: string; result: WorkflowJsonValue; error: { code?: string; message?: string } | null }>>`
    SELECT state, result, error FROM workflows.run WHERE id = ${runId}::uuid
  `;
  if (!row) throw new Error(`Workflow run ${runId} is missing`);
  return row;
};

/** Re-opens a finished run and its steps the way a crash-resumed attempt finds them. */
const reopenForReplay = async (runId: string): Promise<void> => {
  await sql`
    UPDATE workflows.run
    SET state = 'queued', result = NULL, error = NULL, result_message = NULL, finished_at = NULL,
        lease_owner = NULL, lease_expires_at = NULL, retry_after = NULL
    WHERE id = ${runId}::uuid
  `;
  // The effect columns stay: the journal's record of what already happened is
  // precisely what the replay has to consult instead of acting again.
  await sql`
    UPDATE workflows.step_outcome
    SET state = 'running', outcome = NULL, finished_at = NULL
    WHERE run_id = ${runId}::uuid
  `;
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("declared Grids workflow actions", () => {
  postgresTest("kernel builtin actions are wired into the Grids worker", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const executeRunId = await queueRun(fixture, {
        plan: boundPlan([actionStep(0, "succeed", { message: "Item returned" })], {}),
      });
      const dryRunId = await queueRun(fixture, {
        mode: "dryRun",
        plan: boundPlan([actionStep(0, "succeed", { message: "Item would be returned" })], {}),
      });

      expect(await drive(executeRunId)).toBe("succeeded");
      expect(await drive(dryRunId, "dryRun")).toBe("succeeded");
      expect((await runRow(executeRunId)).result).toBeNull();
      expect((await runRow(dryRunId)).result).toEqual({ effects: [] });
      expect((await stepRuns(executeRunId))[0]).toMatchObject({ state: "terminal" });
      expect((await stepRuns(dryRunId))[0]).toMatchObject({ state: "terminal" });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("updateRecord writes under the bound field id and journals the effect it committed", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const activated = await enableDurableHistory(fixture.tableId, fixture.actorId);
      expect(activated.ok).toBe(true);
      const runId = await queueRun(fixture, {
        plan: boundPlan([actionStep(0, "updateRecord", { record: "inputs.record", set: { Status: "Approved" } })], {
          "steps.0.updateRecord.set.Status": fixture.statusFieldId,
        }),
        inputs: { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });

      expect(await drive(runId)).toBe("succeeded");

      const data = await recordData(fixture.recordId);
      expect(data[fixture.statusFieldId]).toBe("Approved");
      // The source wrote "Status"; publishing froze which field that was. A
      // value stored under the written name would be invisible to every reader.
      expect(data.Status).toBeUndefined();
      expect(data[fixture.assetIdFieldId]).toBe("ITEM-0001");
      expect(data[fixture.nameFieldId]).toBe("Draft task");
      const revisions = await listRecordRevisions({ tableId: fixture.tableId, recordId: fixture.recordId });
      expect(revisions.ok && revisions.data.items.map((revision) => revision.action)).toEqual(["updated", "baseline"]);

      const [step] = await stepRuns(runId);
      expect(step).toMatchObject({ step_key: "steps.0", state: "completed", effect_state: "succeeded" });
      expect(step?.effect_output).toEqual({ kind: "record", tableId: fixture.tableId, recordId: fixture.recordId });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("Record update workflows keep normalized no-ops free of Record side effects", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const activated = await enableDurableHistory(fixture.tableId, fixture.actorId);
      expect(activated.ok).toBe(true);
      const recordInput = { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } };
      const updateRunId = await queueRun(fixture, {
        plan: boundPlan([actionStep(0, "updateRecord", { record: "inputs.record", set: { Status: "Open" } })], {
          "steps.0.updateRecord.set.Status": fixture.statusFieldId,
        }),
        inputs: recordInput,
      });
      const atomicRunId = await queueRun(fixture, {
        plan: boundPlan(
          [
            actionStep(0, "atomicRecords", {
              locks: ["inputs.record"],
              checks: [],
              changes: [{ updateRecord: { record: "inputs.record", set: { Status: "Open" }, ifVersion: 1 } }],
            }),
          ],
          { "steps.0.atomicRecords.changes.0.updateRecord.set.Status.$target": fixture.statusFieldId },
        ),
        inputs: recordInput,
      });

      expect(await drive(updateRunId)).toBe("succeeded");
      expect(await drive(atomicRunId)).toBe("succeeded");

      const [state] = await sql<Array<{ version: number; revisions: number; audits: number; events: number }>>`
        SELECT
          record.version,
          (SELECT count(*)::int FROM grids.record_revisions WHERE record_id = record.id) AS revisions,
          (
            SELECT count(*)::int FROM grids.audit_log
            WHERE record_id = record.id AND action IN ('updated', 'workflow.record.updated')
          ) AS audits,
          (SELECT count(*)::int FROM grids.record_event_outbox WHERE record_id = record.id) AS events
        FROM grids.records record
        WHERE record.id = ${fixture.recordId}::uuid
      `;
      expect(state).toEqual({ version: 1, revisions: 1, audits: 0, events: 0 });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("workflow actions obey the table mutation policy at execution time", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const runId = await queueRun(fixture, {
        plan: boundPlan([actionStep(0, "updateRecord", { record: "inputs.record", set: { Status: "Approved" } })], {
          "steps.0.updateRecord.set.Status": fixture.statusFieldId,
        }),
        inputs: { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });
      const policy = await updateMutationPolicy(fixture.tableId, { mode: "selected", sources: ["direct", "form"] }, fixture.actorId);
      if (!policy.ok) throw policy.error;

      expect(await drive(runId)).toBe("failed");
      expect((await runRow(runId)).error).toMatchObject({ code: "FORBIDDEN" });
      expect((await recordData(fixture.recordId))[fixture.statusFieldId]).toBe("Open");
      expect((await stepRuns(runId))[0]).toMatchObject({ state: "failed", effect_state: null });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("finalizeRecord is permission-checked, atomic, and idempotent when a workflow step is replayed", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const history = await enableDurableHistory(fixture.tableId, fixture.actorId);
      if (!history.ok) throw history.error;
      const activation = await enableFinalization(fixture.tableId, { mode: "direct" }, fixture.actorId);
      if (!activation.ok) throw activation.error;
      const runId = await queueRun(fixture, {
        plan: boundPlan([actionStep(0, "finalizeRecord", { record: "inputs.record" })], {}),
        inputs: { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });

      expect(await drive(runId)).toBe("succeeded");
      await reopenForReplay(runId);
      expect(await drive(runId)).toBe("succeeded");
      const [record] = await sql<Array<{ finalized_at: Date | null; version: number }>>`
        SELECT finalized_at, version FROM grids.records WHERE id = ${fixture.recordId}::uuid
      `;
      expect(record?.finalized_at).toBeTruthy();
      expect(record?.version).toBe(2);
      const revisions = await listRecordRevisions({ tableId: fixture.tableId, recordId: fixture.recordId });
      expect(revisions.ok && revisions.data.items.filter((revision) => revision.action === "finalized")).toHaveLength(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("finalizeRecord cannot bypass a Table's Four-eyes policy", async () => {
    const fixture = createFixture();
    const groupId = uuid();
    try {
      await insertFixture(fixture);
      await sql`INSERT INTO auth.groups (id, cn, provider, name) VALUES (${groupId}::uuid, ${`workflow-approvers-${groupId}`}, 'local', 'Workflow approvers')`;
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${fixture.actorId}::uuid, ${groupId}::uuid)`;
      const history = await enableDurableHistory(fixture.tableId, fixture.actorId);
      if (!history.ok) throw history.error;
      const activation = await enableFinalization(fixture.tableId, { mode: "direct" }, fixture.actorId);
      if (!activation.ok) throw activation.error;
      const policy = await setFinalizationPolicy(fixture.tableId, { mode: "fourEyes", approverGroupId: groupId }, fixture.actorId);
      if (!policy.ok) throw policy.error;
      const runId = await queueRun(fixture, {
        plan: boundPlan([actionStep(0, "finalizeRecord", { record: "inputs.record" })], {}),
        inputs: { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });

      expect(await drive(runId)).toBe("failed");
      const [record] = await sql<Array<{ finalized_at: Date | null }>>`
        SELECT finalized_at FROM grids.records WHERE id = ${fixture.recordId}::uuid
      `;
      expect(record?.finalized_at).toBeNull();
      expect((await runRow(runId)).error).toMatchObject({ code: "CONFLICT" });
    } finally {
      await cleanupFixture(fixture);
      await sql`DELETE FROM auth.user_groups_v2 WHERE group_id = ${groupId}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    }
  });

  postgresTest("closeRecord follows the Table's Direct Finalization mode", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const history = await enableDurableHistory(fixture.tableId, fixture.actorId);
      if (!history.ok) throw history.error;
      const activation = await enableFinalization(fixture.tableId, { mode: "direct" }, fixture.actorId);
      if (!activation.ok) throw activation.error;
      const runId = await queueRun(fixture, {
        plan: boundPlan([actionStep(0, "closeRecord", { record: "inputs.record" })], {}),
        inputs: { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });

      expect(await drive(runId)).toBe("succeeded");
      const [record] = await sql<Array<{ finalized_at: Date | null }>>`
        SELECT finalized_at FROM grids.records WHERE id = ${fixture.recordId}::uuid
      `;
      expect(record?.finalized_at).toBeTruthy();
      const [request] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.record_finalization_requests WHERE record_id = ${fixture.recordId}::uuid
      `;
      expect(request?.count).toBe(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("closeRecord requests approval in Four-eyes mode without finalizing", async () => {
    const fixture = createFixture();
    const groupId = uuid();
    try {
      await insertFixture(fixture);
      await sql`INSERT INTO auth.groups (id, cn, provider, name) VALUES (${groupId}::uuid, ${`close-approvers-${groupId}`}, 'local', 'Close approvers')`;
      const history = await enableDurableHistory(fixture.tableId, fixture.actorId);
      if (!history.ok) throw history.error;
      const activation = await enableFinalization(fixture.tableId, { mode: "fourEyes", approverGroupId: groupId }, fixture.actorId);
      if (!activation.ok) throw activation.error;
      const runId = await queueRun(fixture, {
        plan: boundPlan([actionStep(0, "closeRecord", { record: "inputs.record" })], {}),
        inputs: { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });

      expect(await drive(runId)).toBe("succeeded");
      const [record] = await sql<Array<{ finalized_at: Date | null }>>`
        SELECT finalized_at FROM grids.records WHERE id = ${fixture.recordId}::uuid
      `;
      expect(record?.finalized_at).toBeNull();
      const [request] = await sql<Array<{ status: string; requested_by: string }>>`
        SELECT status, requested_by::text
        FROM grids.record_finalization_requests
        WHERE record_id = ${fixture.recordId}::uuid
      `;
      expect(request).toEqual({ status: "pending", requested_by: fixture.actorId });

      await reopenForReplay(runId);
      expect(await drive(runId)).toBe("succeeded");
      const [requestCount] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.record_finalization_requests WHERE record_id = ${fixture.recordId}::uuid
      `;
      expect(requestCount?.count).toBe(1);
    } finally {
      await cleanupFixture(fixture);
      await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    }
  });

  postgresTest("createCorrectionDraft creates one linked editable Record and replays without duplication", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const history = await enableDurableHistory(fixture.tableId, fixture.actorId);
      if (!history.ok) throw history.error;
      const activation = await enableFinalization(fixture.tableId, { mode: "direct" }, fixture.actorId);
      if (!activation.ok) throw activation.error;
      await sql`
        UPDATE grids.fields SET default_value = ${JSON.stringify("New")}::jsonb
        WHERE id = ${fixture.statusFieldId}::uuid
      `;
      await sql`
        UPDATE grids.records SET data = data - ${fixture.statusFieldId}
        WHERE id = ${fixture.recordId}::uuid
      `;
      const finalized = await finalizeRecord({
        tableId: fixture.tableId,
        recordId: fixture.recordId,
        actorId: fixture.actorId,
        origin: "direct",
      });
      if (!finalized.ok) throw finalized.error;
      await sql`
        UPDATE grids.number_series SET baseline_floor = 1
        WHERE field_id = ${fixture.assetIdFieldId}::uuid
      `;

      const runId = await queueRun(fixture, {
        plan: boundPlan(
          [
            actionStep(0, "createCorrectionDraft", {
              original: "inputs.original",
              typeField: "Document type",
              typeValue: "correction",
              originalField: "Corrects",
              copyFields: ["Name", "Status", "Metadata"],
            }),
          ],
          {
            "steps.0.createCorrectionDraft.typeField": fixture.correctionTypeFieldId,
            "steps.0.createCorrectionDraft.originalField": fixture.originalRelationFieldId,
            "steps.0.createCorrectionDraft.copyFields.0": fixture.nameFieldId,
            "steps.0.createCorrectionDraft.copyFields.1": fixture.statusFieldId,
            "steps.0.createCorrectionDraft.copyFields.2": fixture.jsonFieldId,
          },
        ),
        inputs: { original: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });

      expect(await drive(runId)).toBe("succeeded");
      const result = (await runRow(runId)).result as { kind: string; tableId: string; recordId: string };
      expect(result).toMatchObject({ kind: "record", tableId: fixture.tableId });
      expect(result.recordId).not.toBe(fixture.recordId);
      const [draft] = await sql<Array<{ data: Record<string, unknown>; finalized_at: Date | null }>>`
        SELECT data, finalized_at FROM grids.records WHERE id = ${result.recordId}::uuid
      `;
      expect(draft?.finalized_at).toBeNull();
      expect(draft?.data[fixture.correctionTypeFieldId]).toEqual(["correction"]);
      expect(draft?.data[fixture.nameFieldId]).toBe("Draft task");
      expect(draft?.data).not.toHaveProperty(fixture.statusFieldId);
      expect(draft?.data[fixture.jsonFieldId]).toBe("123");
      expect(typeof draft?.data[fixture.jsonFieldId]).toBe("string");
      expect(draft?.data[fixture.assetIdFieldId]).toBe("ITEM-0002");
      const [link] = await sql<Array<{ target: string }>>`
        SELECT to_record_id::text AS target
        FROM grids.record_links
        WHERE from_record_id = ${result.recordId}::uuid AND from_field_id = ${fixture.originalRelationFieldId}::uuid
      `;
      expect(link?.target).toBe(fixture.recordId);
      const createdRevisions = await listRecordRevisions({ tableId: fixture.tableId, recordId: result.recordId });
      expect(createdRevisions.ok).toBe(true);
      if (!createdRevisions.ok) throw createdRevisions.error;
      expect(createdRevisions.data.items).toHaveLength(1);
      expect(createdRevisions.data.items[0]).toMatchObject({
        action: "created",
        data: expect.objectContaining({
          [fixture.correctionTypeFieldId]: ["correction"],
          [fixture.nameFieldId]: "Draft task",
          [fixture.jsonFieldId]: "123",
        }),
        relations: { [fixture.originalRelationFieldId]: [fixture.recordId] },
      });
      const referencedBy = await listReferencedBy({
        targetTableId: fixture.tableId,
        targetRecordId: fixture.recordId,
        cursorSigningKey: "workflow-actions-correction-test",
      });
      expect(referencedBy.ok).toBe(true);
      if (!referencedBy.ok) throw referencedBy.error;
      expect(referencedBy.data.items).toEqual([
        expect.objectContaining({ sourceRecordId: result.recordId, relationFieldId: fixture.originalRelationFieldId }),
      ]);
      const [documentsBeforeFinalization] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.documents WHERE record_id = ${result.recordId}::uuid
      `;
      expect(documentsBeforeFinalization?.count).toBe(0);

      const finalizedDraft = await finalizeRecord({
        tableId: fixture.tableId,
        recordId: result.recordId,
        actorId: fixture.actorId,
        origin: "direct",
      });
      if (!finalizedDraft.ok) throw finalizedDraft.error;
      expect(finalizedDraft.data.finalizedAt).toBeTruthy();
      expect(finalizedDraft.data.data[fixture.assetIdFieldId]).toBe("ITEM-0002");
      const finalRevisions = await listRecordRevisions({ tableId: fixture.tableId, recordId: result.recordId });
      expect(finalRevisions.ok).toBe(true);
      if (!finalRevisions.ok) throw finalRevisions.error;
      expect(finalRevisions.data.items.map((revision) => revision.action)).toEqual(["finalized", "created"]);
      const [documentsAfterFinalization] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.documents WHERE record_id = ${result.recordId}::uuid
      `;
      expect(documentsAfterFinalization?.count).toBe(0);

      await reopenForReplay(runId);
      expect(await drive(runId)).toBe("succeeded");
      expect((await runRow(runId)).result).toEqual(result);
      const [count] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${fixture.tableId}::uuid
      `;
      expect(count?.count).toBe(2);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("Record launcher carries its scoped Record and cancellation intent into the linked-Draft workflow", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const history = await enableDurableHistory(fixture.tableId, fixture.actorId);
      if (!history.ok) throw history.error;
      const activation = await enableFinalization(fixture.tableId, { mode: "direct" }, fixture.actorId);
      if (!activation.ok) throw activation.error;
      const finalized = await finalizeRecord({
        tableId: fixture.tableId,
        recordId: fixture.recordId,
        actorId: fixture.actorId,
        origin: "direct",
      });
      if (!finalized.ok) throw finalized.error;

      const plan = boundPlan(
        [
          actionStep(0, "createCorrectionDraft", {
            original: "inputs.original",
            intent: "cancellation",
            typeField: "Document type",
            typeValue: "cancellation",
            originalField: "Corrects",
          }),
        ],
        {
          "inputs.original.table": fixture.tableId,
          "steps.0.createCorrectionDraft.typeField": fixture.correctionTypeFieldId,
          "steps.0.createCorrectionDraft.originalField": fixture.originalRelationFieldId,
        },
      );
      plan.inputs = [{ name: "original", type: "record", config: { table: "Tasks", required: true } }];
      const dryRunId = await queueRun(fixture, {
        mode: "dryRun",
        plan,
        inputs: { original: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });
      expect(await drive(dryRunId, "dryRun")).toBe("succeeded");
      const [plannedStep] = await stepRuns(dryRunId);
      expect(JSON.stringify(plannedStep?.outcome)).toContain("Create one linked follow-up Draft");
      expect(JSON.stringify(plannedStep?.outcome)).not.toContain("Create one correction Draft");

      await publishTestWorkflowVersion(fixture.workflowId, "steps: [] # cancellation launcher", plan);
      const workflow = await getWorkflow(fixture.workflowId);
      if (!workflow) throw new Error("Correction launcher workflow is missing");
      const launcher = await createLauncher(
        workflow,
        {
          name: "Create cancellation",
          config: { kind: "record", input: "original", profile: "correctionDraft", intent: "cancellation" },
          enabled: true,
        },
        fixture.actorId,
      );
      if (!launcher.ok) throw launcher.error;

      const invoked = await invokeRecordLauncher({
        launcherId: launcher.data.id,
        operationId: uuid(),
        mode: "execute",
        expectedRevision: workflow.revision,
        principal: {
          userId: fixture.actorId,
          groupIds: [],
          serviceAccountId: null,
          actorServiceAccountId: null,
          credential: null,
        },
        inputs: {},
        recordId: fixture.recordId,
      });
      if (!invoked.ok) throw invoked.error;

      expect(await drive(invoked.data.runId)).toBe("succeeded");
      const [count] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${fixture.tableId}::uuid
      `;
      expect(count?.count).toBe(2);
      const result = (await runRow(invoked.data.runId)).result as { recordId: string };
      expect((await recordData(result.recordId))[fixture.correctionTypeFieldId]).toEqual(["cancellation"]);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("createCorrectionDraft rejects prefill schema drift without a partial Draft", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const history = await enableDurableHistory(fixture.tableId, fixture.actorId);
      if (!history.ok) throw history.error;
      const activation = await enableFinalization(fixture.tableId, { mode: "direct" }, fixture.actorId);
      if (!activation.ok) throw activation.error;
      const finalized = await finalizeRecord({
        tableId: fixture.tableId,
        recordId: fixture.recordId,
        actorId: fixture.actorId,
        origin: "direct",
      });
      if (!finalized.ok) throw finalized.error;
      await sql`
        UPDATE grids.fields SET type = 'formula', config = ${{ expression: "1" }}::jsonb
        WHERE id = ${fixture.nameFieldId}::uuid
      `;
      const runId = await queueRun(fixture, {
        plan: boundPlan(
          [
            actionStep(0, "createCorrectionDraft", {
              original: "inputs.original",
              typeField: "Document type",
              typeValue: "correction",
              originalField: "Corrects",
              copyFields: ["Name"],
            }),
          ],
          {
            "steps.0.createCorrectionDraft.typeField": fixture.correctionTypeFieldId,
            "steps.0.createCorrectionDraft.originalField": fixture.originalRelationFieldId,
            "steps.0.createCorrectionDraft.copyFields.0": fixture.nameFieldId,
          },
        ),
        inputs: { original: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });

      expect(await drive(runId)).toBe("failed");
      expect((await runRow(runId)).error).toMatchObject({ code: "WORKFLOW_BINDING_INVALID" });
      const [count] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${fixture.tableId}::uuid
      `;
      expect(count?.count).toBe(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("createCorrectionDraft rejects a unique prefill field before creating a Draft", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const history = await enableDurableHistory(fixture.tableId, fixture.actorId);
      if (!history.ok) throw history.error;
      const activation = await enableFinalization(fixture.tableId, { mode: "direct" }, fixture.actorId);
      if (!activation.ok) throw activation.error;
      const finalized = await finalizeRecord({
        tableId: fixture.tableId,
        recordId: fixture.recordId,
        actorId: fixture.actorId,
        origin: "direct",
      });
      if (!finalized.ok) throw finalized.error;
      await sql`UPDATE grids.fields SET unique_constraint = TRUE WHERE id = ${fixture.nameFieldId}::uuid`;
      const runId = await queueRun(fixture, {
        plan: boundPlan(
          [
            actionStep(0, "createCorrectionDraft", {
              original: "inputs.original",
              typeField: "Document type",
              typeValue: "correction",
              originalField: "Corrects",
              copyFields: ["Name"],
            }),
          ],
          {
            "steps.0.createCorrectionDraft.typeField": fixture.correctionTypeFieldId,
            "steps.0.createCorrectionDraft.originalField": fixture.originalRelationFieldId,
            "steps.0.createCorrectionDraft.copyFields.0": fixture.nameFieldId,
          },
        ),
        inputs: { original: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });

      expect(await drive(runId)).toBe("failed");
      expect((await runRow(runId)).error).toMatchObject({ code: "WORKFLOW_BINDING_INVALID" });
      const [count] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${fixture.tableId}::uuid
      `;
      expect(count?.count).toBe(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("createCorrectionDraft refuses an editable original without creating a Record", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const runId = await queueRun(fixture, {
        plan: boundPlan(
          [
            actionStep(0, "createCorrectionDraft", {
              original: "inputs.original",
              typeField: "Document type",
              typeValue: "correction",
              originalField: "Corrects",
            }),
          ],
          {
            "steps.0.createCorrectionDraft.typeField": fixture.correctionTypeFieldId,
            "steps.0.createCorrectionDraft.originalField": fixture.originalRelationFieldId,
          },
        ),
        inputs: { original: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });

      expect(await drive(runId)).toBe("failed");
      expect((await runRow(runId)).error).toMatchObject({ code: "CONFLICT" });
      const [count] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${fixture.tableId}::uuid
      `;
      expect(count?.count).toBe(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("createCorrectionDraft obeys the workflow mutation policy in execution and dry run", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const history = await enableDurableHistory(fixture.tableId, fixture.actorId);
      if (!history.ok) throw history.error;
      const activation = await enableFinalization(fixture.tableId, { mode: "direct" }, fixture.actorId);
      if (!activation.ok) throw activation.error;
      const finalized = await finalizeRecord({
        tableId: fixture.tableId,
        recordId: fixture.recordId,
        actorId: fixture.actorId,
        origin: "direct",
      });
      if (!finalized.ok) throw finalized.error;
      const policy = await updateMutationPolicy(fixture.tableId, { mode: "selected", sources: ["direct", "form"] }, fixture.actorId);
      if (!policy.ok) throw policy.error;
      const plan = boundPlan(
        [
          actionStep(0, "createCorrectionDraft", {
            original: "inputs.original",
            typeField: "Document type",
            typeValue: "correction",
            originalField: "Corrects",
          }),
        ],
        {
          "steps.0.createCorrectionDraft.typeField": fixture.correctionTypeFieldId,
          "steps.0.createCorrectionDraft.originalField": fixture.originalRelationFieldId,
        },
      );
      const inputs = { original: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } };

      const runId = await queueRun(fixture, { plan, inputs });
      const dryRunId = await queueRun(fixture, { mode: "dryRun", plan, inputs });
      expect(await drive(runId)).toBe("failed");
      expect(await drive(dryRunId, "dryRun")).toBe("failed");
      expect((await runRow(runId)).error).toMatchObject({ code: "FORBIDDEN" });
      expect((await runRow(dryRunId)).error).toMatchObject({
        code: "WORKFLOW_DRY_RUN_INDETERMINATE",
        message: "This table does not allow changes from workflows and actions.",
      });
      const [count] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${fixture.tableId}::uuid
      `;
      expect(count?.count).toBe(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("closeRecord obeys the workflow mutation policy before Direct or Four-eyes behavior", async () => {
    const fixture = createFixture();
    const groupId = uuid();
    try {
      await insertFixture(fixture);
      await sql`INSERT INTO auth.groups (id, cn, provider, name) VALUES (${groupId}::uuid, ${`close-policy-${groupId}`}, 'local', 'Close policy approvers')`;
      const history = await enableDurableHistory(fixture.tableId, fixture.actorId);
      if (!history.ok) throw history.error;
      const activation = await enableFinalization(fixture.tableId, { mode: "fourEyes", approverGroupId: groupId }, fixture.actorId);
      if (!activation.ok) throw activation.error;
      const policy = await updateMutationPolicy(fixture.tableId, { mode: "selected", sources: ["direct", "form"] }, fixture.actorId);
      if (!policy.ok) throw policy.error;
      const plan = boundPlan([actionStep(0, "closeRecord", { record: "inputs.record" })], {});
      const inputs = { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } };

      const runId = await queueRun(fixture, { plan, inputs });
      expect(await drive(runId)).toBe("failed");
      expect((await runRow(runId)).error).toMatchObject({ code: "FORBIDDEN" });
      const [state] = await sql<Array<{ finalized_at: Date | null; requests: number }>>`
        SELECT record.finalized_at,
               (SELECT count(*)::int FROM grids.record_finalization_requests request WHERE request.record_id = record.id) AS requests
        FROM grids.records record
        WHERE record.id = ${fixture.recordId}::uuid
      `;
      expect(state).toEqual({ finalized_at: null, requests: 0 });

      const dryRunId = await queueRun(fixture, { mode: "dryRun", plan, inputs });
      expect(await drive(dryRunId, "dryRun")).toBe("failed");
      expect(JSON.stringify((await runRow(dryRunId)).error)).toContain("does not allow changes from workflows and actions");
    } finally {
      await cleanupFixture(fixture);
      await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    }
  });

  postgresTest("closeRecord refuses when Finalization mode changed after preview", async () => {
    const fixture = createFixture();
    const groupId = uuid();
    try {
      await insertFixture(fixture);
      await sql`INSERT INTO auth.groups (id, cn, provider, name) VALUES (${groupId}::uuid, ${`mode-approvers-${groupId}`}, 'local', 'Mode approvers')`;
      const history = await enableDurableHistory(fixture.tableId, fixture.actorId);
      if (!history.ok) throw history.error;
      const activation = await enableFinalization(fixture.tableId, { mode: "direct" }, fixture.actorId);
      if (!activation.ok) throw activation.error;
      const runId = await queueRun(fixture, {
        plan: boundPlan([actionStep(0, "closeRecord", { record: "inputs.record", expectedMode: "inputs.closeMode" })], {}),
        inputs: {
          record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId },
          closeMode: "direct",
        },
      });
      const policy = await setFinalizationPolicy(fixture.tableId, { mode: "fourEyes", approverGroupId: groupId }, fixture.actorId);
      if (!policy.ok) throw policy.error;

      expect(await drive(runId)).toBe("failed");
      expect((await runRow(runId)).error).toMatchObject({ code: "CONFLICT" });
      const [record] = await sql<Array<{ finalized_at: Date | null }>>`
        SELECT finalized_at FROM grids.records WHERE id = ${fixture.recordId}::uuid
      `;
      expect(record?.finalized_at).toBeNull();
      const [request] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.record_finalization_requests WHERE record_id = ${fixture.recordId}::uuid
      `;
      expect(request?.count).toBe(0);
    } finally {
      await cleanupFixture(fixture);
      await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    }
  });

  postgresTest("closeRecord refuses when Four-eyes was disabled and re-enabled after preview", async () => {
    const fixture = createFixture();
    const firstGroupId = uuid();
    const secondGroupId = uuid();
    try {
      await insertFixture(fixture);
      await sql`
        INSERT INTO auth.groups (id, cn, provider, name) VALUES
          (${firstGroupId}::uuid, ${`first-close-approvers-${firstGroupId}`}, 'local', 'First close approvers'),
          (${secondGroupId}::uuid, ${`second-close-approvers-${secondGroupId}`}, 'local', 'Second close approvers')
      `;
      const history = await enableDurableHistory(fixture.tableId, fixture.actorId);
      if (!history.ok) throw history.error;
      const activation = await enableFinalization(fixture.tableId, { mode: "fourEyes", approverGroupId: firstGroupId }, fixture.actorId);
      if (!activation.ok) throw activation.error;
      const runId = await queueRun(fixture, {
        plan: boundPlan(
          [
            actionStep(0, "closeRecord", {
              record: "inputs.record",
              expectedMode: "inputs.closeMode",
              expectedPolicyRevision: "inputs.closePolicyRevision",
            }),
          ],
          {},
        ),
        inputs: {
          record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId },
          closeMode: "fourEyes",
          closePolicyRevision: activation.data.enabled ? activation.data.policyRevision : 1,
        },
      });
      const disabled = await disableFinalization(fixture.tableId, fixture.actorId);
      if (!disabled.ok) throw disabled.error;
      const changed = await enableFinalization(fixture.tableId, { mode: "fourEyes", approverGroupId: secondGroupId }, fixture.actorId);
      if (!changed.ok) throw changed.error;
      if (!activation.data.enabled || !changed.data.enabled) throw new Error("Finalization policy was not enabled");
      expect(changed.data.policyRevision).toBeGreaterThan(activation.data.policyRevision);

      expect(await drive(runId)).toBe("failed");
      expect((await runRow(runId)).error).toMatchObject({ code: "CONFLICT" });
      const [request] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.record_finalization_requests WHERE record_id = ${fixture.recordId}::uuid
      `;
      expect(request?.count).toBe(0);
    } finally {
      await cleanupFixture(fixture);
      await sql`DELETE FROM auth.groups WHERE id IN (${firstGroupId}::uuid, ${secondGroupId}::uuid)`;
    }
  });

  postgresTest("a replay returns the recorded outcome instead of writing the record a second time", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const runId = await queueRun(fixture, {
        plan: boundPlan([actionStep(0, "updateRecord", { record: "inputs.record", set: { Status: "Approved" } })], {
          "steps.0.updateRecord.set.Status": fixture.statusFieldId,
        }),
        inputs: { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });
      expect(await drive(runId)).toBe("succeeded");

      await reopenForReplay(runId);
      // Somebody moved the record on after the first attempt committed. A second
      // write would silently undo that edit.
      await sql`
        UPDATE grids.records
        SET data = jsonb_set(data, ARRAY[${fixture.statusFieldId}], '"Reopened by a person"'::jsonb)
        WHERE id = ${fixture.recordId}::uuid
      `;

      expect(await drive(runId)).toBe("succeeded");
      expect((await recordData(fixture.recordId))[fixture.statusFieldId]).toBe("Reopened by a person");

      const [step] = await stepRuns(runId);
      expect(step?.outcome).toMatchObject({
        state: "completed",
        output: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId },
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("createRecord inserts the row and leaves an audit entry naming the run and the workflow", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const runId = await queueRun(fixture, {
        plan: boundPlan([actionStep(0, "createRecord", { table: "Tasks", values: { Name: "Created by a workflow" } })], {
          "steps.0.createRecord.table": fixture.tableId,
          "steps.0.createRecord.values.Name": fixture.nameFieldId,
        }),
      });

      expect(await drive(runId)).toBe("succeeded");

      const created = await sql<Array<{ id: string; data: Record<string, unknown> }>>`
        SELECT id::text AS id, data
        FROM grids.records
        WHERE table_id = ${fixture.tableId}::uuid AND id <> ${fixture.recordId}::uuid
      `;
      expect(created).toHaveLength(1);
      expect(created[0]?.data[fixture.nameFieldId]).toBe("Created by a workflow");

      const [entry] = await sql<
        Array<{ record_id: string; user_id: string; diff: { workflowRecordCreate: { new: Record<string, unknown> } } }>
      >`
        SELECT record_id::text AS record_id, user_id::text AS user_id, diff
        FROM grids.audit_log
        WHERE base_id = ${fixture.baseId}::uuid AND action = 'workflow.record.created'
      `;
      expect(entry).toMatchObject({ record_id: created[0]?.id, user_id: fixture.actorId });
      // Provenance is the whole point of the entry: a row written by a workflow
      // has to be traceable back to which run wrote it.
      expect(entry?.diff.workflowRecordCreate.new).toMatchObject({
        workflowRunId: runId,
        workflowId: fixture.workflowId,
        fields: [fixture.nameFieldId],
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("atomicRecords commits its checks, update, create, audits, outbox, and outcome together", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const runId = await queueRun(fixture, {
        plan: boundPlan(
          [
            actionStep(0, "atomicRecords", {
              locks: ["inputs.record"],
              checks: [{ table: "Tasks", where: [{ field: "Status", op: "equals", value: "Open" }], assert: "notEmpty" }],
              changes: [
                { updateRecord: { record: "inputs.record", set: { Status: "Approved" } } },
                { createRecord: { table: "Tasks", values: { Name: "Reservation evidence" } } },
              ],
            }),
          ],
          {
            "steps.0.atomicRecords.checks.0.table": fixture.tableId,
            "steps.0.atomicRecords.checks.0.where.0.field": fixture.statusFieldId,
            "steps.0.atomicRecords.changes.0.updateRecord.set.Status.$target": fixture.statusFieldId,
            "steps.0.atomicRecords.changes.1.createRecord.table": fixture.tableId,
            "steps.0.atomicRecords.changes.1.createRecord.values.Name.$target": fixture.nameFieldId,
          },
        ),
        inputs: { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });

      expect(await drive(runId)).toBe("succeeded");
      expect((await recordData(fixture.recordId))[fixture.statusFieldId]).toBe("Approved");
      const created = await sql<Array<{ id: string; data: Record<string, unknown> }>>`
        SELECT id::text AS id, data
        FROM grids.records
        WHERE table_id = ${fixture.tableId}::uuid AND id <> ${fixture.recordId}::uuid
      `;
      expect(created).toHaveLength(1);
      expect(created[0]?.data[fixture.nameFieldId]).toBe("Reservation evidence");
      const [{ audits = 0 } = {}] = await sql<Array<{ audits: number }>>`
        SELECT count(*)::int AS audits
        FROM grids.audit_log
        WHERE base_id = ${fixture.baseId}::uuid
          AND action IN ('workflow.record.updated', 'workflow.record.created')
      `;
      expect(audits).toBe(2);
      const [{ events = 0 } = {}] = await sql<Array<{ events: number }>>`
        SELECT count(*)::int AS events FROM grids.record_event_outbox WHERE base_id = ${fixture.baseId}::uuid
      `;
      expect(events).toBe(2);
      expect((await stepRuns(runId))[0]).toMatchObject({ state: "completed", effect_state: "succeeded" });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("atomicRecords rolls every record, audit, and outbox write back when a later change conflicts", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const runId = await queueRun(fixture, {
        plan: boundPlan(
          [
            actionStep(0, "atomicRecords", {
              locks: ["inputs.record"],
              checks: [{ table: "Tasks", where: [{ field: "Status", op: "equals", value: "Open" }], assert: "notEmpty" }],
              changes: [
                { createRecord: { table: "Tasks", values: { Name: "Must roll back" } } },
                { updateRecord: { record: "inputs.record", set: { Status: "Approved" }, ifVersion: 999 } },
              ],
            }),
          ],
          {
            "steps.0.atomicRecords.checks.0.table": fixture.tableId,
            "steps.0.atomicRecords.checks.0.where.0.field": fixture.statusFieldId,
            "steps.0.atomicRecords.changes.0.createRecord.table": fixture.tableId,
            "steps.0.atomicRecords.changes.0.createRecord.values.Name.$target": fixture.nameFieldId,
            "steps.0.atomicRecords.changes.1.updateRecord.set.Status.$target": fixture.statusFieldId,
          },
        ),
        inputs: { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });

      expect(await drive(runId)).toBe("failed");
      expect((await recordData(fixture.recordId))[fixture.statusFieldId]).toBe("Open");
      const [{ records = 0 } = {}] = await sql<Array<{ records: number }>>`
        SELECT count(*)::int AS records FROM grids.records WHERE table_id = ${fixture.tableId}::uuid
      `;
      expect(records).toBe(1);
      const [{ audits = 0 } = {}] = await sql<Array<{ audits: number }>>`
        SELECT count(*)::int AS audits FROM grids.audit_log WHERE base_id = ${fixture.baseId}::uuid
      `;
      expect(audits).toBe(0);
      const [{ events = 0 } = {}] = await sql<Array<{ events: number }>>`
        SELECT count(*)::int AS events FROM grids.record_event_outbox WHERE base_id = ${fixture.baseId}::uuid
      `;
      expect(events).toBe(0);
      expect((await stepRuns(runId))[0]).toMatchObject({ state: "failed", effect_state: null });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("atomicRecords serializes competing reservations on the same coordination record", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const plan = boundPlan(
        [
          actionStep(0, "atomicRecords", {
            locks: ["inputs.record"],
            checks: [{ table: "Tasks", where: [{ field: "Status", op: "equals", value: "Open" }], assert: "notEmpty" }],
            changes: [{ updateRecord: { record: "inputs.record", set: { Status: "Reserved" } } }],
          }),
        ],
        {
          "steps.0.atomicRecords.checks.0.table": fixture.tableId,
          "steps.0.atomicRecords.checks.0.where.0.field": fixture.statusFieldId,
          "steps.0.atomicRecords.changes.0.updateRecord.set.Status.$target": fixture.statusFieldId,
        },
      );
      const inputs = { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } } as Record<
        string,
        WorkflowJsonValue
      >;
      const firstRunId = await queueRun(fixture, { plan, inputs });
      const secondRunId = await queueRun(fixture, { plan, inputs });

      const states = await Promise.all([drive(firstRunId), drive(secondRunId)]);
      expect(states.sort()).toEqual(["failed", "succeeded"]);
      expect((await recordData(fixture.recordId))[fixture.statusFieldId]).toBe("Reserved");
      const failures = await Promise.all([runRow(firstRunId), runRow(secondRunId)]);
      expect(failures.find((run) => run.state === "failed")?.error).toMatchObject({ code: "ATOMIC_CHECK_FAILED" });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("an atomicRecords dry run evaluates checks without locking or mutating records", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const runId = await queueRun(fixture, {
        mode: "dryRun",
        plan: boundPlan(
          [
            actionStep(0, "atomicRecords", {
              locks: ["inputs.record"],
              checks: [{ table: "Tasks", where: [{ field: "Status", op: "equals", value: "Open" }], assert: "notEmpty" }],
              changes: [{ updateRecord: { record: "inputs.record", set: { Status: "Approved" } } }],
            }),
          ],
          {
            "steps.0.atomicRecords.checks.0.table": fixture.tableId,
            "steps.0.atomicRecords.checks.0.where.0.field": fixture.statusFieldId,
            "steps.0.atomicRecords.changes.0.updateRecord.set.Status.$target": fixture.statusFieldId,
          },
        ),
        inputs: { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });

      expect(await drive(runId, "dryRun")).toBe("succeeded");
      expect((await recordData(fixture.recordId))[fixture.statusFieldId]).toBe("Open");
      const [step] = await stepRuns(runId);
      expect(step?.outcome).toMatchObject({ state: "planned" });
      expect(JSON.stringify(step?.outcome)).toContain("checks run again while locks are held");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("atomicRecords rechecks access after queueing and leaves every record unchanged when it was revoked", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const runId = await queueRun(fixture, {
        plan: boundPlan(
          [
            actionStep(0, "atomicRecords", {
              locks: ["inputs.record"],
              checks: [{ table: "Tasks", where: [{ field: "Status", op: "equals", value: "Open" }], assert: "notEmpty" }],
              changes: [{ updateRecord: { record: "inputs.record", set: { Status: "Approved" } } }],
            }),
          ],
          {
            "steps.0.atomicRecords.checks.0.table": fixture.tableId,
            "steps.0.atomicRecords.checks.0.where.0.field": fixture.statusFieldId,
            "steps.0.atomicRecords.changes.0.updateRecord.set.Status.$target": fixture.statusFieldId,
          },
        ),
        inputs: { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });
      await sql`
        DELETE FROM auth.access
        WHERE id IN (SELECT access_id FROM grids.base_access WHERE base_id = ${fixture.baseId}::uuid)
      `;

      expect(await drive(runId)).toBe("failed");
      expect((await runRow(runId)).error).toMatchObject({ code: "FORBIDDEN" });
      expect((await recordData(fixture.recordId))[fixture.statusFieldId]).toBe("Open");
      expect((await stepRuns(runId))[0]).toMatchObject({ state: "failed", effect_state: null });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("an atomicRecords replay returns its journaled outcome without applying its changes again", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const runId = await queueRun(fixture, {
        plan: boundPlan(
          [
            actionStep(0, "atomicRecords", {
              locks: ["inputs.record"],
              checks: [{ table: "Tasks", where: [{ field: "Status", op: "equals", value: "Open" }], assert: "notEmpty" }],
              changes: [{ updateRecord: { record: "inputs.record", set: { Status: "Approved" } } }],
            }),
          ],
          {
            "steps.0.atomicRecords.checks.0.table": fixture.tableId,
            "steps.0.atomicRecords.checks.0.where.0.field": fixture.statusFieldId,
            "steps.0.atomicRecords.changes.0.updateRecord.set.Status.$target": fixture.statusFieldId,
          },
        ),
        inputs: { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });
      expect(await drive(runId)).toBe("succeeded");

      await reopenForReplay(runId);
      await sql`
        UPDATE grids.records
        SET data = jsonb_set(data, ARRAY[${fixture.statusFieldId}], '"Reopened by a person"'::jsonb)
        WHERE id = ${fixture.recordId}::uuid
      `;

      expect(await drive(runId)).toBe("succeeded");
      expect((await recordData(fixture.recordId))[fixture.statusFieldId]).toBe("Reopened by a person");
      expect((await stepRuns(runId))[0]?.outcome).toMatchObject({
        state: "completed",
        output: { created: [], updated: [{ kind: "record", tableId: fixture.tableId, recordId: fixture.recordId }] },
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("a grant revoked while the run was queued fails the step with FORBIDDEN and leaves the record alone", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const runId = await queueRun(fixture, {
        plan: boundPlan([actionStep(0, "updateRecord", { record: "inputs.record", set: { Status: "Approved" } })], {
          "steps.0.updateRecord.set.Status": fixture.statusFieldId,
        }),
        inputs: { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });
      // Queued runs recheck the owning Base grant at the moment of the write.
      await sql`
        DELETE FROM auth.access
        WHERE id IN (SELECT access_id FROM grids.base_access WHERE base_id = ${fixture.baseId}::uuid)
      `;

      expect(await drive(runId)).toBe("failed");
      expect((await runRow(runId)).error).toMatchObject({ code: "FORBIDDEN" });
      expect((await recordData(fixture.recordId))[fixture.statusFieldId]).toBe("Open");

      const [step] = await stepRuns(runId);
      expect(step).toMatchObject({ state: "failed", effect_state: null });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("httpRequest refuses the private side of the network, and says so on the step", async () => {
    const fixture = createFixture();
    // A workflow author has the app's permissions, not the server's network
    // position. This server is reachable from inside the container and from
    // nowhere the author could reach on their own — which is the whole point.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("{}") });
    try {
      await insertFixture(fixture);
      const runId = await queueRun(fixture, {
        plan: boundPlan([actionStep(0, "httpRequest", { url: `http://127.0.0.1:${server.port}/ok`, json: { ping: true } })], {}),
      });

      expect(await drive(runId)).toBe("failed");
      expect((await runRow(runId)).error).toMatchObject({ code: "BAD_INPUT" });

      const [step] = await stepRuns(runId);
      // An ambiguous effect is marked before the action runs — the kernel cannot
      // know when a request actually leaves the process. So the refusal settles
      // that mark as failed rather than leaving it dangling for a human.
      expect(step).toMatchObject({ state: "failed", effect_state: "failed" });
      expect(step?.outcome).toMatchObject({ error: { message: "HTTP request target is not a public address" } });
    } finally {
      server.stop(true);
      await cleanupFixture(fixture);
    }
  });

  postgresTest("a dry run plans a create-then-send without inserting a record or queuing a delivery", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const runId = await queueRun(fixture, {
        mode: "dryRun",
        plan: boundPlan(
          [
            actionStep(0, "createRecord", { table: "Tasks", values: { Name: "Planned only" } }),
            actionStep(1, "sendEmail", { template: "Task notice", to: [{ email: "someone@example.com" }] }),
          ],
          {
            "steps.0.createRecord.table": fixture.tableId,
            "steps.0.createRecord.values.Name": fixture.nameFieldId,
            "steps.1.sendEmail.template": fixture.emailTemplateId,
          },
        ),
      });

      expect(await drive(runId, "dryRun")).toBe("succeeded");

      const [{ records = 0 } = {}] = await sql<Array<{ records: number }>>`
        SELECT count(*)::int AS records FROM grids.records WHERE table_id = ${fixture.tableId}::uuid
      `;
      expect(records).toBe(1);
      const [{ deliveries = 0 } = {}] = await sql<Array<{ deliveries: number }>>`
        SELECT count(*)::int AS deliveries FROM grids.workflow_email_deliveries WHERE workflow_run_id = ${runId}::uuid
      `;
      expect(deliveries).toBe(0);

      const steps = await stepRuns(runId);
      expect(steps.map((step) => step.state)).toEqual(["planned", "planned"]);
      // Marked planned so a later step can tell this from a real record. Without
      // the flag the next action would act on a row id that has no row.
      expect(steps[0]?.outcome).toMatchObject({
        state: "planned",
        output: { kind: "record", tableId: fixture.tableId, recordId: "dry-run:steps.0", planned: true },
      });
      expect(JSON.stringify((await runRow(runId)).result)).toContain('Send \\"Task notice\\" to 1 recipient(s)');
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("a dry run links a document that only exists as a plan, without generating or persisting one", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const runId = await queueRun(fixture, {
        mode: "dryRun",
        plan: boundPlan(
          [
            actionStep(0, "generateDocument", { template: "Task sheet", record: "inputs.record", saveAs: "sheet" }),
            actionStep(1, "createDocumentLink", { document: "sheet", expiresIn: "7d" }),
          ],
          // `document` is a reference to an earlier step's output, not a name
          // the compiler pinned — so only the template is bound.
          { "steps.0.generateDocument.template": fixture.documentTemplateId },
        ),
        inputs: { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });

      expect(await drive(runId, "dryRun")).toBe("succeeded");

      const [{ runs = 0 } = {}] = await sql<Array<{ runs: number }>>`
        SELECT count(*)::int AS runs FROM grids.documents WHERE base_id = ${fixture.baseId}::uuid
      `;
      expect(runs).toBe(0);

      const steps = await stepRuns(runId);
      // "Generate then link" has to stay a plannable pair: the second step
      // resolves the placeholder the first one planned, so a dry run does not
      // dead-end at the first step that has not really run.
      expect(steps[0]?.outcome).toMatchObject({ state: "planned", output: { kind: "document", planned: true } });
      expect(steps[1]?.outcome).toMatchObject({ state: "planned", output: { kind: "documentLink", expiresIn: "7d", planned: true } });
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
