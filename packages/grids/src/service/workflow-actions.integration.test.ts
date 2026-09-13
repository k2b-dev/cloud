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
import { beforeAll, describe, expect, spyOn } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import type { WorkflowBoundPlan, WorkflowIrStep, WorkflowJsonValue } from "@k2b/cloud/workflows";
import { hashWorkflowJson } from "@k2b/cloud/workflows/language";
import { createWorkflowRun } from "@k2b/cloud/workflows/store";
import { type SQL, sql } from "bun";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { createCustomAppsApi } from "../api/custom-apps";
import { createDocumentResourceRoutes } from "../api/document-resource-routes";
import { createWorkflowDocumentConfirmationRoutes, FinancialExportPreviewSchema } from "../api/workflow-document-confirmations";
import { PublicGridsWorkflowRunSchema } from "../api/workflow-public-contracts";
import { createWorkflowRunRoutes } from "../api/workflow-run-routes";
import { jsonDocumentProfile } from "../document-profiles/table";
import { expensePaymentStarterSource } from "../frontend/_components/workflows/financial-workflow-starters";
import { postgresTest, testShortId as shortId, testUuid as uuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { canonicalizeDslQuery } from "../query-dsl/canonical";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { compileAndBindGridsWorkflowSource } from "../workflows/binder";
import type { GridsWorkflowPrincipal } from "../workflows/contracts";
import { gridsWorkflows } from "../workflows/module";
import { grantAccess, revokeAccess } from "./access";
import { apply as applyCustomApp, publish as publishCustomApp } from "./custom-apps";
import { documentIssuanceService, readDocumentArtifact } from "./document-issuance";
import * as documentRendering from "./document-rendering";
import { createRecordSnapshot } from "./document-snapshots";
import { enable as enableDurableHistory, listRecordRevisions } from "./durable-history";
import { buildTrustedGqlResolverContext } from "./gql-resolver-context";
import { update as updateMutationPolicy } from "./mutation-policy";
import { provisionFieldNumberSeries } from "./number-series";
import {
  disable as disableFinalization,
  enable as enableFinalization,
  finalize as finalizeRecord,
  setPolicy as setFinalizationPolicy,
} from "./record-finalization";
import { listReferencedBy } from "./referenced-by";
import { canAccessWorkflowRunTable, canExecuteRun, documentActorForScope } from "./workflow-action-scope";
import { loadWorkflowCatalog } from "./workflow-catalog";
import { captureWorkflowDocumentSource, captureWorkflowRecordSource } from "./workflow-document-sources";
import { invokeRecordLauncher } from "./workflow-launcher-invocations";
import { createLauncher } from "./workflow-launchers";
import { workflowQueryBinder } from "./workflow-query-binding";
import { getWorkflow } from "./workflow-read";
import { GRIDS_APP_ID, getWorkflowDocumentConfirmation, getWorkflowRunScope, gridsAuthorizationSnapshot } from "./workflow-runs";
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
  // Issued documents, snapshots and reserved numbers retain their base. Keep these
  // uniquely scoped fixtures, just like the document issuance integration suite.
  const retained = await sql`SELECT id FROM grids.documents WHERE base_id = ${fixture.baseId}::uuid
    UNION ALL SELECT id FROM grids.record_snapshots WHERE base_id = ${fixture.baseId}::uuid
    UNION ALL SELECT base_id FROM grids.document_profile_counters WHERE base_id = ${fixture.baseId}::uuid LIMIT 1`;
  if (retained.length > 0) return;
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
}, 30_000);

describe("declared Grids workflow actions", () => {
  postgresTest("associatedData captures real records and rejects malformed references without retrying", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const catalog = await loadWorkflowCatalog(fixture.baseId);
      const compiled = await compileAndBindGridsWorkflowSource(
        "steps:\n  - query:\n      source: |\n        from table Tasks\n        select Name\n      saveAs: report\n  - generateDocument:\n      data: report\n      associatedData: report\n      output: { kind: json }\n",
        catalog,
        workflowQueryBinder(fixture.baseId, catalog),
      );
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
      const dry = await queueRun(fixture, { plan: compiled.plan, mode: "dryRun" });
      expect(await drive(dry, "dryRun")).toBe("succeeded");
      expect(await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${dry}::uuid`).toHaveLength(0);
      const runId = await queueRun(fixture, { plan: compiled.plan });
      expect(await drive(runId)).toBe("succeeded");
      const sources = await sql`SELECT s.record_id::text, s.version::int FROM grids.document_record_sources s
        JOIN grids.documents d ON d.id = s.document_id WHERE d.workflow_run_id = ${runId}::uuid`;
      expect(sources).toEqual([{ record_id: fixture.recordId, version: 1 }]);
      const broken = {
        ...compiled.plan,
        steps: compiled.plan.steps.map((step) =>
          step.kind === "action" && step.action === "generateDocument"
            ? { ...step, config: { ...step.config, associatedData: "report.rowCount" } }
            : step,
        ),
      };
      const badRun = await queueRun(fixture, { plan: broken });
      expect(await drive(badRun)).toBe("failed");
      expect(await runRow(badRun)).toMatchObject({ error: { code: "BAD_INPUT" } });
      expect(await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${badRun}::uuid`).toHaveLength(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });
  postgresTest("a stale manifest cannot capture data or issue a document", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const plan = boundPlan([actionStep(0, "query", {})], {});
      const runId = await queueRun(fixture, { plan: { ...plan, manifestHash: "0".repeat(64) } });
      await runGridsWorkflowRun(runId);
      expect(await runRow(runId)).toMatchObject({ state: "needs_attention", error: { code: "WORKFLOW_MODULE_MISMATCH" } });
      expect(await stepRuns(runId)).toHaveLength(0);
      expect(await sql`SELECT id FROM grids.workflow_query_data WHERE run_id = ${runId}::uuid`).toHaveLength(0);
      expect(await sql`SELECT id FROM grids.document_issuances WHERE base_id = ${fixture.baseId}::uuid`).toHaveLength(0);
      expect(await sql`SELECT id FROM grids.documents WHERE base_id = ${fixture.baseId}::uuid`).toHaveLength(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest(
    "embedded scanner exposes financial confirmation and rechecks app access before issuance",
    async () => {
      const fixture = createFixture();
      try {
        await insertFixture(fixture);
        await sql`UPDATE grids.fields SET unique_constraint = true WHERE id = ${fixture.nameFieldId}::uuid`;
        const catalog = await loadWorkflowCatalog(fixture.baseId);
        const source = `inputs:
  item:
    type: record
    table: Tasks
    required: true
steps:
  - query:
      source: |
        from table Tasks
        select Name as payee, formula('scan-expense-1') as business, formula('12.30') as amount, formula('DE89370400440532013000') as iban
        where record.id = @params.selected
      parameters:
        selected:
          type: record
          value: '\${{ inputs.item }}'
      saveAs: report
  - generateDocument:
      data: report
      output:
        kind: sepa-xml
        version: 1
        header:
          destinationKey: scanner-bank
          debtorName: Example
          debtorIban: DE89370400440532013000
          executionDate: '2026-09-14'
        mapping:
          businessId: business
          amount: amount
          endToEndId: business
          creditorName: payee
          creditorIban: iban
          remittance: business
      saveAs: exported
`;
        const compiled = await compileAndBindGridsWorkflowSource(source, catalog, workflowQueryBinder(fixture.baseId, catalog));
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
        await publishTestWorkflowVersion(fixture.workflowId, source, compiled.plan);
        const workflow = await getWorkflow(fixture.workflowId);
        if (!workflow) throw new Error("Missing scanner workflow");
        const launcher = await createLauncher(
          workflow,
          {
            name: "Scan expense",
            enabled: true,
            config: {
              kind: "scanner",
              inputSources: { ["item"]: { kind: "scan", value: "record", resolve: { by: "field", field: "Name" } } },
            },
          },
          fixture.actorId,
        );
        if (!launcher.ok) throw launcher.error;
        const [base] = await sql<Array<{ short_id: string }>>`SELECT short_id FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
        if (!base) throw new Error("Missing base");
        const app = await applyCustomApp(
          {
            schemaVersion: 5,
            kind: "grids.custom-app",
            id: shortId("A"),
            baseId: base.short_id,
            name: "Expense scanner",
            startPageId: "home",
            sidebar: { actions: [] },
            pages: [
              {
                id: "home",
                title: "Scan",
                navigation: { visible: true },
                parameters: {},
                rows: [
                  {
                    id: "content",
                    columns: [{ id: "main", span: 12, blocks: [{ id: "scan", type: "scanner", launcherId: launcher.data.shortId }] }],
                  },
                ],
              },
            ],
          },
          fixture.actorId,
        );
        if (!app.ok) throw app.error;
        const published = await publishCustomApp(app.data.id, fixture.actorId);
        if (!published.ok) throw published.error;
        const grant = () =>
          grantAccess({
            resourceType: "customApp",
            resourceId: app.data.id,
            principal: { type: "user", userId: fixture.actorId },
            permission: "read",
            actorId: fixture.actorId,
          });
        const access = await grant();
        if (!access.ok) throw access.error;
        const user: User = {
          id: fixture.actorId,
          uid: `workflow-action-${fixture.actorId}`,
          roles: ["user"],
          provider: "local",
          profile: "user",
          givenname: "Workflow",
          sn: "Actor",
          displayName: "Workflow Actor",
          mail: "workflow@example.test",
          avatarHash: null,
          accountExpires: null,
          lastLoginLocal: null,
          memberofGroup: [],
          memberofGroupIds: [],
          manages: [],
          managesGroupIds: [],
          ipa: null,
        };
        const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
          c.set("actor", { kind: "user", user });
          c.set("user", user);
          c.set("accessSubject", { type: "user", userId: fixture.actorId });
          await next();
        };
        const api = new Hono<AuthContext>()
          .use("*", authenticate)
          .route("/apps", createCustomAppsApi({ requireAuthenticated: authenticate, loadOptionalActor: authenticate }))
          .route("/", createWorkflowDocumentConfirmationRoutes());
        const response = await api.request(`/apps/runtime/${app.data.shortId}/home/scan/scanner`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operationId: uuid(), expectedRevision: workflow.revision, scannedText: "Draft task", inputs: {} }),
        });
        expect(response.status, await response.clone().text()).toBe(202);
        const invocation = z.object({ statusUrl: z.string() }).parse(await response.json());
        const statusPath = invocation.statusUrl.replace(/^\/api\/grids/, "");
        const publicRunId = statusPath.split("/").at(-1);
        const [run] = await sql<Array<{ run_id: string }>>`SELECT run_id FROM grids.workflow_run_profile WHERE short_id = ${publicRunId}`;
        if (!run) throw new Error("Missing scanner run");
        await runGridsWorkflowRun(run.run_id);
        expect((await runRow(run.run_id)).state).toBe("waiting");
        const pending = await getWorkflowDocumentConfirmation(run.run_id);
        if (!pending) throw new Error(JSON.stringify(await stepRuns(run.run_id)));
        const status = await api.request(statusPath);
        expect(status.status).toBe(200);
        expect(await status.json()).toMatchObject({ documentConfirmation: pending });
        const confirmationPath = `/runs/${publicRunId}/document-confirmations/${pending.receiptId}`;
        const preview = await api.request(confirmationPath);
        expect(preview.status, await preview.clone().text()).toBe(200);
        expect(FinancialExportPreviewSchema.parse(await preview.json()).input.rows[0]).toMatchObject({ amount: "12.30" });
        const revoked = await revokeAccess(access.data.accessId, fixture.actorId);
        if (!revoked.ok) throw revoked.error;
        const confirm = () =>
          api.request(`${confirmationPath}/confirm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sha256: pending.sha256 }),
          });
        expect((await confirm()).status).toBe(403);
        expect(await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${run.run_id}::uuid`).toHaveLength(0);
        const restored = await grant();
        if (!restored.ok) throw restored.error;
        expect((await confirm()).status).toBe(200);
        expect(await drive(run.run_id)).toBe("succeeded");
        const done = await api.request(statusPath);
        expect(done.status).toBe(200);
        expect(await done.json()).not.toHaveProperty("documentConfirmation");
        expect(await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${run.run_id}::uuid`).toHaveLength(1);
      } finally {
        await cleanupFixture(fixture);
      }
    },
    30_000,
  );

  postgresTest("query publication and execution refuse inaccessible tables and incompatible schemas", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const source = "steps:\n  - query:\n      source: |\n        from table Tasks\n        select Name\n";
      const catalog = await loadWorkflowCatalog(fixture.baseId);
      const deniedCatalog = { ...catalog, tables: { refs: new Map(), ambiguous: new Set<string>() } };
      expect((await compileAndBindGridsWorkflowSource(source, deniedCatalog, workflowQueryBinder(fixture.baseId, deniedCatalog))).ok).toBe(
        false,
      );
      const bound = await compileAndBindGridsWorkflowSource(source, catalog, workflowQueryBinder(fixture.baseId, catalog));
      if (!bound.ok) throw new Error(JSON.stringify(bound.diagnostics));
      await sql`UPDATE grids.fields SET config = '{"maxLength":12}'::jsonb WHERE id = ${fixture.nameFieldId}::uuid`;
      const runId = await queueRun(fixture, { plan: bound.plan });
      expect(await drive(runId)).toBe("failed");
      expect((await runRow(runId)).error?.code).toBe("CONFLICT");
      const [count] = await sql`SELECT count(*)::int AS count FROM grids.workflow_query_data WHERE run_id = ${runId}::uuid`;
      expect(count.count).toBe(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("query binds a workflow record input as an authorized public ID", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const catalog = await loadWorkflowCatalog(fixture.baseId);
      const bound = await compileAndBindGridsWorkflowSource(
        "inputs:\n  selected:\n    type: record\n    table: Tasks\n    required: true\nsteps:\n  - query:\n      source: |\n        from table Tasks\n        select Name\n        where record.id = @params.selected\n      parameters:\n        selected:\n          type: record\n          value: ${{ inputs.selected }}\n",
        catalog,
        workflowQueryBinder(fixture.baseId, catalog),
      );
      if (!bound.ok) throw new Error(JSON.stringify(bound.diagnostics));
      const runId = await queueRun(fixture, {
        plan: bound.plan,
        inputs: { selected: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
      });
      expect(await drive(runId)).toBe("succeeded");
      const [captured] = await sql`SELECT payload FROM grids.workflow_query_data WHERE run_id = ${runId}::uuid`;
      expect(captured.payload.rows).toHaveLength(1);
      expect(captured.payload.context["params.selected"]).toMatch(/^[a-zA-Z0-9]{6}$/);
      expect(captured.payload.context["params.selected"]).not.toBe(fixture.recordId);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest(
    "a create-then-query dry run validates without reading a planned record or capturing rows",
    async () => {
      const fixture = createFixture();
      try {
        await insertFixture(fixture);
        const catalog = await loadWorkflowCatalog(fixture.baseId);
        const compiled = await compileAndBindGridsWorkflowSource(
          "steps:\n  - createRecord:\n      table: Tasks\n      values:\n        Name: Created for query\n      saveAs: created\n  - query:\n      source: |\n        from table Tasks\n        select Name\n        where record.id = @params.selected\n      parameters:\n        selected:\n          type: record\n          value: ${{ created }}\n",
          catalog,
          workflowQueryBinder(fixture.baseId, catalog),
        );
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
        const dryRunId = await queueRun(fixture, { plan: compiled.plan, mode: "dryRun" });
        expect(await drive(dryRunId, "dryRun")).toBe("succeeded");
        expect((await stepRuns(dryRunId)).map((step) => step.state)).toEqual(["planned", "planned"]);
        const [count] = await sql`SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${fixture.tableId}::uuid`;
        expect(count.count).toBe(1);
        const [captured] = await sql`SELECT count(*)::int AS count FROM grids.workflow_query_data WHERE run_id = ${dryRunId}::uuid`;
        expect(captured.count).toBe(0);
        const runId = await queueRun(fixture, { plan: compiled.plan });
        expect(await drive(runId)).toBe("succeeded");
        const [actual] = await sql`SELECT payload FROM grids.workflow_query_data WHERE run_id = ${runId}::uuid`;
        expect(actual.payload.rows).toEqual([{ q_col_0: "Created for query" }]);
        expect(actual.payload.context["params.selected"]).toMatch(/^[a-zA-Z0-9]{6}$/);
      } finally {
        await cleanupFixture(fixture);
      }
    },
    30_000,
  );

  postgresTest("query captures once with its journal and dry runs do not persist rows", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const catalog = await loadWorkflowCatalog(fixture.baseId);
      const compiled = await compileAndBindGridsWorkflowSource(
        "steps:\n  - query:\n      source: |\n        from table Tasks\n        select Name as task_name\n      saveAs: report\n",
        catalog,
        workflowQueryBinder(fixture.baseId, catalog),
      );
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
      const dryRunId = await queueRun(fixture, { plan: compiled.plan, mode: "dryRun" });
      expect(await drive(dryRunId, "dryRun")).toBe("succeeded");
      const [dryCount] = await sql`SELECT count(*)::int AS count FROM grids.workflow_query_data WHERE run_id = ${dryRunId}::uuid`;
      expect(dryCount.count).toBe(0);

      const runId = await queueRun(fixture, { plan: compiled.plan });
      expect(await drive(runId)).toBe("succeeded");
      const [captured] = await sql`SELECT id::text, payload, sha256 FROM grids.workflow_query_data WHERE run_id = ${runId}::uuid`;
      expect(captured.payload.rows).toEqual([{ q_col_0: "Draft task" }]);
      expect(captured.payload.columns).toMatchObject([{ key: "q_col_0", label: "task_name" }]);
      expect((await stepRuns(runId))[0]?.effect_output).toMatchObject({
        kind: "queryResult",
        id: captured.id,
        sha256: captured.sha256,
        rowCount: 1,
      });
      expect((await stepRuns(runId))[0]?.effect_output).not.toHaveProperty("rows");
      await sql`UPDATE grids.records SET data = data || ${{ [fixture.nameFieldId]: "Changed later" }}::jsonb WHERE id = ${fixture.recordId}::uuid`;
      await reopenForReplay(runId);
      expect(await drive(runId)).toBe("succeeded");
      const rows = await sql`SELECT id::text, payload, sha256 FROM grids.workflow_query_data WHERE run_id = ${runId}::uuid`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(captured);

      const deniedRun = await queueRun(fixture, { plan: compiled.plan });
      await sql`DELETE FROM grids.base_access WHERE base_id = ${fixture.baseId}::uuid`;
      expect(await drive(deniedRun)).toBe("failed");
      const [deniedCount] = await sql`SELECT count(*)::int AS count FROM grids.workflow_query_data WHERE run_id = ${deniedRun}::uuid`;
      expect(deniedCount.count).toBe(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest(
    "query documents produce PDF, CSV, JSON and XML through one frozen capture and survive replay",
    async () => {
      const fixture = createFixture();
      const renderPdf = documentRendering.renderDocumentHtmlPdf;
      const pdfBodies: string[] = [];
      const renderer = spyOn(documentRendering, "renderDocumentHtmlPdf").mockImplementation((document, locale) =>
        renderPdf(document, locale, {
          config: { url: "http://renderer.invalid", timeoutMs: 1000, maxHtmlBytes: 10_000, maxPdfBytes: 10_000 },
          fetch: async (_url, init) => {
            if (!(init?.body instanceof FormData)) throw new Error("Expected PDF form data");
            const file = init.body.getAll("files").find((value) => value instanceof File && value.name === "index.html");
            if (!(file instanceof File)) throw new Error("Expected PDF body");
            pdfBodies.push(await file.text());
            return new Response("%PDF-frozen-query", { headers: { "content-type": "application/pdf" } });
          },
        }),
      );
      try {
        await insertFixture(fixture);
        const catalog = await loadWorkflowCatalog(fixture.baseId);
        const compiled = await compileAndBindGridsWorkflowSource(
          'inputs:\n  approved:\n    type: boolean\nsteps:\n  - query:\n      source: |\n        from table Tasks\n        select Name as task_name\n      saveAs: report\n  - generateDocument:\n      data: report\n      output: { kind: csv, columns: [{ source: task_name, label: Task }] }\n      saveAs: csvFile\n  - generateDocument:\n      data: report\n      output: { kind: json, wrapper: { rowsKey: items, values: { approved: "${{ inputs.approved }}" } } }\n      saveAs: jsonFile\n  - generateDocument:\n      data: report\n      output:\n        kind: xml\n        body: "<report>{% for row in rows %}{% for column in columns %}<value>{{ row[column.key] }}</value>{% endfor %}{% endfor %}</report>"\n      saveAs: xmlFile\n' +
            '  - generateDocument:\n      data: report\n      output:\n        kind: pdf\n        body: "{% for row in rows %}<p>{{ row.q_col_0 }}</p>{% endfor %}"\n      saveAs: pdfFile\n',
          catalog,
          workflowQueryBinder(fixture.baseId, catalog),
        );
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
        const dry = await queueRun(fixture, { plan: compiled.plan, mode: "dryRun", inputs: { approved: true } });
        expect(await drive(dry, "dryRun")).toBe("succeeded");
        expect(await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${dry}::uuid`).toHaveLength(0);
        const runId = await queueRun(fixture, { plan: compiled.plan, inputs: { approved: true } });
        expect(await drive(runId)).toBe("succeeded");
        const documents = await sql<
          Array<{ id: string; query_data_id: string; primary_artifact_key: string; render_data: unknown; profile_snapshot: unknown }>
        >`
        SELECT id::text, query_data_id::text, primary_artifact_key, render_data, profile_snapshot
        FROM grids.documents WHERE workflow_run_id = ${runId}::uuid ORDER BY primary_artifact_key
      `;
        expect(documents).toHaveLength(4);
        expect(new Set(documents.map((document) => document.query_data_id)).size).toBe(1);
        for (const document of documents) {
          const content = await readDocumentArtifact(document.id, document.primary_artifact_key);
          expect(content.ok).toBe(true);
          if (!content.ok) throw content.error;
          const text = new TextDecoder().decode(content.data.bytes);
          const expected: Record<string, string> = {
            csv: "Task\r\nDraft task\r\n",
            json: '{"approved":true,"items":[{"task_name":"Draft task"}]}',
            xml: "<report><value>Draft task</value></report>",
            pdf: "%PDF-frozen-query",
          };
          const expectedText = expected[document.primary_artifact_key];
          if (expectedText === undefined) throw new Error(`Unexpected artifact ${document.primary_artifact_key}`);
          expect(text).toBe(expectedText);
          expect(JSON.stringify(document.render_data)).not.toContain("Draft task");
          expect(JSON.stringify(document.profile_snapshot)).not.toContain("Draft task");
        }
        const outcomes = await stepRuns(runId);
        expect(outcomes[1]?.outcome?.output).toMatchObject({ tableId: null, recordId: null, templateId: null, primaryArtifactKey: "csv" });
        await sql`UPDATE grids.records SET data = data || ${{ [fixture.nameFieldId]: "Changed later" }}::jsonb WHERE id = ${fixture.recordId}::uuid`;
        await reopenForReplay(runId);
        expect(await drive(runId)).toBe("succeeded");
        expect(await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${runId}::uuid`).toHaveLength(4);
        expect(pdfBodies).toEqual(["<p>Draft task</p>"]);
        const nextReport = await queueRun(fixture, { plan: compiled.plan, inputs: { approved: true } });
        await sql`UPDATE grids.workflow_run_profile SET channel = 'schedule' WHERE run_id = ${nextReport}::uuid`;
        expect(await drive(nextReport)).toBe("succeeded");
        const nextDocuments = await sql<Array<{ query_data_id: string }>>`
          SELECT query_data_id::text FROM grids.documents WHERE workflow_run_id = ${nextReport}::uuid`;
        expect(nextDocuments).toHaveLength(4);
        expect(new Set(nextDocuments.map((document) => document.query_data_id)).size).toBe(1);
        expect(nextDocuments[0]?.query_data_id).not.toBe(documents[0]?.query_data_id);
        expect(pdfBodies).toEqual(["<p>Draft task</p>", "<p>Changed later</p>"]);
        await expect(
          (async () => {
            await sql`DELETE FROM grids.workflow_query_data WHERE run_id = ${runId}::uuid`;
          })(),
        ).rejects.toMatchObject({ errno: "23503" });
      } finally {
        renderer.mockRestore();
        await cleanupFixture(fixture);
      }
    },
    30000,
  );

  postgresTest("lease takeover during rendering prevents issuance and reuses the captured data on recovery", async () => {
    const fixture = createFixture();
    const issue = jsonDocumentProfile.issue.bind(jsonDocumentProfile);
    const render = spyOn(jsonDocumentProfile, "issue");
    try {
      await insertFixture(fixture);
      const catalog = await loadWorkflowCatalog(fixture.baseId);
      const compiled = await compileAndBindGridsWorkflowSource(
        "steps:\n  - query:\n      source: |\n        from table Tasks\n        select Name\n      saveAs: report\n  - generateDocument:\n      data: report\n      output: { kind: json }\n",
        catalog,
        workflowQueryBinder(fixture.baseId, catalog),
      );
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
      const runId = await queueRun(fixture, { plan: compiled.plan });
      render.mockImplementationOnce(async (input, context) => {
        const result = await issue(input, context);
        await sql`UPDATE workflows.run SET execution_generation = execution_generation + 1 WHERE id = ${runId}::uuid`;
        return result;
      });
      expect((await runGridsWorkflowRun(runId)).state).toBe("lost");
      expect(render).toHaveBeenCalledTimes(1);
      expect(await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${runId}::uuid`).toHaveLength(0);
      const captures = await sql`SELECT id, sha256 FROM grids.workflow_query_data WHERE run_id = ${runId}::uuid`;
      expect(captures).toHaveLength(1);
      render.mockRestore();
      await reopenForReplay(runId);
      expect(await drive(runId)).toBe("succeeded");
      expect(await sql`SELECT id, sha256 FROM grids.workflow_query_data WHERE run_id = ${runId}::uuid`).toEqual(captures);
      const documents = await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${runId}::uuid`;
      expect(documents).toHaveLength(1);
      await reopenForReplay(runId);
      expect(await drive(runId)).toBe("succeeded");
      expect(await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${runId}::uuid`).toEqual(documents);
    } finally {
      render.mockRestore();
      await cleanupFixture(fixture);
    }
  });

  postgresTest("query document links can be planned without looking up placeholder IDs", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const catalog = await loadWorkflowCatalog(fixture.baseId);
      for (const kind of ["pdf", "json", "csv", "xml"] as const) {
        const compiled = await compileAndBindGridsWorkflowSource(
          [
            "steps:",
            "  - query:",
            "      source: |",
            "        from table Tasks",
            "        select Name as task_name",
            "      saveAs: report",
            "  - generateDocument:",
            "      data: report",
            `      output: ${JSON.stringify(kind === "pdf" || kind === "xml" ? { kind, body: "<report>Test</report>" } : { kind })}`,
            "      saveAs: reportFile",
            "  - createDocumentLink:",
            "      document: reportFile",
            "      expiresIn: 7d",
            "      saveAs: reportLink",
          ].join("\n"),
          catalog,
          workflowQueryBinder(fixture.baseId, catalog),
        );
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
        const runId = await queueRun(fixture, { plan: compiled.plan, mode: "dryRun" });
        expect(await drive(runId, "dryRun")).toBe(kind === "pdf" ? "succeeded" : "failed");
        const steps = await stepRuns(runId);
        if (kind === "pdf") expect(steps.at(-1)?.outcome?.output).toMatchObject({ kind: "documentLink", planned: true, expiresIn: "7d" });
        else
          expect(steps.at(-1)?.outcome).toMatchObject({
            output: null,
            issues: [{ reason: "Public links are available only for PDF documents. Use an authorized download for this file." }],
          });
        expect(await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${runId}::uuid`).toHaveLength(0);
        expect(await sql`SELECT id FROM grids.workflow_query_data WHERE run_id = ${runId}::uuid`).toHaveLength(0);
      }
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest(
    "record snapshot export keeps historical values and rechecks current source access",
    async () => {
      const fixture = createFixture();
      try {
        await insertFixture(fixture);
        const relatedTable = uuid();
        const relatedField = uuid();
        const relatedRecord = uuid();
        await sql`INSERT INTO grids.tables (id, short_id, base_id, name, position) VALUES (${relatedTable}::uuid, ${shortId("T")}, ${fixture.baseId}::uuid, 'Related', 1)`;
        await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position) VALUES (${relatedField}::uuid, ${shortId("F")}, ${relatedTable}::uuid, 'Secret', 'text', '{}'::jsonb, 0)`;
        await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES (${relatedRecord}::uuid, ${shortId("R")}, ${relatedTable}::uuid, ${{ [relatedField]: "Historical related secret" }}::jsonb)`;
        await sql`UPDATE grids.fields SET config = ${{ targetTableId: relatedTable, cardinality: "single" }}::jsonb WHERE id = ${fixture.originalRelationFieldId}::uuid`;
        await sql`INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
          VALUES (${fixture.recordId}::uuid, ${fixture.originalRelationFieldId}::uuid, ${relatedRecord}::uuid, 0)`;
        const snapshot = await createRecordSnapshot({
          baseId: fixture.baseId,
          tableId: fixture.tableId,
          recordId: fixture.recordId,
          actorId: fixture.actorId,
          canReadTable: async () => true,
        });
        if (!snapshot.ok) throw snapshot.error;
        await sql`UPDATE grids.records SET data = ${{ [relatedField]: "New related value" }}::jsonb WHERE id = ${relatedRecord}::uuid`;
        const [field] = await sql<Array<{ short_id: string }>>`SELECT short_id FROM grids.fields WHERE id = ${fixture.nameFieldId}::uuid`;
        if (!field) throw new Error("Missing field");
        const source = {
          snapshots: [snapshot.data.shortId],
          columns: [{ key: "name", type: "text", path: ["root", "data", field.short_id] }],
        };
        await sql`UPDATE grids.records SET data = data || ${{ [fixture.nameFieldId]: "New live name" }}::jsonb WHERE id = ${fixture.recordId}::uuid`;
        const denied = await captureWorkflowRecordSource(
          { source, baseId: fixture.baseId, capturedAt: new Date().toISOString(), canReadTable: async () => false },
          sql,
        );
        expect(denied.ok).toBe(false);
        const captured = await captureWorkflowRecordSource(
          { source, baseId: fixture.baseId, capturedAt: new Date().toISOString(), canReadTable: async () => true },
          sql,
        );
        if (!captured.ok) throw captured.error;
        expect(captured.data.payload.rows).toEqual([{ name: "Draft task" }]);
        expect(captured.data.payload.tableIds).toEqual([fixture.tableId, relatedTable].sort());
        expect(captured.data.payload.source).toEqual({ kind: "recordSnapshots", ids: [snapshot.data.shortId] });
        const graphSource = { ...source, columns: [{ key: "graph", type: "json", path: ["graph", "records"] }] };
        const visible = await captureWorkflowRecordSource(
          { source: graphSource, baseId: fixture.baseId, capturedAt: new Date().toISOString(), canReadTable: async () => true },
          sql,
        );
        if (!visible.ok) throw visible.error;
        expect(JSON.stringify(visible.data.payload.rows)).toContain("Historical related secret");
        expect(JSON.stringify(visible.data.payload.rows)).not.toContain("New related value");
        expect(JSON.stringify(visible.data.payload.rows)).not.toContain(relatedRecord);
        const redacted = await captureWorkflowRecordSource(
          {
            source: graphSource,
            baseId: fixture.baseId,
            capturedAt: new Date().toISOString(),
            canReadTable: async ({ tableId }) => tableId === fixture.tableId,
          },
          sql,
        );
        if (!redacted.ok) throw redacted.error;
        expect(JSON.stringify(redacted.data.payload.rows)).not.toContain("Historical related secret");
        expect(JSON.stringify(redacted.data.payload.rows)).not.toContain(relatedRecord);
        expect(redacted.data.payload.tableIds).toEqual([fixture.tableId]);
        const compiled = await compileAndBindGridsWorkflowSource(
          `steps:
  - generateDocument:
      data:
        snapshots: [${snapshot.data.shortId}]
        columns: [{ key: name, type: text, path: [root, data, ${field.short_id}] }]
      output: { kind: json }
`,
          await loadWorkflowCatalog(fixture.baseId),
        );
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
        const run = await queueRun(fixture, { plan: compiled.plan });
        expect(await drive(run)).toBe("succeeded");
        const [document] = await sql<Array<{ id: string }>>`SELECT id::text FROM grids.documents WHERE workflow_run_id = ${run}::uuid`;
        if (!document) throw new Error("Missing export");
        const content = await readDocumentArtifact(document.id, "json");
        if (!content.ok) throw content.error;
        expect(JSON.parse(new TextDecoder().decode(content.data.bytes))).toEqual([{ name: "Draft task" }]);
      } finally {
        await cleanupFixture(fixture);
      }
    },
    30000,
  );

  postgresTest(
    "generate then export a document snapshot is plannable without querying placeholder IDs",
    async () => {
      const fixture = createFixture();
      try {
        await insertFixture(fixture);
        const compiled = await compileAndBindGridsWorkflowSource(
          `steps:
  - generateDocument:
      data:
        columns: [{ key: amount, type: decimal }]
        rows: [{ amount: "12.30" }]
      output: { kind: json }
      saveAs: source
  - generateDocument:
      data:
        documents: ["\${{ source.shortId }}"]
        columns: [{ key: number, type: text, path: [number] }]
      output: { kind: json }
`,
          await loadWorkflowCatalog(fixture.baseId),
        );
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
        const dry = await queueRun(fixture, { plan: compiled.plan, mode: "dryRun" });
        expect(await drive(dry, "dryRun")).toBe("succeeded");
        expect(await sql`SELECT id FROM grids.workflow_query_data WHERE run_id = ${dry}::uuid`).toHaveLength(0);
        expect(await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${dry}::uuid`).toHaveLength(0);
        const run = await queueRun(fixture, { plan: compiled.plan });
        expect(await drive(run)).toBe("succeeded");
        const documents = await sql<
          Array<{ id: string; document_number: string }>
        >`SELECT id::text, document_number FROM grids.documents WHERE workflow_run_id = ${run}::uuid ORDER BY created_at`;
        expect(documents).toHaveLength(2);
        const exported = documents[1];
        if (!exported) throw new Error("Missing export");
        const content = await readDocumentArtifact(exported.id, "json");
        if (!content.ok) throw content.error;
        expect(JSON.parse(new TextDecoder().decode(content.data.bytes))).toEqual([{ number: documents[0]?.document_number }]);
      } finally {
        await cleanupFixture(fixture);
      }
    },
    30000,
  );

  postgresTest(
    "typed workflow values generate an exact immutable document and survive replay without GQL",
    async () => {
      const fixture = createFixture();
      try {
        await insertFixture(fixture);
        const compiled = await compileAndBindGridsWorkflowSource(
          `inputs:
  amount:
    type: text
  approved:
    type: boolean
steps:
  - generateDocument:
      data:
        columns:
          - { key: amount, type: decimal }
          - { key: approved, type: boolean }
        rows:
          - amount: "\${{ inputs.amount }}"
            approved: "\${{ inputs.approved }}"
      output: { kind: json }
`,
          await loadWorkflowCatalog(fixture.baseId),
        );
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
        const inputs = { amount: "9007199254740993.01", approved: true };
        const dry = await queueRun(fixture, { plan: compiled.plan, mode: "dryRun", inputs });
        expect(await drive(dry, "dryRun")).toBe("succeeded");
        expect(await sql`SELECT id FROM grids.workflow_query_data WHERE run_id = ${dry}::uuid`).toHaveLength(0);
        const runId = await queueRun(fixture, { plan: compiled.plan, inputs });
        expect(await drive(runId)).toBe("succeeded");
        const documents = await sql<Array<{ id: string }>>`SELECT id::text FROM grids.documents WHERE workflow_run_id = ${runId}::uuid`;
        expect(documents).toHaveLength(1);
        const document = documents[0];
        if (!document) throw new Error("Missing document");
        const content = await readDocumentArtifact(document.id, "json");
        if (!content.ok) throw content.error;
        expect(JSON.parse(new TextDecoder().decode(content.data.bytes))).toEqual([inputs]);
        const frozen = await sql`SELECT * FROM grids.workflow_query_data WHERE run_id = ${runId}::uuid`;
        expect(frozen).toHaveLength(1);
        expect(JSON.stringify(frozen)).toContain('"kind":"values"');
        await reopenForReplay(runId);
        expect(await drive(runId)).toBe("succeeded");
        expect(await sql`SELECT * FROM grids.workflow_query_data WHERE run_id = ${runId}::uuid`).toEqual(frozen);
        expect(await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${runId}::uuid`).toHaveLength(1);
        const [original] = await sql<
          Array<{ short_id: string; document_number: string }>
        >`SELECT short_id, document_number FROM grids.documents WHERE id = ${document.id}::uuid`;
        if (!original) throw new Error("Missing source document");
        const snapshotSource = { documents: [original.short_id], columns: [{ key: "number", type: "text", path: ["number"] }] };
        const foreign = await captureWorkflowDocumentSource(
          { source: snapshotSource, baseId: uuid(), capturedAt: new Date().toISOString() },
          sql,
        );
        expect(foreign.ok).toBe(false);
        if (foreign.ok) throw new Error("Cross-base snapshot leaked");
        expect(foreign.error.code).toBe("NOT_FOUND");
        const missing = await captureWorkflowDocumentSource(
          {
            source: { ...snapshotSource, documents: [original.short_id, "ZZZZZZ"] },
            baseId: fixture.baseId,
            capturedAt: new Date().toISOString(),
          },
          sql,
        );
        expect(missing.ok).toBe(false);
        const snapshotPlan = await compileAndBindGridsWorkflowSource(
          `steps:
  - generateDocument:
      data:
        documents: [${original.short_id}]
        columns: [{ key: number, type: text, path: [number] }]
      output: { kind: json }
`,
          await loadWorkflowCatalog(fixture.baseId),
        );
        if (!snapshotPlan.ok) throw new Error(JSON.stringify(snapshotPlan.diagnostics));
        const snapshotRun = await queueRun(fixture, { plan: snapshotPlan.plan });
        expect(await drive(snapshotRun)).toBe("succeeded");
        const [exported] = await sql<
          Array<{ id: string }>
        >`SELECT id::text FROM grids.documents WHERE workflow_run_id = ${snapshotRun}::uuid`;
        if (!exported) throw new Error("Missing snapshot export");
        const snapshotContent = await readDocumentArtifact(exported.id, "json");
        if (!snapshotContent.ok) throw snapshotContent.error;
        expect(JSON.parse(new TextDecoder().decode(snapshotContent.data.bytes))).toEqual([{ number: original.document_number }]);
        await reopenForReplay(snapshotRun);
        expect(await drive(snapshotRun)).toBe("succeeded");
        expect(await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${snapshotRun}::uuid`).toHaveLength(1);
      } finally {
        await cleanupFixture(fixture);
      }
    },
    30000,
  );

  postgresTest(
    "expense payment starter rejects drafts and exports finalized records through real GQL",
    async () => {
      const fixture = createFixture();
      try {
        await insertFixture(fixture);
        const fields = {
          businessId: { id: uuid(), shortId: shortId("F"), value: "AE-2026-001", type: "text" },
          amount: { id: uuid(), shortId: shortId("F"), value: "12.30", type: "number" },
          creditorName: { id: uuid(), shortId: shortId("F"), value: "Example Payee", type: "text" },
          creditorIban: { id: uuid(), shortId: shortId("F"), value: "DE89370400440532013000", type: "text" },
          remittance: { id: uuid(), shortId: shortId("F"), value: "Expense reimbursement", type: "text" },
        };
        for (const [key, field] of Object.entries(fields)) {
          await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, required, unique_constraint)
          VALUES (${field.id}::uuid, ${field.shortId}, ${fixture.tableId}::uuid, ${key}, ${field.type}, '{}'::jsonb, true, ${key === "businessId"})`;
        }
        await sql`UPDATE grids.records SET data = data || ${Object.fromEntries(Object.values(fields).map((field) => [field.id, field.value]))}::jsonb WHERE id = ${fixture.recordId}::uuid`;
        const history = await enableDurableHistory(fixture.tableId, fixture.actorId);
        if (!history.ok) throw history.error;
        const activation = await enableFinalization(fixture.tableId, { mode: "direct" }, fixture.actorId);
        if (!activation.ok) throw activation.error;
        const [table] = await sql<Array<{ short_id: string }>>`SELECT short_id FROM grids.tables WHERE id = ${fixture.tableId}::uuid`;
        if (!table) throw new Error("Missing table");
        const source = expensePaymentStarterSource({
          tableId: table.short_id,
          fieldReferences: Object.keys(fields),
          fields: {
            businessId: fields.businessId.shortId,
            amount: fields.amount.shortId,
            creditorName: fields.creditorName.shortId,
            creditorIban: fields.creditorIban.shortId,
            remittance: fields.remittance.shortId,
          },
          header: {
            destinationKey: "reimbursements",
            debtorName: "Example",
            debtorIban: "DE89370400440532013000",
            executionDate: "2026-09-15",
          },
          notFinalizedMessage: "Finalize all selected reimbursements first.",
        });
        const catalog = await loadWorkflowCatalog(fixture.baseId);
        const compiled = await compileAndBindGridsWorkflowSource(source, catalog, async (query, values) => {
          const parsed = parseGridsQueryDsl(query);
          if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
          const context = await buildTrustedGqlResolverContext({
            baseId: fixture.baseId,
            ast: parsed.ast,
            purpose: "workflow-query",
            client: sql,
          });
          const canonical = canonicalizeDslQuery(parsed.ast, context, values);
          if (!canonical.ok) throw new Error(JSON.stringify(canonical));
          return workflowQueryBinder(fixture.baseId, catalog)(query, values);
        });
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
        const inputs = { records: [{ kind: "record", tableId: fixture.tableId, recordId: fixture.recordId }] };
        const draftRun = await queueRun(fixture, { plan: compiled.plan, inputs });
        expect(await drive(draftRun)).toBe("failed");
        expect(await getWorkflowDocumentConfirmation(draftRun)).toBeUndefined();
        expect(await sql`SELECT id FROM grids.document_issuances WHERE base_id = ${fixture.baseId}::uuid`).toHaveLength(0);
        const finalized = await finalizeRecord({
          tableId: fixture.tableId,
          recordId: fixture.recordId,
          actorId: fixture.actorId,
          origin: "direct",
        });
        if (!finalized.ok) throw finalized.error;
        const runId = await queueRun(fixture, { plan: compiled.plan, inputs });
        await runGridsWorkflowRun(runId);
        expect((await runRow(runId)).state).toBe("waiting");
        const pending = await getWorkflowDocumentConfirmation(runId);
        const scope = await getWorkflowRunScope(runId);
        if (!pending || !scope) throw new Error(JSON.stringify(await stepRuns(runId)));
        const request = {
          baseId: fixture.baseId,
          runId,
          receiptId: pending.receiptId,
          actor: documentActorForScope(scope),
          authorize: async () => {},
        };
        const preview = await documentIssuanceService.inspectQueryDocumentConfirmation(request);
        if (!preview.ok) throw preview.error;
        expect(preview.data.input.rows[0]).toMatchObject({ businessId: "AE-2026-001", amount: "12.30" });
        const confirmed = await documentIssuanceService.confirmQueryDocument({ ...request, sha256: pending.sha256 });
        if (!confirmed.ok) throw confirmed.error;
        expect(await drive(runId)).toBe("succeeded");
        const [document] = await sql<Array<{ id: string }>>`SELECT id FROM grids.documents WHERE workflow_run_id = ${runId}::uuid`;
        if (!document) throw new Error("Missing export");
        const artifact = await documentIssuanceService.getDocumentArtifact(document.id, "xml");
        if (!artifact.ok) throw artifact.error;
        expect(new TextDecoder().decode(artifact.data.bytes)).toContain('<InstdAmt Ccy="EUR">12.30</InstdAmt>');
      } finally {
        await cleanupFixture(fixture);
      }
    },
    30_000,
  );

  postgresTest(
    "financial query combines two cost centers but restricts confirmation and aggregate download",
    async () => {
      const fixture = createFixture();
      try {
        await insertFixture(fixture);
        await sql`UPDATE grids.records SET data = data || ${{ [fixture.statusFieldId]: "COST-A" }}::jsonb WHERE id = ${fixture.recordId}::uuid`;
        await sql`INSERT INTO grids.records (id, short_id, table_id, data, created_by, updated_by)
          VALUES (${uuid()}::uuid, ${shortId("R")}, ${fixture.tableId}::uuid,
            ${{ [fixture.assetIdFieldId]: "ITEM-0002", [fixture.nameFieldId]: "Cost B payee", [fixture.statusFieldId]: "COST-B" }}::jsonb,
            ${fixture.actorId}::uuid, ${fixture.actorId}::uuid)`;
        const catalog = await loadWorkflowCatalog(fixture.baseId);
        const source = [
          "inputs:",
          "  executionDate:",
          "    type: date",
          "steps:",
          "  - query:",
          "      source: |",
          "        from table Tasks",
          "        select Name as payee, Status as business, formula('12.30') as amount, formula('DE89370400440532013000') as iban, Status as payment, Status as purpose",
          "        sort Status asc",
          "      saveAs: report",
          "  - generateDocument:",
          "      data: report",
          "      output:",
          "        kind: sepa-xml",
          "        version: 1",
          "        header:",
          "          destinationKey: main-bank",
          "          debtorName: Example",
          "          debtorIban: DE89370400440532013000",
          "          executionDate: '${{ inputs.executionDate }}'",
          "        mapping:",
          "          businessId: business",
          "          amount: amount",
          "          endToEndId: payment",
          "          creditorName: payee",
          "          creditorIban: iban",
          "          remittance: purpose",
          "      saveAs: paymentFile",
        ].join("\n");
        const compiled = await compileAndBindGridsWorkflowSource(source, catalog, workflowQueryBinder(fixture.baseId, catalog));
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
        const inputs = { executionDate: "2000-01-01" };
        const dry = await queueRun(fixture, { plan: compiled.plan, inputs, mode: "dryRun" });
        expect(await drive(dry, "dryRun")).toBe("succeeded");
        expect(await sql`SELECT id FROM grids.document_issuances WHERE base_id = ${fixture.baseId}::uuid`).toHaveLength(0);
        const runId = await queueRun(fixture, { plan: compiled.plan, inputs });
        await runGridsWorkflowRun(runId);
        expect((await runRow(runId)).state).toBe("waiting");
        expect(await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${runId}::uuid`).toHaveLength(0);
        const pending = await getWorkflowDocumentConfirmation(runId);
        if (!pending) throw new Error(JSON.stringify(await stepRuns(runId)));
        const scope = await getWorkflowRunScope(runId);
        if (!scope) throw new Error("Missing run scope");
        const authorizeRun = (id: string) => async (tableIds: readonly string[], db: SQL) => {
          const current = await getWorkflowRunScope(id, db);
          if (!current || !(await canExecuteRun(current, db))) throw new Error("Run access denied");
          for (const tableId of tableIds) {
            if (!(await canAccessWorkflowRunTable(current, tableId, "read", db))) throw new Error("Source access denied");
          }
        };
        const request = {
          baseId: fixture.baseId,
          runId,
          receiptId: pending.receiptId,
          actor: documentActorForScope(scope),
          authorize: authorizeRun(runId),
        };
        const preview = await documentIssuanceService.inspectQueryDocumentConfirmation(request);
        if (!preview.ok) throw preview.error;
        if (preview.data.kind !== "sepa-xml") throw new Error("Expected SEPA preview");
        expect(preview.data.version).toBe(1);
        expect(preview.data.input.rows[0]?.amount).toBe("12.30");
        expect(preview.data.input.rows[0]?.creditorName).toBe("Draft task");
        expect(preview.data.input.rows.map((row) => row.remittance)).toEqual(["COST-A", "COST-B"]);
        const apiFor = (userId: string) => {
          const user: User = {
            id: userId,
            uid: `workflow-action-${userId}`,
            roles: ["user"],
            provider: "local",
            profile: "user",
            givenname: "Workflow",
            sn: "Actor",
            displayName: "Workflow Actor",
            mail: "workflow@example.test",
            avatarHash: null,
            accountExpires: null,
            lastLoginLocal: null,
            memberofGroup: [],
            memberofGroupIds: [],
            manages: [],
            managesGroupIds: [],
            ipa: null,
          };
          return new Hono<AuthContext>()
            .use("*", async (c, next) => {
              c.set("actor", { kind: "user", user });
              c.set("user", user);
              c.set("accessSubject", { type: "user", userId });
              await next();
            })
            .route("/", createWorkflowDocumentConfirmationRoutes())
            .route("/", createWorkflowRunRoutes())
            .route("/documents", createDocumentResourceRoutes({ requireAuthenticated: async (_c, next) => next() }));
        };
        const [publicRun] = await sql<
          Array<{ short_id: string }>
        >`SELECT short_id FROM grids.workflow_run_profile WHERE run_id = ${runId}::uuid`;
        if (!publicRun) throw new Error("Missing public run");
        const path = `/runs/${publicRun.short_id}/document-confirmations/${pending.receiptId}`;
        const api = apiFor(fixture.actorId);
        const runPath = `/runs/${publicRun.short_id}`;
        const waitingResponse = await api.request(runPath);
        expect(waitingResponse.status).toBe(200);
        expect(PublicGridsWorkflowRunSchema.parse(await waitingResponse.json()).documentConfirmation).toEqual(pending);
        const hiddenRun = await apiFor(uuid()).request(runPath);
        expect(hiddenRun.status).toBe(403);
        expect(await hiddenRun.text()).not.toContain(pending.receiptId);
        const response = await api.request(path);
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(FinancialExportPreviewSchema.parse(await response.json())).toEqual({
          ...preview.data,
          timeZone: expect.any(String),
          warnings: [{ code: "pastExecutionDate", message: expect.stringContaining("past") }],
        });
        const denied = await apiFor(uuid()).request(path);
        expect(denied.status).toBe(403);
        expect(await denied.text()).not.toContain("Draft task");
        const confirm = (sha256: string) =>
          api.request(`${path}/confirm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sha256 }),
          });
        expect((await confirm("0".repeat(64))).status).toBe(409);
        expect((await runRow(runId)).state).toBe("waiting");
        await sql`UPDATE grids.records SET data = data || ${{ [fixture.nameFieldId]: "Changed after preview" }}::jsonb WHERE id = ${fixture.recordId}::uuid`;
        const confirmed = await confirm(pending.sha256);
        expect(confirmed.status).toBe(200);
        expect(await confirmed.json()).toEqual({ confirmed: true });
        expect(await drive(runId)).toBe("succeeded");
        const documents = await sql<
          Array<{ id: string; short_id: string }>
        >`SELECT id::text, short_id FROM grids.documents WHERE workflow_run_id = ${runId}::uuid`;
        expect(documents).toHaveLength(1);
        const document = documents[0];
        if (!document) throw new Error("Missing SEPA document");
        const file = await readDocumentArtifact(document.id, "xml");
        if (!file.ok) throw file.error;
        const xml = new TextDecoder().decode(file.data.bytes);
        expect(xml).toContain("Draft task");
        expect(xml).not.toContain("Changed after preview");
        expect(xml).toContain('<InstdAmt Ccy="EUR">12.30</InstdAmt>');
        expect(xml).toContain("Cost B payee");
        expect(xml).toContain("<CtrlSum>24.60</CtrlSum>");
        const downloadPath = `/documents/${document.short_id}/download`;
        const download = await api.request(downloadPath);
        expect(download.status).toBe(200);
        expect(await download.text()).toBe(xml);
        const deniedDownload = await apiFor(uuid()).request(downloadPath);
        expect(deniedDownload.status).toBe(403);
        expect(await deniedDownload.text()).not.toContain("Cost B payee");
        expect(await getWorkflowDocumentConfirmation(runId)).toBeUndefined();
        const completedResponse = await api.request(runPath);
        expect(completedResponse.status).toBe(200);
        expect(PublicGridsWorkflowRunSchema.parse(await completedResponse.json()).documentConfirmation).toBeUndefined();
        await reopenForReplay(runId);
        expect(await drive(runId)).toBe("succeeded");
        expect(await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${runId}::uuid`).toHaveLength(1);
        // A new run and workflow revision are not permission to pay the same
        // business event again. The real action must enforce the shared claim.
        const duplicateRun = await queueRun(fixture, { plan: compiled.plan, inputs });
        await runGridsWorkflowRun(duplicateRun);
        expect((await runRow(duplicateRun)).state).toBe("waiting");
        const duplicatePending = await getWorkflowDocumentConfirmation(duplicateRun);
        if (!duplicatePending) throw new Error("Missing duplicate export preview");
        const duplicateConfirmation = await documentIssuanceService.confirmQueryDocument({
          ...request,
          runId: duplicateRun,
          ...duplicatePending,
          authorize: authorizeRun(duplicateRun),
        });
        if (!duplicateConfirmation.ok) throw duplicateConfirmation.error;
        expect(await drive(duplicateRun)).toBe("failed");
        expect(await sql`SELECT id FROM grids.documents WHERE base_id = ${fixture.baseId}::uuid`).toHaveLength(1);
        expect(await sql`SELECT business_id FROM grids.document_export_claims WHERE base_id = ${fixture.baseId}::uuid`).toHaveLength(2);
      } finally {
        await cleanupFixture(fixture);
      }
    },
    30000,
  );

  postgresTest(
    "query-derived source versions reject changes before financial confirmation",
    async () => {
      const fixture = createFixture();
      try {
        await insertFixture(fixture);
        const catalog = await loadWorkflowCatalog(fixture.baseId);
        const compiled = await compileAndBindGridsWorkflowSource(
          `steps:
  - query:
      source: |
        from table Tasks
        select Name as payee, formula('expense-1') as business, formula('12.30') as amount, formula('DE89370400440532013000') as iban, formula('AE-1') as payment, formula('Expenses') as purpose
      saveAs: report
  - generateDocument:
      data: report
      sourceVersions: data
      output:
        kind: sepa-xml
        version: 1
        header: {destinationKey: main-bank, debtorName: Example, debtorIban: DE89370400440532013000, executionDate: '2026-09-14'}
        mapping: {businessId: business, amount: amount, endToEndId: payment, creditorName: payee, creditorIban: iban, remittance: purpose}
`,
          catalog,
          workflowQueryBinder(fixture.baseId, catalog),
        );
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
        const dry = await queueRun(fixture, { plan: compiled.plan, mode: "dryRun" });
        expect(await drive(dry, "dryRun")).toBe("succeeded");
        const runId = await queueRun(fixture, { plan: compiled.plan });
        await runGridsWorkflowRun(runId);
        expect((await runRow(runId)).state).toBe("waiting");
        const pending = await getWorkflowDocumentConfirmation(runId);
        const scope = await getWorkflowRunScope(runId);
        if (!pending || !scope) throw new Error(JSON.stringify(await stepRuns(runId)));
        const request = { baseId: fixture.baseId, runId, ...pending, actor: documentActorForScope(scope), authorize: async () => {} };
        expect((await documentIssuanceService.inspectQueryDocumentConfirmation(request)).ok).toBe(true);
        await sql`UPDATE grids.records SET version = version + 1 WHERE id = ${fixture.recordId}::uuid`;
        const changed = await documentIssuanceService.confirmQueryDocument(request);
        expect(changed.ok).toBe(false);
        if (!changed.ok) expect(changed.error.code).toBe("CONFLICT");
        expect(await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${runId}::uuid`).toHaveLength(0);
      } finally {
        await cleanupFixture(fixture);
      }
    },
    30000,
  );

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

  postgresTest("workflow list writes retain exact cells and reject invalid atomic changes", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      const listId = uuid();
      const config = {
        fields: [
          { id: "Label1", name: "Description", type: "text", required: true },
          { id: "Amount", name: "Amount", type: "number", config: { decimalPlaces: 2 } },
          { id: "Total1", name: "Total", type: "number", config: { decimalPlaces: 2 }, formula: { expression: "Amount * 2" } },
        ],
      };
      await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config)
        VALUES (${listId}::uuid, ${shortId("F")}, ${fixture.tableId}::uuid, 'Items', 'object_list', ${config}::jsonb)`;
      const items = [{ Label1: "Consulting", Amount: "9007199254740993.25" }];
      const expected = [{ ...items[0], Total1: "18014398509481986.50" }];
      const inputs = { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } };
      const catalog = await loadWorkflowCatalog(fixture.baseId);
      const planFor = async (steps: WorkflowJsonValue[]) => {
        const compiled = await compileAndBindGridsWorkflowSource(
          JSON.stringify({
            inputs: { record: { type: "record", table: "Tasks", required: true } },
            steps,
          }),
          catalog,
        );
        if (!compiled.ok) throw new Error(compiled.diagnostics.map((issue) => issue.message).join("; "));
        return compiled.plan;
      };
      const createRun = await queueRun(fixture, {
        plan: await planFor([{ createRecord: { table: "Tasks", values: { Items: items } } }]),
        inputs,
      });
      expect(await drive(createRun)).toBe("succeeded");
      const [created] = await sql<Array<{ data: Record<string, unknown> }>>`
        SELECT data FROM grids.records WHERE table_id = ${fixture.tableId}::uuid AND id <> ${fixture.recordId}::uuid`;
      expect(created?.data[listId]).toEqual(expected);
      const updateRun = await queueRun(fixture, {
        plan: await planFor([{ updateRecord: { record: "inputs.record", set: { Items: items } } }]),
        inputs,
      });
      expect(await drive(updateRun)).toBe("succeeded");
      expect((await recordData(fixture.recordId))[listId]).toEqual(expected);
      for (const invalid of [[{ Label1: "", Amount: "1" }], [{ Label1: "Forged", Amount: "1", Total1: "999" }]]) {
        const run = await queueRun(fixture, {
          plan: await planFor([
            {
              atomicRecords: {
                locks: ["inputs.record"],
                checks: [{ table: "Tasks", where: [{ field: "Status", op: "equals", value: "Open" }], assert: "notEmpty" }],
                changes: [
                  { updateRecord: { record: "inputs.record", set: { Status: "Must roll back" } } },
                  { updateRecord: { record: "inputs.record", set: { Items: invalid } } },
                ],
              },
            },
          ]),
          inputs,
        });
        expect(await drive(run)).toBe("failed");
        expect((await runRow(run)).error).toMatchObject({ code: "BAD_INPUT", message: expect.stringContaining("Row 1") });
        const data = await recordData(fixture.recordId);
        expect(data[fixture.statusFieldId]).toBe("Open");
        expect(data[listId]).toEqual(expected);
      }
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
      expect(await drive(updateRunId)).toBe("succeeded");
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

      expect({ state: await drive(atomicRunId), error: (await runRow(atomicRunId)).error }).toEqual({
        state: "succeeded",
        error: null,
      });

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
      const { create: createField, update: updateField } = await import("./fields");
      const columns = [
        { id: "Amount", name: "Amount", type: "number", config: { decimalPlaces: 2 } },
        { id: "Total1", name: "Total", type: "number", config: { decimalPlaces: 2 }, formula: { expression: "Amount * 2" } },
      ];
      const list = await createField(
        { tableId: fixture.tableId, name: "Items", type: "object_list", config: { fields: columns } },
        fixture.actorId,
      );
      if (!list.ok) throw list.error;
      await sql`UPDATE grids.records SET data = data || ${{ [list.data.id]: [{ Amount: "0.10" }] }}::jsonb WHERE id = ${fixture.recordId}::uuid`;
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
      expect(finalized.data.data[list.data.id]).toEqual([{ Amount: "0.10", Total1: "0.20" }]);
      const changed = await updateField(
        list.data.id,
        {
          config: { fields: [columns[0], { ...columns[1], formula: { expression: "Amount * 3" } }] },
        },
        fixture.actorId,
      );
      if (!changed.ok) throw changed.error;
      const { allocateNumberInTransaction } = await import("./number-series");
      await sql.begin((client) => allocateNumberInTransaction({ client, owner: { kind: "field", id: fixture.assetIdFieldId } }));

      const runId = await queueRun(fixture, {
        plan: boundPlan(
          [
            actionStep(0, "createCorrectionDraft", {
              original: "inputs.original",
              typeField: "Document type",
              typeValue: "correction",
              originalField: "Corrects",
              copyFields: ["Name", "Status", "Metadata", "Items"],
            }),
          ],
          {
            "steps.0.createCorrectionDraft.typeField": fixture.correctionTypeFieldId,
            "steps.0.createCorrectionDraft.originalField": fixture.originalRelationFieldId,
            "steps.0.createCorrectionDraft.copyFields.0": fixture.nameFieldId,
            "steps.0.createCorrectionDraft.copyFields.1": fixture.statusFieldId,
            "steps.0.createCorrectionDraft.copyFields.2": fixture.jsonFieldId,
            "steps.0.createCorrectionDraft.copyFields.3": list.data.id,
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
      expect(draft?.data[list.data.id]).toEqual([{ Amount: "0.10", Total1: "0.30" }]);
      expect((await recordData(fixture.recordId))[list.data.id]).toEqual([{ Amount: "0.10", Total1: "0.20" }]);
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

  postgresTest("record-template generation rejects financial version guards in execution and dry run", async () => {
    const fixture = createFixture();
    try {
      await insertFixture(fixture);
      for (const mode of ["execute", "dryRun"] as const) {
        const runId = await queueRun(fixture, {
          mode,
          plan: boundPlan(
            [
              actionStep(0, "generateDocument", {
                template: "Task sheet",
                record: "inputs.record",
                sourceVersions: "data",
              }),
            ],
            { "steps.0.generateDocument.template": fixture.documentTemplateId },
          ),
          inputs: { record: { kind: "record", tableId: fixture.tableId, recordId: fixture.recordId } },
        });
        expect(await drive(runId, mode)).toBe("failed");
        expect((await stepRuns(runId))[0]?.outcome).toMatchObject(
          mode === "execute"
            ? { error: { code: "BAD_INPUT" } }
            : { state: "planned", output: null, issues: [{ reason: "The document request contains invalid JSON." }] },
        );
        expect(await sql`SELECT id FROM grids.documents WHERE workflow_run_id = ${runId}::uuid`).toHaveLength(0);
      }
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
