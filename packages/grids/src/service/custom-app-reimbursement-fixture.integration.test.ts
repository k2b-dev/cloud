import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { CustomAppDefinitionSchema } from "../custom-apps/contracts";
import { postgresTest } from "../integration-test-utils";
import { migrate } from "../migrate";
import { grantAccess, listBaseAccess, listCustomAppAccess } from "./access";
import { apply, compile, plan, publish } from "./custom-apps";
import { deleteTestWorkflowScope, insertTestWorkflow } from "./workflow-test-fixture";

const REIMBURSEMENT = {
  requesterAppPublicId: "r00101",
  reviewAppPublicId: "r00102",
  baseId: "11000000-0000-4000-8000-000000000001",
  requestTableId: "11000000-0000-4000-8000-000000000201",
  expenseTableId: "11000000-0000-4000-8000-000000000202",
  purposeFieldId: "11000000-0000-4000-8000-000000000301",
  statusFieldId: "11000000-0000-4000-8000-000000000302",
  requestRelationFieldId: "11000000-0000-4000-8000-000000000311",
  dateFieldId: "11000000-0000-4000-8000-000000000312",
  merchantFieldId: "11000000-0000-4000-8000-000000000313",
  descriptionFieldId: "11000000-0000-4000-8000-000000000314",
  amountFieldId: "11000000-0000-4000-8000-000000000315",
  receiptFieldId: "11000000-0000-4000-8000-000000000316",
  requestViewId: "11000000-0000-4000-8000-000000000401",
  requestFormId: "11000000-0000-4000-8000-000000000501",
  expenseFormId: "11000000-0000-4000-8000-000000000502",
  requesterGroupId: "11000000-0000-4000-8000-000000000701",
  financeGroupId: "11000000-0000-4000-8000-000000000702",
  approveWorkflowId: "11000000-0000-4000-8000-000000000801",
  approveLauncherId: "11000000-0000-4000-8000-000000000802",
  rejectWorkflowId: "11000000-0000-4000-8000-000000000803",
  rejectLauncherId: "11000000-0000-4000-8000-000000000804",
} as const;

const requesterPath = `${import.meta.dir}/../../docs/custom-apps/reimbursement-requests.yaml`;
const reviewPath = `${import.meta.dir}/../../docs/custom-apps/reimbursement-review.yaml`;

const loadDefinition = async (path: string) => CustomAppDefinitionSchema.parse(Bun.YAML.parse(await Bun.file(path).text()));

const cleanup = async (): Promise<void> => {
  await sql`DELETE FROM grids.bases WHERE id = ${REIMBURSEMENT.baseId}::uuid`;
  await deleteTestWorkflowScope(REIMBURSEMENT.baseId);
  await sql`
    DELETE FROM auth.access
    WHERE group_id IN (${REIMBURSEMENT.requesterGroupId}::uuid, ${REIMBURSEMENT.financeGroupId}::uuid)
  `;
  await sql`
    DELETE FROM auth.groups
    WHERE id IN (${REIMBURSEMENT.requesterGroupId}::uuid, ${REIMBURSEMENT.financeGroupId}::uuid)
  `;
};

const workflowPlan = (tableId: string) => ({
  schemaVersion: 2,
  languageId: "grids",
  languageVersion: 1,
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  catalogHash: "c".repeat(64),
  actionPolicies: {},
  inputs: [{ name: "request", type: "record", config: { required: true } }],
  triggers: [],
  steps: [],
  bindings: { "inputs.request.table": tableId },
});

const insertResources = async (): Promise<void> => {
  await sql`
    INSERT INTO auth.groups (id, cn, provider, name) VALUES
      (${REIMBURSEMENT.requesterGroupId}::uuid, 'custom-app-reimbursement-requesters', 'local', 'Reimbursement requesters'),
      (${REIMBURSEMENT.financeGroupId}::uuid, 'custom-app-reimbursement-finance', 'local', 'Reimbursement finance')
  `;
  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${REIMBURSEMENT.baseId}::uuid, 'r00001', 'Reimbursements')
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position) VALUES
      (${REIMBURSEMENT.requestTableId}::uuid, 'r00201', ${REIMBURSEMENT.baseId}::uuid, 'Reimbursement requests', 0),
      (${REIMBURSEMENT.expenseTableId}::uuid, 'r00202', ${REIMBURSEMENT.baseId}::uuid, 'Expenses', 1)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, required, position) VALUES
      (${REIMBURSEMENT.purposeFieldId}::uuid, 'r00301', ${REIMBURSEMENT.requestTableId}::uuid, 'Purpose', 'text', '{}'::jsonb, true, 0),
      (${REIMBURSEMENT.statusFieldId}::uuid, 'r00302', ${REIMBURSEMENT.requestTableId}::uuid, 'Status', 'select', ${{
        options: [
          { id: "pending", label: "Pending", color: "orange" },
          { id: "approved", label: "Approved", color: "green" },
          { id: "rejected", label: "Rejected", color: "red" },
        ],
        multiple: false,
        minSelected: 1,
        maxSelected: 1,
      }}::jsonb, true, 1),
      (${REIMBURSEMENT.requestRelationFieldId}::uuid, 'r00311', ${REIMBURSEMENT.expenseTableId}::uuid, 'Request', 'relation', ${{
        targetTableId: REIMBURSEMENT.requestTableId,
        multiple: false,
      }}::jsonb, true, 0),
      (${REIMBURSEMENT.dateFieldId}::uuid, 'r00312', ${REIMBURSEMENT.expenseTableId}::uuid, 'Date', 'date', '{}'::jsonb, true, 1),
      (${REIMBURSEMENT.merchantFieldId}::uuid, 'r00313', ${REIMBURSEMENT.expenseTableId}::uuid, 'Merchant', 'text', '{}'::jsonb, true, 2),
      (${REIMBURSEMENT.descriptionFieldId}::uuid, 'r00314', ${REIMBURSEMENT.expenseTableId}::uuid, 'Description', 'longtext', '{}'::jsonb, false, 3),
      (${REIMBURSEMENT.amountFieldId}::uuid, 'r00315', ${REIMBURSEMENT.expenseTableId}::uuid, 'Amount', 'number', ${{ format: "currency", currency: "EUR" }}::jsonb, true, 4),
      (${REIMBURSEMENT.receiptFieldId}::uuid, 'r00316', ${REIMBURSEMENT.expenseTableId}::uuid, 'Receipt', 'file', ${{
        accept: ["application/pdf", "image/*"],
        maxFiles: 1,
      }}::jsonb, false, 5)
  `;
  await sql`
    INSERT INTO grids.views (id, short_id, table_id, name, source)
    VALUES (
      ${REIMBURSEMENT.requestViewId}::uuid,
      'r00401',
      ${REIMBURSEMENT.requestTableId}::uuid,
      'My reimbursement requests',
      ${`from table {r00201}\nwhere record.createdBy = @auth.id`}
    )
  `;
  await sql`
    INSERT INTO grids.forms (id, short_id, table_id, name, config, is_active, position) VALUES
      (
        ${REIMBURSEMENT.requestFormId}::uuid,
        'r00501',
        ${REIMBURSEMENT.requestTableId}::uuid,
        'Reimbursement request',
        ${{
          fields: [
            { kind: "user_input", fieldId: REIMBURSEMENT.purposeFieldId, required: true },
            { kind: "form_value", fieldId: REIMBURSEMENT.statusFieldId, value: ["pending"] },
          ],
        }}::jsonb,
        true,
        0
      ),
      (
        ${REIMBURSEMENT.expenseFormId}::uuid,
        'r00502',
        ${REIMBURSEMENT.expenseTableId}::uuid,
        'Expense',
        ${{
          fields: [
            { kind: "user_input", fieldId: REIMBURSEMENT.requestRelationFieldId, required: true },
            { kind: "user_input", fieldId: REIMBURSEMENT.dateFieldId, required: true },
            { kind: "user_input", fieldId: REIMBURSEMENT.merchantFieldId, required: true },
            { kind: "user_input", fieldId: REIMBURSEMENT.descriptionFieldId },
            { kind: "user_input", fieldId: REIMBURSEMENT.amountFieldId, required: true },
          ],
        }}::jsonb,
        true,
        1
      )
  `;
  for (const workflow of [
    { id: REIMBURSEMENT.approveWorkflowId, name: "Approve reimbursement" },
    { id: REIMBURSEMENT.rejectWorkflowId, name: "Reject reimbursement" },
  ]) {
    await insertTestWorkflow({
      baseId: REIMBURSEMENT.baseId,
      id: workflow.id,
      name: workflow.name,
      enabled: true,
      plan: workflowPlan(REIMBURSEMENT.requestTableId),
    });
  }
  await sql`
    INSERT INTO grids.workflow_launchers (
      id, short_id, base_id, workflow_id, name, kind, config, enabled, validated_revision, diagnostics
    ) VALUES
      (${REIMBURSEMENT.approveLauncherId}::uuid, 'r00802', ${REIMBURSEMENT.baseId}::uuid, ${REIMBURSEMENT.approveWorkflowId}::uuid, 'Approve reimbursement', 'customApp', ${{ kind: "customApp", inputMode: "prompt" }}::jsonb, true, 1, '[]'::jsonb),
      (${REIMBURSEMENT.rejectLauncherId}::uuid, 'r00804', ${REIMBURSEMENT.baseId}::uuid, ${REIMBURSEMENT.rejectWorkflowId}::uuid, 'Reject reimbursement', 'customApp', ${{ kind: "customApp", inputMode: "prompt" }}::jsonb, true, 1, '[]'::jsonb)
  `;
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("Reimbursement Grids App Golden fixtures", () => {
  test("keeps both definitions structurally valid", async () => {
    expect((await loadDefinition(requesterPath)).id).toBe(REIMBURSEMENT.requesterAppPublicId);
    expect((await loadDefinition(reviewPath)).id).toBe(REIMBURSEMENT.reviewAppPublicId);
  });

  postgresTest("applies, publishes, and grants the requester and finance compositions", async () => {
    await cleanup();
    try {
      await insertResources();
      const requester = await loadDefinition(requesterPath);
      const review = await loadDefinition(reviewPath);
      const requesterValidation = await compile(requester);
      expect(requesterValidation.ok).toBe(true);
      if (!requesterValidation.ok) throw new Error(requesterValidation.diagnostics.map((item) => item.message).join("; "));
      expect(requesterValidation.compiled.capabilities.records).toContainEqual(
        expect.objectContaining({
          pageId: "expense",
          tableId: REIMBURSEMENT.expenseTableId,
          editableFieldIds: expect.arrayContaining([REIMBURSEMENT.receiptFieldId]),
        }),
      );
      expect(requesterValidation.compiled.capabilities.forms).toHaveLength(2);
      expect(await plan(requester)).toEqual({ valid: true, diagnostics: [], action: "create", changes: ["app"] });
      const requesterCreated = await apply(requester);
      if (!requesterCreated.ok) throw new Error(requesterCreated.error.message);
      expect((await publish(requesterCreated.data.id)).ok).toBe(true);

      const reviewValidation = await compile(review);
      expect(reviewValidation.ok).toBe(true);
      if (!reviewValidation.ok) throw new Error(reviewValidation.diagnostics.map((item) => item.message).join("; "));
      expect(reviewValidation.compiled.capabilities.workflowLaunchers).toHaveLength(2);
      const reviewCreated = await apply(review);
      if (!reviewCreated.ok) throw new Error(reviewCreated.error.message);
      expect((await publish(reviewCreated.data.id)).ok).toBe(true);

      for (const grant of [
        {
          resourceType: "customApp",
          resourceId: requesterCreated.data.id,
          principal: { type: "group", groupId: REIMBURSEMENT.requesterGroupId },
          permission: "read",
        },
        {
          resourceType: "customApp",
          resourceId: reviewCreated.data.id,
          principal: { type: "group", groupId: REIMBURSEMENT.financeGroupId },
          permission: "read",
        },
        {
          resourceType: "base",
          resourceId: REIMBURSEMENT.baseId,
          principal: { type: "group", groupId: REIMBURSEMENT.financeGroupId },
          permission: "write",
        },
      ] satisfies Array<Parameters<typeof grantAccess>[0]>) {
        expect((await grantAccess(grant)).ok).toBe(true);
      }
      expect(await listCustomAppAccess(requesterCreated.data.id)).toHaveLength(1);
      expect(await listCustomAppAccess(reviewCreated.data.id)).toHaveLength(1);
      expect(await listBaseAccess(REIMBURSEMENT.baseId)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});
