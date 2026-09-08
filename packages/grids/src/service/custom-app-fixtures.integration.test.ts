import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { CustomAppDefinitionSchema } from "../custom-apps/contracts";
import { customAppFormFieldHash } from "../custom-apps/form-capability";
import { customAppViewSourceHash } from "../custom-apps/insight-source";
import { postgresTest } from "../integration-test-utils";
import { migrate } from "../migrate";
import { grantAccess, listBaseAccess, listCustomAppAccess } from "./access";
import { apply, compile, get, plan, publish } from "./custom-apps";
import { deleteTestWorkflowScope, insertTestWorkflow } from "./workflow-test-fixture";

const CERTIFICATE = {
  appPublicId: "c00101",
  reviewAppPublicId: "c00102",
  baseId: "10000000-0000-4000-8000-000000000001",
  basePublicId: "c00001",
  tableId: "10000000-0000-4000-8000-000000000201",
  fieldIds: [
    "10000000-0000-4000-8000-000000000301",
    "10000000-0000-4000-8000-000000000302",
    "10000000-0000-4000-8000-000000000303",
    "10000000-0000-4000-8000-000000000304",
  ],
  viewId: "10000000-0000-4000-8000-000000000401",
  formId: "10000000-0000-4000-8000-000000000501",
  documentTemplateId: "10000000-0000-4000-8000-000000000601",
  requesterGroupId: "10000000-0000-4000-8000-000000000701",
  responsibleGroupId: "10000000-0000-4000-8000-000000000702",
  workflowId: "10000000-0000-4000-8000-000000000801",
  launcherId: "10000000-0000-4000-8000-000000000802",
} as const;

const certificateDefinitionPath = `${import.meta.dir}/../../docs/custom-apps/certificate-requests.yaml`;
const certificateReviewDefinitionPath = `${import.meta.dir}/../../docs/custom-apps/certificate-review.yaml`;

const loadCertificateDefinition = async () =>
  CustomAppDefinitionSchema.parse(Bun.YAML.parse(await Bun.file(certificateDefinitionPath).text()));
const loadCertificateReviewDefinition = async () =>
  CustomAppDefinitionSchema.parse(Bun.YAML.parse(await Bun.file(certificateReviewDefinitionPath).text()));

const cleanupCertificateFixture = async (): Promise<void> => {
  await sql`DELETE FROM grids.bases WHERE id = ${CERTIFICATE.baseId}::uuid`;
  await deleteTestWorkflowScope(CERTIFICATE.baseId);
  await sql`
    DELETE FROM auth.access
    WHERE group_id IN (${CERTIFICATE.requesterGroupId}::uuid, ${CERTIFICATE.responsibleGroupId}::uuid)
  `;
  await sql`
    DELETE FROM auth.groups
    WHERE id IN (${CERTIFICATE.requesterGroupId}::uuid, ${CERTIFICATE.responsibleGroupId}::uuid)
  `;
};

const insertCertificateResources = async (): Promise<void> => {
  const [titleFieldId, descriptionFieldId, periodFieldId, statusFieldId] = CERTIFICATE.fieldIds;
  await sql`
    INSERT INTO auth.groups (id, cn, provider, name) VALUES
      (${CERTIFICATE.requesterGroupId}::uuid, 'custom-app-certificate-requesters', 'local', 'Certificate requesters'),
      (${CERTIFICATE.responsibleGroupId}::uuid, 'custom-app-certificate-responsible', 'local', 'Certificate responsible')
  `;
  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${CERTIFICATE.baseId}::uuid, 'c00001', 'Certificate requests')
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES (${CERTIFICATE.tableId}::uuid, 'c00201', ${CERTIFICATE.baseId}::uuid, 'Requests', 0)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position) VALUES
      (${titleFieldId}::uuid, 'c00301', ${CERTIFICATE.tableId}::uuid, 'Title', 'text', '{}'::jsonb, 0),
      (${descriptionFieldId}::uuid, 'c00302', ${CERTIFICATE.tableId}::uuid, 'Description', 'longtext', '{}'::jsonb, 1),
      (${periodFieldId}::uuid, 'c00303', ${CERTIFICATE.tableId}::uuid, 'Contribution period', 'text', '{}'::jsonb, 2),
      (${statusFieldId}::uuid, 'c00304', ${CERTIFICATE.tableId}::uuid, 'Status', 'select', ${{
        options: [
          { id: "pending", label: "Pending", color: "orange" },
          { id: "approved", label: "Approved", color: "green" },
          { id: "rejected", label: "Rejected", color: "red" },
        ],
        multiple: false,
        minSelected: 1,
        maxSelected: 1,
      }}::jsonb, 3)
  `;
  await sql`
    INSERT INTO grids.views (id, short_id, table_id, name, source)
    VALUES (
      ${CERTIFICATE.viewId}::uuid,
      'c00401',
      ${CERTIFICATE.tableId}::uuid,
      'My requests',
      ${`from table {c00201}\nwhere record.createdBy = @auth.id`}
    )
  `;
  await sql`
    INSERT INTO grids.forms (id, short_id, table_id, name, config, is_active, position)
    VALUES (
      ${CERTIFICATE.formId}::uuid,
      'c00501',
      ${CERTIFICATE.tableId}::uuid,
      'Certificate request',
      ${JSON.stringify({
        title: "Request a certificate",
        fields: [
          ...[titleFieldId, descriptionFieldId, periodFieldId].map((fieldId) => ({ kind: "user_input", fieldId })),
          { kind: "form_value", fieldId: statusFieldId, value: ["pending"] },
        ],
      })}::jsonb,
      true,
      0
    )
  `;
  await sql`
    INSERT INTO grids.document_templates (id, short_id, table_id, name, source, html, renderer_kind, number_template, filename_template)
    VALUES (
      ${CERTIFICATE.documentTemplateId}::uuid,
      'c00601',
      ${CERTIFICATE.tableId}::uuid,
      'Certificate',
      ${`from table {c00201}`},
      '<h1>Certificate</h1>', 'html', '{{ series.value }}', '{{ document.number }}.pdf'
    )
  `;
  await insertTestWorkflow({
    baseId: CERTIFICATE.baseId,
    id: CERTIFICATE.workflowId,
    name: "Approve certificate request",
    enabled: true,
    plan: {
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
      bindings: { "inputs.request.table": CERTIFICATE.tableId },
    },
  });
  await sql`
    INSERT INTO grids.workflow_launchers (
      id, short_id, base_id, workflow_id, name, kind, config, enabled, validated_revision, diagnostics
    ) VALUES (
      ${CERTIFICATE.launcherId}::uuid,
      'c00802',
      ${CERTIFICATE.baseId}::uuid,
      ${CERTIFICATE.workflowId}::uuid,
      'Approve certificate request',
      'customApp',
      ${{ kind: "customApp", inputMode: "prompt" }}::jsonb,
      true,
      1,
      '[]'::jsonb
    )
  `;
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("Grids App Golden fixtures", () => {
  test("keeps the certificate request fixture structurally valid", async () => {
    const definition = await loadCertificateDefinition();
    const reviewDefinition = await loadCertificateReviewDefinition();
    expect(definition.id).toBe(CERTIFICATE.appPublicId);
    expect(reviewDefinition.id).toBe(CERTIFICATE.reviewAppPublicId);
    expect(definition.baseId).toBe(CERTIFICATE.basePublicId);
    expect(reviewDefinition.baseId).toBe(CERTIFICATE.basePublicId);
  });

  postgresTest("executes the certificate request fixture through the complete lifecycle", async () => {
    await cleanupCertificateFixture();
    try {
      await insertCertificateResources();
      const definition = await loadCertificateDefinition();
      const reviewDefinition = await loadCertificateReviewDefinition();

      const validation = await compile(definition);
      expect(validation.ok).toBe(true);
      if (!validation.ok) throw new Error(validation.diagnostics.map((item) => item.message).join("; "));
      expect(validation.compiled.capabilities).toEqual({
        availability: [],
        views: [
          {
            viewId: CERTIFICATE.viewId,
            tableId: CERTIFICATE.tableId,
            sourceHash: customAppViewSourceHash(CERTIFICATE.tableId, `from table {c00201}\nwhere record.createdBy = @auth.id`),
            planHash: expect.any(String),
            tableIds: [CERTIFICATE.tableId],
          },
        ],
        insights: [],
        recordQueries: [],
        records: [
          {
            pageId: "request",
            tableId: CERTIFICATE.tableId,
            fieldIds: [...CERTIFICATE.fieldIds],
            editableFieldIds: [],
            relationLabels: [],
          },
        ],
        forms: [
          {
            pageId: "apply",
            blockId: "request-form",
            formId: CERTIFICATE.formId,
            tableId: CERTIFICATE.tableId,
            userInputFieldIds: CERTIFICATE.fieldIds.slice(0, 3),
            fixedFieldIds: [],
            fieldHash: customAppFormFieldHash(
              CERTIFICATE.fieldIds.slice(0, 3),
              CERTIFICATE.fieldIds.slice(0, 3).map((id, index) => ({
                id,
                type: index === 1 ? "longtext" : "text",
                config: {},
                deletedAt: null,
              })),
            ),
            formSecurityHash: expect.any(String),
          },
        ],
        comments: [{ pageId: "request", blockId: "comments", tableId: CERTIFICATE.tableId }],
        documents: [
          {
            pageId: "request",
            blockId: "request",
            tableId: CERTIFICATE.tableId,
            templateIds: [CERTIFICATE.documentTemplateId],
          },
        ],
        workflowLaunchers: [],
        scannerLaunchers: [],
      });

      const planned = await plan(definition);
      expect(planned).toEqual({ valid: true, diagnostics: [], action: "create", changes: ["app"] });
      expect(await plan(definition)).toEqual(planned);

      const created = await apply(definition);
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.message);
      expect(created.data.shortId).toHaveLength(6);

      const exportedYaml = Bun.YAML.stringify(created.data.draftDefinition);
      const exported = CustomAppDefinitionSchema.parse(Bun.YAML.parse(exportedYaml));
      expect(exported).toEqual(definition);
      expect((await plan(exported)).action).toBe("noop");

      const reapplied = await apply(exported);
      expect(reapplied.ok).toBe(true);
      if (!reapplied.ok) throw new Error(reapplied.error.message);
      expect(reapplied.data.updatedAt).toBe(created.data.updatedAt);
      const [stored] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.custom_apps WHERE id = ${created.data.id}::uuid
      `;
      expect(stored?.count).toBe(1);

      const grants = [
        {
          resourceType: "customApp",
          resourceId: created.data.id,
          principal: { type: "group", groupId: CERTIFICATE.requesterGroupId },
          permission: "read",
        },
        {
          resourceType: "customApp",
          resourceId: created.data.id,
          principal: { type: "group", groupId: CERTIFICATE.responsibleGroupId },
          permission: "read",
        },
      ] satisfies Array<Parameters<typeof grantAccess>[0]>;
      for (const grant of grants) {
        const result = await grantAccess(grant);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
      }

      expect(await listCustomAppAccess(created.data.id)).toHaveLength(2);

      const published = await publish(created.data.id);
      expect(published.ok).toBe(true);
      if (!published.ok) throw new Error(published.error.message);
      expect(published.data.publishedDefinition).toEqual(exported);
      expect(published.data.publishedCapabilities).toEqual(validation.compiled.capabilities);
      expect((await get(created.data.id))?.publishedCapabilities).toEqual(validation.compiled.capabilities);

      const reviewValidation = await compile(reviewDefinition);
      expect(reviewValidation.ok).toBe(true);
      if (!reviewValidation.ok) throw new Error(reviewValidation.diagnostics.map((item) => item.message).join("; "));
      expect(reviewValidation.compiled.capabilities.workflowLaunchers).toEqual([
        {
          pageId: "request",
          blockId: "review-actions",
          actionId: "approve",
          launcherId: CERTIFICATE.launcherId,
          workflowId: CERTIFICATE.workflowId,
          revision: 1,
        },
      ]);
      expect(await plan(reviewDefinition)).toEqual({ valid: true, diagnostics: [], action: "create", changes: ["app"] });
      const reviewCreated = await apply(reviewDefinition);
      expect(reviewCreated.ok).toBe(true);
      if (!reviewCreated.ok) throw new Error(reviewCreated.error.message);
      const reviewPublished = await publish(reviewCreated.data.id);
      expect(reviewPublished.ok).toBe(true);

      const baseGrant = await grantAccess({
        resourceType: "base",
        resourceId: CERTIFICATE.baseId,
        principal: { type: "group", groupId: CERTIFICATE.responsibleGroupId },
        permission: "write",
      });
      expect(baseGrant.ok).toBe(true);
      const reviewGrant = await grantAccess({
        resourceType: "customApp",
        resourceId: reviewCreated.data.id,
        principal: { type: "group", groupId: CERTIFICATE.responsibleGroupId },
        permission: "read",
      });
      expect(reviewGrant.ok).toBe(true);
      expect(await listBaseAccess(CERTIFICATE.baseId)).toHaveLength(1);
      expect(await listCustomAppAccess(reviewCreated.data.id)).toHaveLength(1);
    } finally {
      await cleanupCertificateFixture();
    }
  });
});
