import { beforeAll, describe, expect } from "bun:test";
import { ok } from "@k2b/stdlib";
import type { User } from "@valentinkolb/cloud/contracts";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { sql } from "bun";
import { Hono, type MiddlewareHandler } from "hono";
import type { DslQueryPreviewResponse } from "../contracts";
import { CustomAppCapabilitiesSchema, type CustomAppDefinition } from "../custom-apps/contracts";
import { customAppViewSourceHash } from "../custom-apps/insight-source";
import { buildCustomAppRuntimeContext } from "../custom-apps/runtime-context";
import { insertTestDocumentArtifact, postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { grantAccess } from "../service/access";
import { compileCustomAppQuery } from "../service/custom-app-query";
import { executePublishedCustomAppQuery } from "../service/custom-app-runtime-query";
import { apply, getPublishedByShortId, publish } from "../service/custom-apps";
import { parseJsonbRow } from "../service/jsonb";
import { resolvePublicId } from "../service/public-resources";
import type { CustomAppLauncherInvocation, ScannerLauncherInvocation } from "../service/workflow-launcher-invocations";
import type { GridsWorkflowAuthorization, GridsWorkflowRunScope } from "../service/workflow-runs";
import type { GridsWorkflowPrincipal, GridsWorkflowRun } from "../workflows/contracts";
import { createCustomAppsApi } from "./custom-apps";

const authenticateAs =
  (user: User): MiddlewareHandler<AuthContext> =>
  async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("accessSubject", { type: "user", userId: user.id });
    c.set("user", user);
    await next();
  };

const authenticateAsDelegatedServiceAccount = (user: User, serviceAccountId: string): MiddlewareHandler<AuthContext> => {
  const credentialId = testUuid();
  return async (c, next) => {
    c.set("actor", {
      kind: "service_account",
      serviceAccount: {
        id: serviceAccountId,
        name: "Grids App API",
        kind: "user_delegated",
        status: "active",
        delegatedUserId: user.id,
        appId: null,
        resourceType: null,
        resourceId: null,
        createdBy: user.id,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      delegatedUser: user,
      scopes: ["grids:write"],
      credentialId,
    });
    c.set("accessSubject", { type: "user", userId: user.id, delegatedByServiceAccountId: serviceAccountId });
    c.set("user", user);
    await next();
  };
};

const userFor = (id: string): User => ({
  id,
  uid: `custom-app-${id}`,
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Custom",
  sn: "App",
  displayName: "Grids App",
  mail: `custom-app-${id}@example.test`,
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
});

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("Grids App Form runtime", () => {
  postgresTest("accepts two page parameters for the same record and rejects unresolved parameters", async () => {
    const baseId = testUuid();
    const tableId = testUuid();
    const fieldId = testUuid();
    const recordId = testUuid();
    const relationFieldId = testUuid();
    const formId = testUuid();
    const baseShortId = testShortId("B");
    const tableShortId = testShortId("T");
    const fieldShortId = testShortId("F");
    const recordShortId = testShortId("R");
    const relationFieldShortId = testShortId("F");
    const formShortId = testShortId("M");
    let accessId: string | undefined;
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Repeated page parameters')`;
      await sql`INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Records')`;
      await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${fieldId}::uuid, ${fieldShortId}, ${tableId}::uuid, 'Title', 'text', '{}'::jsonb, 0)`;
      await sql`INSERT INTO grids.records (id, short_id, table_id, data)
        VALUES (${recordId}::uuid, ${recordShortId}, ${tableId}::uuid, ${{ [fieldId]: "Same record" }}::jsonb)`;
      await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${relationFieldId}::uuid, ${relationFieldShortId}, ${tableId}::uuid, 'Parent', 'relation',
          ${{ targetTableId: tableId, cardinality: "single" }}::jsonb, 1)`;
      await sql`INSERT INTO grids.forms (id, short_id, table_id, name, config, is_active, position)
        VALUES (${formId}::uuid, ${formShortId}, ${tableId}::uuid, 'Follow up',
          ${{
            fields: [
              { kind: "user_input", fieldId },
              { kind: "user_input", fieldId: relationFieldId },
            ],
          }}::jsonb, TRUE, 0)`;
      const applied = await apply({
        schemaVersion: 5,
        kind: "grids.custom-app",
        id: testShortId("A"),
        baseId: baseShortId,
        name: "Repeated parameters",
        startPageId: "home",
        pages: [
          {
            id: "home",
            title: "Home",
            navigation: { visible: true },
            parameters: {},
            rows: [{ id: "intro", columns: [{ id: "main", span: 12, blocks: [{ id: "intro", type: "markdown", markdown: "Home" }] }] }],
          },
          {
            id: "detail",
            title: "Detail",
            navigation: { visible: false },
            parameters: {
              first: { type: "record", tableId: tableShortId, required: true },
              second: { type: "record", tableId: tableShortId, required: true },
            },
            rows: [
              {
                id: "detail",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      {
                        id: "records",
                        type: "records",
                        searchable: false,
                        pageSize: 25,
                        source: {
                          kind: "gql",
                          query: `from table {${tableShortId}}\nwhere record.id = @params.first and record.id = @params.second`,
                        },
                        display: { kind: "table", columnIds: [fieldShortId] },
                      },
                      {
                        id: "follow-up",
                        type: "form",
                        formId: formShortId,
                        fixedValues: { [relationFieldShortId]: { source: "PARAMS", path: "first" } },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "record-detail",
            title: "Record",
            navigation: { visible: false },
            parameters: { first: { type: "record", tableId: tableShortId, required: true } },
            record: { tableId: tableShortId, id: { source: "PARAMS", path: "first" } },
            rows: [
              {
                id: "record",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      {
                        id: "record",
                        type: "record",
                        fieldIds: [fieldShortId, relationFieldShortId],
                        editableFieldIds: [relationFieldShortId],
                      },
                      { id: "selected-relation", type: "form", formId: formShortId, fixedValues: {} },
                      {
                        id: "follow-up",
                        type: "form",
                        formId: formShortId,
                        fixedValues: {
                          [relationFieldShortId]: { source: "RECORD", path: "id" },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
      if (!applied.ok) throw new Error(applied.error.message);
      const published = await publish(applied.data.id);
      if (!published.ok) throw new Error(published.error.message);
      const grant = await grantAccess({
        resourceType: "customApp",
        resourceId: applied.data.id,
        permission: "read",
        principal: { type: "public" },
      });
      if (!grant.ok) throw new Error(grant.error.message);
      accessId = grant.data.accessId;
      const api = new Hono<AuthContext>().route(
        "/apps",
        createCustomAppsApi({
          requireAuthenticated: async (c) => c.json({ message: "Authentication required" }, 401),
        }),
      );
      const route = `/apps/runtime/${applied.data.shortId}/detail/records/records`;
      const sameRecord = await api.request(`${route}?first=${recordShortId}&second=${recordShortId}`);
      expect(sameRecord.status).toBe(200);
      const missingRecord = await api.request(`${route}?first=${recordShortId}&second=${testShortId("Z")}`);
      expect(missingRecord.status).toBe(404);
      for (const [pageId, query] of [
        ["detail", `first=${recordShortId}&second=${recordShortId}`],
        ["record-detail", `first=${recordShortId}`],
      ]) {
        const submitted = await api.request(`/apps/runtime/${applied.data.shortId}/${pageId}/follow-up/submit?${query}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ [fieldShortId]: "Bound follow up" }),
        });
        expect(submitted.status).toBe(201);
        const body = (await submitted.json()) as { recordId: string };
        const createdId = await resolvePublicId("record", body.recordId);
        expect(createdId).not.toBeNull();
        const links = await sql<Array<{ targetId: string }>>`SELECT to_record_id::text AS "targetId" FROM grids.record_links
          WHERE from_record_id = ${createdId}::uuid AND from_field_id = ${relationFieldId}::uuid`;
        expect(links).toEqual([{ targetId: recordId }]);
      }

      const selectedFormUrl = `/apps/runtime/${applied.data.shortId}/record-detail/selected-relation/submit?first=${recordShortId}`;
      const selectedRelation = await api.request(selectedFormUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [fieldShortId]: "Selected relation", [relationFieldShortId]: [recordShortId] }),
      });
      expect(selectedRelation.status).toBe(201);
      const selectedBody = (await selectedRelation.json()) as { recordId: string };
      const selectedId = await resolvePublicId("record", selectedBody.recordId);
      expect(selectedId).not.toBeNull();
      if (!selectedId) throw new Error("Created record must resolve from its public ID");
      expect(
        await sql<Array<{ targetId: string }>>`SELECT to_record_id::text AS "targetId" FROM grids.record_links
        WHERE from_record_id = ${selectedId}::uuid AND from_field_id = ${relationFieldId}::uuid`,
      ).toEqual([{ targetId: recordId }]);

      const [authUser] = await sql<Array<{ id: string }>>`SELECT id::text FROM auth.users ORDER BY id LIMIT 1`;
      if (!authUser) throw new Error("CustomApp integration tests require a local auth user");
      const authenticatedApi = new Hono<AuthContext>().route(
        "/apps",
        createCustomAppsApi({
          loadOptionalActor: authenticateAs(userFor(authUser.id)),
          requireAuthenticated: authenticateAs(userFor(authUser.id)),
        }),
      );
      const editUrl = `/apps/runtime/${applied.data.shortId}/record-detail/record/record?first=${recordShortId}`;
      const editedRelation = await authenticatedApi.request(editUrl, {
        method: "PATCH",
        headers: { "content-type": "application/json", "If-Match": "1" },
        body: JSON.stringify({ values: { [relationFieldShortId]: [selectedBody.recordId] } }),
      });
      expect(editedRelation.status).toBe(200);
      expect(
        await sql<Array<{ targetId: string }>>`SELECT to_record_id::text AS "targetId" FROM grids.record_links
        WHERE from_record_id = ${recordId}::uuid AND from_field_id = ${relationFieldId}::uuid`,
      ).toEqual([{ targetId: selectedId }]);

      for (const invalidId of ["Unknown record", recordId]) {
        const invalidForm = await api.request(selectedFormUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ [fieldShortId]: "Invalid relation", [relationFieldShortId]: [invalidId] }),
        });
        expect(invalidForm.status).toBe(400);
        const invalidEdit = await authenticatedApi.request(editUrl, {
          method: "PATCH",
          headers: { "content-type": "application/json", "If-Match": "2" },
          body: JSON.stringify({ values: { [relationFieldShortId]: [invalidId] } }),
        });
        expect(invalidEdit.status).toBe(400);
      }
      expect(
        await sql<Array<{ targetId: string }>>`SELECT to_record_id::text AS "targetId" FROM grids.record_links
        WHERE from_record_id = ${recordId}::uuid AND from_field_id = ${relationFieldId}::uuid`,
      ).toEqual([{ targetId: selectedId }]);
      expect(
        await sql<Array<{ count: number }>>`SELECT count(*)::int AS count FROM grids.records
        WHERE table_id = ${tableId}::uuid AND deleted_at IS NULL`,
      ).toEqual([{ count: 4 }]);
      expect(
        await sql<Array<{ version: number }>>`SELECT version FROM grids.records
        WHERE id = ${recordId}::uuid`,
      ).toEqual([{ version: 2 }]);
    } finally {
      await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    }
  });

  postgresTest(
    "submits through the published Form capability and replace-navigates to the created record",
    async () => {
      const baseId = testUuid();
      const tableId = testUuid();
      const fieldId = testUuid();
      const hiddenFieldId = testUuid();
      const suppliedFieldId = testUuid();
      const imageFieldId = testUuid();
      const formId = testUuid();
      const viewId = testUuid();
      const documentTemplateId = testUuid();
      const otherDocumentTemplateId = testUuid();
      const launcherId = testUuid();
      const workflowId = testUuid();
      const basePublicId = testShortId("B");
      const tablePublicId = testShortId("T");
      const fieldPublicId = testShortId("F");
      const hiddenFieldPublicId = testShortId("H");
      const suppliedFieldPublicId = testShortId("S");
      const imageFieldPublicId = testShortId("I");
      const formPublicId = testShortId("M");
      const viewPublicId = testShortId("V");
      const documentTemplatePublicId = testShortId("D");
      const otherDocumentTemplatePublicId = testShortId("E");
      const appPublicId = testShortId("A");
      const launcherPublicId = testShortId("L");
      const workflowPublicId = testShortId("W");
      const [authUser] = await sql<Array<{ id: string }>>`SELECT id::text FROM auth.users ORDER BY id LIMIT 1`;
      if (!authUser) throw new Error("Grids App API integration test needs one auth user");
      const accessIds: string[] = [];
      let userBaseAccessId: string | null = null;
      try {
        await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${basePublicId}, 'Grids App API')`;
        const baseGrant = await grantAccess({
          resourceType: "base",
          resourceId: baseId,
          permission: "admin",
          principal: { type: "user", userId: authUser.id },
        });
        expect(baseGrant.ok).toBe(true);
        if (!baseGrant.ok) throw new Error(baseGrant.error.message);
        userBaseAccessId = baseGrant.data.accessId;
        await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES (${tableId}::uuid, ${tablePublicId}, ${baseId}::uuid, 'Requests')
      `;
        await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, required, default_value, position) VALUES
          (${fieldId}::uuid, ${fieldPublicId}, ${tableId}::uuid, 'Subject', 'text', '{}'::jsonb, TRUE, NULL, 0),
          (${hiddenFieldId}::uuid, ${hiddenFieldPublicId}, ${tableId}::uuid, 'Internal source', 'text', '{}'::jsonb, FALSE, NULL, 1),
          (${suppliedFieldId}::uuid, ${suppliedFieldPublicId}, ${tableId}::uuid, 'Channel', 'text', '{}'::jsonb, FALSE, ${JSON.stringify("Web default")}::jsonb, 2),
          (${imageFieldId}::uuid, ${imageFieldPublicId}, ${tableId}::uuid, 'Preview', 'file', '{}'::jsonb, FALSE, NULL, 3)
      `;
        await sql`
        INSERT INTO grids.views (id, short_id, table_id, name, source, ui)
        VALUES (
          ${viewId}::uuid,
          ${viewPublicId},
          ${tableId}::uuid,
          'Request search',
          ${`from table {${tablePublicId}}\nselect {${fieldPublicId}}`},
          ${JSON.stringify({ displayConfig: { mode: "cards", cards: { fieldIds: [suppliedFieldId], imageFieldId } } })}::jsonb
        )
      `;
        await sql`
        INSERT INTO grids.forms (id, short_id, table_id, name, config, is_active, position)
        VALUES (
          ${formId}::uuid,
          ${formPublicId},
          ${tableId}::uuid,
          'Apply',
          ${{
            fields: [
              { kind: "user_input", fieldId, required: true },
              { kind: "user_input", fieldId: suppliedFieldId },
            ],
          }}::jsonb,
          TRUE,
          0
        )
      `;
        await sql`
        INSERT INTO grids.document_templates (
          id, short_id, table_id, name, source, renderer_kind, html, number_template, filename_template
        )
        VALUES
          (
            ${documentTemplateId}::uuid, ${documentTemplatePublicId}, ${tableId}::uuid, 'Certificate',
            'from table Requests', 'html', '<p>Certificate</p>', 'CERT-{{ document.id }}', '{{ document.number }}.pdf'
          ),
          (
            ${otherDocumentTemplateId}::uuid, ${otherDocumentTemplatePublicId}, ${tableId}::uuid, 'Internal certificate',
            'from table Requests', 'html', '<p>Internal</p>', 'INTERNAL-{{ document.id }}', '{{ document.number }}.pdf'
          )
      `;
        await sql`
          INSERT INTO grids.workflow_profile (id, short_id, base_id, position, owner_user_id, enabled)
          VALUES (${workflowId}::uuid, ${workflowPublicId}, ${baseId}::uuid, 0, ${authUser.id}::uuid, TRUE)
        `;
        await sql`
          INSERT INTO grids.workflow_launchers (
            id, short_id, base_id, workflow_id, name, kind, config, enabled, validated_revision
          ) VALUES (
            ${launcherId}::uuid,
            ${launcherPublicId},
            ${baseId}::uuid,
            ${workflowId}::uuid,
            'Approve request',
            'customApp',
            ${JSON.stringify({ kind: "customApp", inputSchema: {} })}::jsonb,
            TRUE,
            1
          )
        `;

        const definition: CustomAppDefinition = {
          schemaVersion: 5,
          kind: "grids.custom-app",
          id: appPublicId,
          baseId: basePublicId,
          name: "Request portal",
          startPageId: "home",
          sidebar: {
            actions: [
              {
                id: "new-request",
                kind: "form",
                label: "New request",
                tone: "success",
                formId: formPublicId,
                fixedValues: { [suppliedFieldPublicId]: { source: "LITERAL", value: "Sidebar" } },
                onSuccessNavigate: {
                  kind: "navigate",
                  pageId: "request",
                  params: { request_id: { source: "RESULT", path: "recordId" } },
                },
              },
            ],
          },
          pages: [
            {
              id: "home",
              title: "Apply",
              navigation: { visible: true },
              parameters: {},
              rows: [
                {
                  id: "main",
                  columns: [
                    {
                      id: "content",
                      span: 12,
                      blocks: [
                        {
                          id: "apply",
                          type: "form",
                          formId: formPublicId,
                          fixedValues: { [suppliedFieldPublicId]: { source: "LITERAL", value: "App portal" } },
                          onSuccessNavigate: {
                            kind: "navigate",
                            pageId: "request",
                            params: { request_id: { source: "RESULT", path: "recordId" } },
                          },
                        },
                        {
                          id: "requests",
                          type: "records",
                          source: { kind: "view", viewId: viewPublicId },
                          display: { kind: "cards" },
                          searchable: true,
                          pageSize: 25,
                          rowNavigate: {
                            kind: "navigate",
                            pageId: "request",
                            history: "push",
                            params: { request_id: { source: "ROW", path: "id" } },
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              id: "request",
              title: "Request",
              navigation: { visible: false },
              parameters: { request_id: { type: "record", tableId: tablePublicId, required: true } },
              record: { tableId: tablePublicId, id: { source: "PARAMS", path: "request_id" } },
              rows: [
                {
                  id: "main",
                  columns: [
                    {
                      id: "content",
                      span: 12,
                      blocks: [
                        {
                          id: "record",
                          type: "record",
                          fieldIds: [fieldPublicId, imageFieldPublicId],
                          editableFieldIds: [fieldPublicId, imageFieldPublicId],
                          documents: { templateIds: [documentTemplatePublicId] },
                        },
                        { id: "discussion", type: "comments" },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        };
        const applied = await apply(definition);
        expect(applied.ok).toBe(true);
        if (!applied.ok) throw new Error(applied.error.message);
        const appId = applied.data.id;
        const published = await publish(appId);
        expect(published.ok).toBe(true);

        const appGrant = await grantAccess({
          resourceType: "customApp",
          resourceId: appId,
          permission: "read",
          principal: { type: "public" },
        });
        expect(appGrant.ok).toBe(true);
        if (!appGrant.ok) throw new Error(appGrant.error.message);
        accessIds.push(appGrant.data.accessId);

        let actionInvocation: CustomAppLauncherInvocation | null = null;
        let scannerInvocation: ScannerLauncherInvocation | null = null;
        const registerWorkflowRun = async (runId: string, channel: "customApp" | "scanner"): Promise<void> => {
          await sql`
            INSERT INTO grids.workflow_run_profile (
              run_id, short_id, base_id, workflow_id, launcher_id, launcher_kind, channel, actor_user_id, request_fingerprint
            ) VALUES (
              ${runId}::uuid,
              ${testShortId(channel === "scanner" ? "C" : "U")},
              ${baseId}::uuid,
              ${workflowId}::uuid,
              ${launcherId}::uuid,
              ${channel === "scanner" ? "scanner" : "customApp"},
              ${channel},
              ${authUser.id}::uuid,
              ${testUuid()}
            )
          `;
        };
        const getDocumentPdf = async () => ok({ pdf: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf" as const });
        const publicApi = new Hono<AuthContext>().route(
          "/apps",
          createCustomAppsApi({
            requireAuthenticated: async (c) => c.json({ message: "Authentication required" }, 401),
            getDocumentPdf,
          }),
        );
        const api = new Hono<AuthContext>().route(
          "/apps",
          createCustomAppsApi({
            loadOptionalActor: authenticateAs(userFor(authUser.id)),
            requireAuthenticated: authenticateAs(userFor(authUser.id)),
            invokeCustomAppLauncher: async (input) => {
              actionInvocation = input as CustomAppLauncherInvocation;
              const runId = testUuid();
              await registerWorkflowRun(runId, "customApp");
              return ok({
                runId,
                workflowId,
                revision: "1",
                mode: "execute",
                channel: "customApp",
                created: true,
                status: "queued",
              });
            },
            invokeScannerLauncher: async (input) => {
              scannerInvocation = input as ScannerLauncherInvocation;
              const runId = testUuid();
              await registerWorkflowRun(runId, "scanner");
              return ok({
                runId,
                workflowId,
                revision: "1",
                mode: "execute",
                channel: "scanner",
                created: true,
                status: "queued",
              });
            },
            getDocumentPdf,
          }),
        );
        const appResponse = await api.request(`/apps/${applied.data.shortId}`);
        expect(appResponse.status).toBe(200);
        const publicApp = (await appResponse.json()) as Record<string, unknown>;
        expect(publicApp.draftDefinition).not.toBeNull();
        expect(publicApp.publishedDefinition).not.toBeNull();
        expect(publicApp).not.toHaveProperty("draftDefinitionRaw");
        expect(publicApp).not.toHaveProperty("publishedDefinitionRaw");
        const response = await publicApi.request(`/apps/runtime/${applied.data.shortId}/home/apply/submit`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `custom-app-${baseId}` },
          body: JSON.stringify({ [fieldPublicId]: "Certificate request" }),
        });
        expect(response.status).toBe(201);
        expect(response.headers.get("X-RateLimit-Limit")).toBeNull();
        const body = (await response.json()) as { recordId: string; navigateTo: string };
        expect(body.recordId).toMatch(/^[A-Za-z0-9]{6}$/);
        expect(body.navigateTo).toBe(`/apps/${applied.data.shortId}/request?request_id=${body.recordId}`);
        const recordId = await resolvePublicId("record", body.recordId);
        if (!recordId) throw new Error("Created record public ID did not resolve");
        const internalFieldSubmit = await publicApi.request(`/apps/runtime/${applied.data.shortId}/home/apply/submit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ [fieldId]: "Internal IDs are not public inputs" }),
        });
        expect(internalFieldSubmit.status).toBe(400);

        const [record] = await sql<Array<{ value: string; supplied: string }>>`
        SELECT data ->> ${fieldId} AS value, data ->> ${suppliedFieldId} AS supplied
        FROM grids.records WHERE id = ${recordId}::uuid
      `;
        expect(record?.value).toBe("Certificate request");
        expect(record?.supplied).toBe("App portal");
        const fileId = testUuid();
        const filePublicId = testShortId("P");
        const imageBytes = new Uint8Array([137, 80, 78, 71]);
        await sql`
          INSERT INTO grids.files (id, short_id, filename, mime_type, size_bytes, sha256, bytes)
          VALUES (${fileId}::uuid, ${filePublicId}, 'preview.png', 'image/png', ${imageBytes.length}, 'fixture', ${imageBytes})
        `;
        await sql`
          INSERT INTO grids.file_attachments (file_id, record_id, field_id, position)
          VALUES (${fileId}::uuid, ${recordId}::uuid, ${imageFieldId}::uuid, 0)
        `;
        const previousAppSecret = process.env.APP_SECRET;
        process.env.APP_SECRET = "custom-app-file-test-secret";

        const cardsResponse = await publicApi.request(`/apps/runtime/${applied.data.shortId}/home/requests/records`, {
          headers: { "x-forwarded-for": `custom-app-cards-${baseId}` },
        });
        expect(cardsResponse.status).toBe(200);
        const cardsBody = (await cardsResponse.json()) as {
          presentation?: { fields: Array<{ id: string; type: string }> };
          cards?: { displayConfig: { mode: string }; records: Array<{ id: string; data: Record<string, unknown> }> };
        };
        expect(cardsBody.cards?.displayConfig.mode).toBe("cards");
        expect(cardsBody.presentation?.fields).toContainEqual(expect.objectContaining({ id: fieldPublicId, type: "text" }));
        expect(cardsBody.cards?.records.find((item) => item.id === body.recordId)?.data).toEqual({ [suppliedFieldPublicId]: "App portal" });

        const searchedCardsResponse = await publicApi.request(
          `/apps/runtime/${applied.data.shortId}/home/requests/records?q=App%20portal`,
          { headers: { "x-forwarded-for": `custom-app-card-search-${baseId}` } },
        );
        expect(searchedCardsResponse.status).toBe(200);
        const searchedCardsBody = (await searchedCardsResponse.json()) as {
          rows: Array<{ recordId?: string }>;
          cards?: { filePreviews: Record<string, Record<string, { contentToken: string }>> };
        };
        expect(searchedCardsBody.rows.some((item) => item.recordId === body.recordId)).toBe(true);
        const contentToken = searchedCardsBody.cards?.filePreviews[body.recordId]?.[imageFieldPublicId]?.contentToken;
        expect(contentToken).toBeString();
        const filePath = `/apps/runtime/${applied.data.shortId}/home/requests/files/${encodeURIComponent(contentToken!)}`;
        const fileResponse = await publicApi.request(`${filePath}?q=App%20portal`);
        expect(fileResponse.status).toBe(200);
        expect(fileResponse.headers.get("content-type")).toBe("image/png");
        await sql`
          UPDATE grids.records
          SET data = jsonb_set(data, ARRAY[${suppliedFieldId}], to_jsonb('No longer searchable'::text))
          WHERE id = ${recordId}::uuid
        `;
        expect((await publicApi.request(`${filePath}?q=App%20portal`)).status).toBe(404);
        await sql`
          UPDATE grids.records
          SET data = jsonb_set(data, ARRAY[${suppliedFieldId}], to_jsonb('App portal'::text))
          WHERE id = ${recordId}::uuid
        `;
        if (previousAppSecret === undefined) delete process.env.APP_SECRET;
        else process.env.APP_SECRET = previousAppSecret;

        const sidebarResponse = await publicApi.request(`/apps/runtime/${applied.data.shortId}/sidebar/forms/new-request/submit`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `custom-app-sidebar-${baseId}` },
          body: JSON.stringify({ [fieldPublicId]: "Sidebar request" }),
        });
        expect(sidebarResponse.status).toBe(201);
        const sidebarBody = (await sidebarResponse.json()) as { recordId: string; navigateTo: string };
        expect(sidebarBody.navigateTo).toBe(`/apps/${applied.data.shortId}/request?request_id=${sidebarBody.recordId}`);
        const sidebarRecordId = await resolvePublicId("record", sidebarBody.recordId);
        if (!sidebarRecordId) throw new Error("Sidebar record public ID did not resolve");
        const [sidebarRecord] = await sql<Array<{ value: string; supplied: string }>>`
          SELECT data ->> ${fieldId} AS value, data ->> ${suppliedFieldId} AS supplied
          FROM grids.records WHERE id = ${sidebarRecordId}::uuid
        `;
        expect(sidebarRecord).toEqual({ value: "Sidebar request", supplied: "Sidebar" });

        await sql`
          DELETE FROM grids.custom_app_access
          WHERE custom_app_id = ${appId}::uuid AND access_id = ${appGrant.data.accessId}::uuid
        `;
        const authenticatedGrant = await grantAccess({
          resourceType: "customApp",
          resourceId: appId,
          permission: "read",
          principal: { type: "authenticated" },
        });
        expect(authenticatedGrant.ok).toBe(true);
        if (!authenticatedGrant.ok) throw new Error(authenticatedGrant.error.message);
        accessIds.push(authenticatedGrant.data.accessId);
        try {
          const authenticatedSidebarResponse = await api.request(`/apps/runtime/${applied.data.shortId}/sidebar/forms/new-request/submit`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": `custom-app-authenticated-${baseId}` },
            body: JSON.stringify({}),
          });
          expect(authenticatedSidebarResponse.status).toBe(400);
          expect(await authenticatedSidebarResponse.json()).toMatchObject({ code: "BAD_INPUT" });
        } finally {
          await sql`
            DELETE FROM grids.custom_app_access
            WHERE custom_app_id = ${appId}::uuid AND access_id = ${authenticatedGrant.data.accessId}::uuid
          `;
          await sql`
            INSERT INTO grids.custom_app_access (custom_app_id, access_id)
            VALUES (${appId}::uuid, ${appGrant.data.accessId}::uuid)
          `;
        }

        const snapshotId = testUuid();
        const snapshotPublicId = testShortId("N");
        const documentId = testUuid();
        const documentPublicId = testShortId("R");
        const otherDocumentId = testUuid();
        const otherDocumentPublicId = testShortId("Q");
        const otherRecordId = testUuid();
        const otherRecordPublicId = testShortId("O");
        await sql`
        INSERT INTO grids.records (id, short_id, table_id, data, created_by, updated_by)
        VALUES (
          ${otherRecordId}::uuid,
          ${otherRecordPublicId},
          ${tableId}::uuid,
          ${{ [fieldId]: "Another request", [suppliedFieldId]: "App portal" }}::jsonb,
          ${authUser.id}::uuid,
          ${authUser.id}::uuid
        )
      `;
        await sql`
        INSERT INTO grids.record_snapshots (id, short_id, base_id, table_id, record_id, root, graph)
        VALUES (
          ${snapshotId}::uuid,
          ${snapshotPublicId},
          ${baseId}::uuid,
          ${tableId}::uuid,
          ${recordId}::uuid,
          '{}'::jsonb,
          '{}'::jsonb
        )
      `;
        const documentArtifact = await insertTestDocumentArtifact({
          documentId,
          baseId,
          tableId,
          recordId,
          filename: "certificate.pdf",
        });
        const otherDocumentArtifact = await insertTestDocumentArtifact({
          documentId: otherDocumentId,
          baseId,
          tableId,
          recordId,
          filename: "internal-certificate.pdf",
        });
        await sql`
        INSERT INTO grids.documents (
          id, short_id, template_id, snapshot_id, base_id, table_id, record_id,
          document_number, filename, template_snapshot, render_data,
          renderer_kind, renderer_version, template_revision, issued_actor
        ) VALUES (
          ${documentId}::uuid,
          ${documentPublicId},
          ${documentTemplateId}::uuid,
          ${snapshotId}::uuid,
          ${baseId}::uuid,
          ${tableId}::uuid,
          ${recordId}::uuid,
          'CERT-1',
          'certificate.pdf',
          '{}'::jsonb,
          '{}'::jsonb,
          'html', ${documentArtifact.rendererVersion}, ${documentArtifact.templateRevision}, ${{ kind: "user", userId: authUser.id }}::jsonb
        )
      `;
        await documentArtifact.attach();
        await sql`
        INSERT INTO grids.documents (
          id, short_id, template_id, snapshot_id, base_id, table_id, record_id,
          document_number, filename, template_snapshot, render_data,
          renderer_kind, renderer_version, template_revision, issued_actor
        ) VALUES (
          ${otherDocumentId}::uuid,
          ${otherDocumentPublicId},
          ${otherDocumentTemplateId}::uuid,
          ${snapshotId}::uuid,
          ${baseId}::uuid,
          ${tableId}::uuid,
          ${recordId}::uuid,
          'INTERNAL-1',
          'internal-certificate.pdf',
          '{}'::jsonb,
          '{}'::jsonb,
          'html', ${otherDocumentArtifact.rendererVersion}, ${otherDocumentArtifact.templateRevision}, ${{ kind: "user", userId: authUser.id }}::jsonb
        )
      `;
        await otherDocumentArtifact.attach();
        const documentResponse = await publicApi.request(
          `/apps/runtime/${applied.data.shortId}/request/record/documents/${documentPublicId}/download?request_id=${body.recordId}`,
          { headers: { "x-forwarded-for": `custom-app-document-${baseId}` } },
        );
        expect(documentResponse.status).toBe(200);
        expect(documentResponse.headers.get("content-type")).toBe("application/pdf");
        expect(documentResponse.headers.get("X-Grids-Document-Id")).toBe(documentPublicId);
        expect(documentResponse.headers.get("X-Grids-Document-Artifact")).toBe("stored");
        expect(new Uint8Array(await documentResponse.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
        expect(
          (
            await publicApi.request(
              `/apps/runtime/${applied.data.shortId}/request/record/documents/${documentPublicId}/download?request_id=${otherRecordPublicId}`,
              { headers: { "x-forwarded-for": `custom-app-document-record-${baseId}` } },
            )
          ).status,
        ).toBe(404);
        expect(
          (
            await publicApi.request(
              `/apps/runtime/${applied.data.shortId}/request/record/documents/${otherDocumentPublicId}/download?request_id=${body.recordId}`,
              { headers: { "x-forwarded-for": `custom-app-document-template-${baseId}` } },
            )
          ).status,
        ).toBe(404);

        const fixedOverride = await publicApi.request(`/apps/runtime/${applied.data.shortId}/home/apply/submit`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `custom-app-override-${baseId}` },
          body: JSON.stringify({ [fieldPublicId]: "Override", [suppliedFieldPublicId]: "Browser value" }),
        });
        expect(fixedOverride.status).toBe(400);

        await sql`
        UPDATE grids.forms
        SET config = ${{
          fields: [
            { kind: "user_input", fieldId, required: true },
            { kind: "user_input", fieldId: suppliedFieldId },
            { kind: "form_value", fieldId: hiddenFieldId, value: "injected-after-publish" },
          ],
        }}::jsonb
        WHERE id = ${formId}::uuid
      `;
        const driftedSubmit = await publicApi.request(`/apps/runtime/${applied.data.shortId}/home/apply/submit`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `custom-app-drift-${baseId}` },
          body: JSON.stringify({ [fieldPublicId]: "Must not be written" }),
        });
        expect(driftedSubmit.status).toBe(404);
        const [afterDrift] = await sql<Array<{ count: number; hidden_count: number }>>`
        SELECT
          count(*)::int AS count,
          count(*) FILTER (WHERE data ? ${hiddenFieldId})::int AS hidden_count
        FROM grids.records
        WHERE table_id = ${tableId}::uuid AND deleted_at IS NULL
      `;
        expect(afterDrift).toEqual({ count: 3, hidden_count: 0 });
        await sql`
        UPDATE grids.forms
        SET config = ${{
          fields: [
            { kind: "user_input", fieldId, required: true },
            { kind: "user_input", fieldId: suppliedFieldId },
          ],
        }}::jsonb
        WHERE id = ${formId}::uuid
      `;

        const recordUrl = `/apps/runtime/${applied.data.shortId}/request/record/record?request_id=${body.recordId}`;
        expect((await api.request(`/apps/runtime/${applied.data.shortId}/request/record/record?request_id=${recordId}`)).status).toBe(404);
        const anonymousRecordEdit = await publicApi.request(recordUrl, {
          method: "PATCH",
          headers: { "content-type": "application/json", "If-Match": "1" },
          body: JSON.stringify({ values: { [fieldPublicId]: "Anonymous edit" } }),
        });
        expect(anonymousRecordEdit.status).toBe(401);
        await sql`
          UPDATE grids.records
          SET data = data || ${JSON.stringify({ [hiddenFieldId]: "Internal only" })}::jsonb
          WHERE id = ${recordId}::uuid
        `;
        const updatedRecord = await api.request(recordUrl, {
          method: "PATCH",
          headers: { "content-type": "application/json", "If-Match": "1" },
          body: JSON.stringify({ values: { [fieldPublicId]: "Certificate request updated" } }),
        });
        expect(updatedRecord.status).toBe(200);
        const updatedRecordBody = (await updatedRecord.json()) as { data: Record<string, unknown> };
        expect(updatedRecordBody).toMatchObject({
          id: body.recordId,
          version: 2,
          data: { [fieldPublicId]: "Certificate request updated" },
          relationLabels: {},
        });
        expect(updatedRecordBody.data).not.toHaveProperty(hiddenFieldPublicId);

        const rejectedField = await api.request(recordUrl, {
          method: "PATCH",
          headers: { "content-type": "application/json", "If-Match": "2" },
          body: JSON.stringify({ values: { [testShortId("Z")]: "not published" } }),
        });
        expect(rejectedField.status).toBe(400);

        const rejectedFilePatch = await api.request(recordUrl, {
          method: "PATCH",
          headers: { "content-type": "application/json", "If-Match": "2" },
          body: JSON.stringify({ values: { [imageFieldPublicId]: "not a file upload" } }),
        });
        expect(rejectedFilePatch.status).toBe(400);

        const filesUrl = `/apps/runtime/${applied.data.shortId}/request/record/record/files/${imageFieldPublicId}?request_id=${body.recordId}`;
        expect((await publicApi.request(filesUrl)).status).toBe(401);
        const listedFiles = await api.request(filesUrl);
        expect(listedFiles.status).toBe(200);
        expect(await listedFiles.json()).toMatchObject({ items: [{ id: filePublicId, filename: "preview.png" }] });

        const uploadBody = new FormData();
        uploadBody.set("file", new File([new Uint8Array([1, 2, 3])], "receipt.pdf", { type: "application/pdf" }));
        const uploadedFile = await api.request(filesUrl, { method: "POST", body: uploadBody });
        expect(uploadedFile.status).toBe(200);
        const uploadedFileBody = (await uploadedFile.json()) as { id: string };
        const contentUrl = `${filesUrl.slice(0, filesUrl.indexOf("?"))}/${uploadedFileBody.id}/content?request_id=${body.recordId}`;
        const content = await api.request(contentUrl);
        expect(content.status).toBe(200);
        expect(content.headers.get("content-type")).toBe("application/pdf");
        expect(new Uint8Array(await content.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        const replacementBody = new FormData();
        replacementBody.set("file", new File([new Uint8Array([4, 5, 6])], "receipt-v2.pdf", { type: "application/pdf" }));
        const replacedFile = await api.request(
          `${filesUrl.slice(0, filesUrl.indexOf("?"))}/${uploadedFileBody.id}?request_id=${body.recordId}`,
          { method: "PUT", body: replacementBody },
        );
        expect(replacedFile.status).toBe(200);
        const replacedFileBody = (await replacedFile.json()) as { id: string };
        expect(replacedFileBody.id).not.toBe(uploadedFileBody.id);
        expect((await api.request(contentUrl)).status).toBe(404);
        const replacedContentUrl = `${filesUrl.slice(0, filesUrl.indexOf("?"))}/${replacedFileBody.id}/content?request_id=${body.recordId}`;
        const replacedContent = await api.request(replacedContentUrl);
        expect(new Uint8Array(await replacedContent.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
        expect(
          (
            await api.request(`${filesUrl.slice(0, filesUrl.indexOf("?"))}/${replacedFileBody.id}?request_id=${body.recordId}`, {
              method: "DELETE",
            })
          ).status,
        ).toBe(204);
        expect((await api.request(replacedContentUrl)).status).toBe(404);

        const staleRecord = await api.request(recordUrl, {
          method: "PATCH",
          headers: { "content-type": "application/json", "If-Match": "1" },
          body: JSON.stringify({ values: { [fieldPublicId]: "stale update" } }),
        });
        expect(staleRecord.status).toBe(409);

        const commentsUrl = `/apps/runtime/${applied.data.shortId}/request/discussion/comments?request_id=${body.recordId}`;
        expect((await publicApi.request(commentsUrl)).status).toBe(401);
        const createdComment = await api.request(commentsUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `custom-app-${baseId}` },
          body: JSON.stringify({ body: "Ready for review" }),
        });
        expect(createdComment.status).toBe(201);
        const comment = (await createdComment.json()) as { id: string; body: string };
        expect(comment.body).toBe("Ready for review");

        const listedComments = await api.request(commentsUrl);
        expect(listedComments.status).toBe(200);
        const page = (await listedComments.json()) as { items: Array<{ id: string; body: string }>; nextCursor: string | null };
        expect(page).toMatchObject({ items: [{ id: comment.id, body: "Ready for review" }], nextCursor: null });

        const actionDefinition = structuredClone(definition);
        const actionAvailability = `from table {${tablePublicId}}\nwhere record.id = @params.request_id and {${fieldPublicId}} = 'Certificate request updated'\nlimit 1`;
        actionDefinition.pages[1]!.rows[0]!.columns[0]!.blocks.push({
          id: "actions",
          type: "actions",
          actions: [
            {
              id: "approve",
              label: "Approve",
              kind: "workflow",
              launcherId: launcherPublicId,
              inputs: { request: { source: "RECORD", path: "id" } },
              availableWhen: { query: actionAvailability },
            },
          ],
        });
        const viewSource = `from table {${tablePublicId}}\nselect {${fieldPublicId}}`;
        actionDefinition.pages[1]!.rows[0]!.columns[0]!.blocks.push({
          id: "request-view",
          type: "records",
          searchable: true,
          pageSize: 25,
          source: { kind: "view", viewId: viewPublicId },
          display: { kind: "table", columnIds: [fieldPublicId] },
        });
        const rowSource = `from table {${tablePublicId}}`;
        actionDefinition.pages[1]!.rows[0]!.columns[0]!.blocks.push({
          id: "requests",
          type: "records",
          searchable: true,
          pageSize: 25,
          source: { kind: "gql", query: rowSource },
          display: { kind: "table", columnIds: [] },
          rowActions: [
            {
              id: "approve-row",
              label: "Approve row",
              showLabel: true,
              kind: "workflow",
              launcherId: launcherPublicId,
              inputs: { request: { source: "ROW", path: "id" } },
            },
          ],
        });
        const authenticatedUser = userFor(authUser.id);
        const actionContext = buildCustomAppRuntimeContext({
          access: { actor: { kind: "user", user: authenticatedUser }, accessSubject: { type: "user", userId: authUser.id } },
          app: { shortId: appPublicId, name: definition.name },
          base: { shortId: basePublicId, name: "Grids App API" },
          page: actionDefinition.pages[1]!,
          pageUrl: `/apps/${applied.data.shortId}/request?request_id=${body.recordId}`,
          pageParams: { request_id: body.recordId },
          dateConfig: { timeZone: "UTC" },
          authSubjectIds: [authUser.id],
        });
        const compiledActionAvailability = await compileCustomAppQuery({
          baseId,
          source: actionAvailability,
          context: actionContext.query,
        });
        if (!compiledActionAvailability.ok) throw new Error(compiledActionAvailability.error);
        const compiledRowSource = await compileCustomAppQuery({ baseId, source: rowSource, context: actionContext.query });
        if (!compiledRowSource.ok) throw new Error(compiledRowSource.error);
        const compiledViewSource = await compileCustomAppQuery({ baseId, source: viewSource, context: actionContext.query });
        if (!compiledViewSource.ok) throw new Error(compiledViewSource.error);
        const actionCapability = {
          target: "action" as const,
          pageId: "request",
          blockId: "actions",
          actionId: "approve",
          sourceHash: customAppViewSourceHash(baseId, actionAvailability),
          planHash: compiledActionAvailability.data.planHash,
          tableIds: [tableId],
        };
        const [stored] = await sql<Array<{ published_capabilities: Record<string, unknown> }>>`
        SELECT published_capabilities FROM grids.custom_apps WHERE id = ${appId}::uuid
      `;
        if (!stored) throw new Error("Published Grids App is missing");
        await sql`
        UPDATE grids.custom_apps
        SET published_definition = ${JSON.stringify(actionDefinition)}::jsonb,
            published_capabilities = ${JSON.stringify({
              ...stored.published_capabilities,
              availability: [...((stored.published_capabilities.availability as unknown[]) ?? []), actionCapability],
              recordQueries: [
                ...((stored.published_capabilities.recordQueries as unknown[]) ?? []),
                {
                  pageId: "request",
                  blockId: "requests",
                  primaryTableId: tableId,
                  planHash: compiledRowSource.data.planHash,
                  tableIds: [tableId],
                },
              ],
              views: [
                ...((stored.published_capabilities.views as unknown[]) ?? []),
                {
                  viewId,
                  tableId,
                  sourceHash: customAppViewSourceHash(tableId, viewSource),
                  planHash: compiledViewSource.data.planHash,
                  tableIds: [tableId],
                },
              ],
              workflowLaunchers: [
                { pageId: "request", blockId: "actions", actionId: "approve", launcherId, workflowId, revision: 1 },
                { pageId: "request", blockId: "requests", actionId: "approve-row", launcherId, workflowId, revision: 1 },
              ],
            })}::jsonb
        WHERE id = ${appId}::uuid
      `;
        expect(await getPublishedByShortId(applied.data.shortId)).not.toBeNull();
        const searchableRecords = await sql<Array<{ id: string; public_id: string; subject: string }>>`
        INSERT INTO grids.records (id, short_id, table_id, data, created_by, updated_by)
        SELECT
          gen_random_uuid(),
          generated.short_id,
          ${tableId}::uuid,
          jsonb_build_object(
            ${fieldId}::text,
            CASE WHEN generated.index = 130 THEN 'Unique searchable needle' ELSE 'Generated request ' || generated.index::text END
          ),
          ${authUser.id}::uuid,
          ${authUser.id}::uuid
        FROM jsonb_array_elements_text((${{ ids: Array.from({ length: 130 }, () => testShortId("X")) }}::jsonb)->'ids')
          WITH ORDINALITY AS generated(short_id, index)
        RETURNING id::text, short_id AS public_id, data->>${fieldId}::text AS subject
      `;
        const searchableRecord = searchableRecords.find((record) => record.subject === "Unique searchable needle");
        if (!searchableRecord) throw new Error("Search fixture record is missing");
        const searchableRecordId = searchableRecord.public_id;
        const recordsUrl = `/apps/runtime/${applied.data.shortId}/request/requests/records?request_id=${body.recordId}`;
        const firstRecordsResponse = await api.request(recordsUrl);
        expect(firstRecordsResponse.status).toBe(200);
        const firstRecords = (await firstRecordsResponse.json()) as Extract<DslQueryPreviewResponse, { ok: true }> & {
          presentation?: { fields: Array<{ id: string; type: string }> };
        };
        expect(firstRecords.rows).toHaveLength(25);
        expect(firstRecords.presentation?.fields).toContainEqual(expect.objectContaining({ id: fieldPublicId, type: "text" }));
        expect(firstRecords.page?.nextCursor).toBeString();
        const secondRecordsResponse = await api.request(`${recordsUrl}&cursor=${encodeURIComponent(firstRecords.page?.nextCursor ?? "")}`);
        expect(secondRecordsResponse.status).toBe(200);
        const secondRecords = (await secondRecordsResponse.json()) as Extract<DslQueryPreviewResponse, { ok: true }>;
        expect(secondRecords.rows).toHaveLength(25);
        expect(new Set([...firstRecords.rows, ...secondRecords.rows].map((row) => row.recordId)).size).toBe(50);

        const searchedRecordsResponse = await api.request(`${recordsUrl}&q=${encodeURIComponent("Unique searchable needle")}`);
        expect(searchedRecordsResponse.status).toBe(200);
        const searchedRecords = (await searchedRecordsResponse.json()) as Extract<DslQueryPreviewResponse, { ok: true }>;
        expect(searchedRecords.rows.map((row) => row.recordId)).toEqual([searchableRecordId]);
        const injectionResponse = await api.request(`${recordsUrl}&q=${encodeURIComponent("%' OR TRUE --")}`);
        expect(injectionResponse.status).toBe(200);
        const injectionResult = (await injectionResponse.json()) as Extract<DslQueryPreviewResponse, { ok: true }>;
        expect(injectionResult.rows).toHaveLength(0);
        const viewRecordsUrl = `/apps/runtime/${applied.data.shortId}/request/request-view/records?request_id=${body.recordId}`;
        const searchedViewResponse = await api.request(`${viewRecordsUrl}&q=${encodeURIComponent("Unique searchable needle")}`);
        expect(searchedViewResponse.status).toBe(200);
        const searchedView = (await searchedViewResponse.json()) as Extract<DslQueryPreviewResponse, { ok: true }>;
        expect(searchedView.rows.map((row) => row.recordId)).toEqual([searchableRecordId]);
        expect((await api.request(`${recordsUrl}&cursor=not-a-signed-cursor`)).status).toBe(400);

        const anonymousAction = await publicApi.request(
          `/apps/runtime/${applied.data.shortId}/request/actions/actions/approve?request_id=${body.recordId}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId: testUuid() }),
          },
        );
        expect(anonymousAction.status).toBe(401);
        const directAvailability = await executePublishedCustomAppQuery({
          baseId,
          source: actionAvailability,
          capability: actionCapability,
          context: actionContext.query,
          signal: new AbortController().signal,
          timeZone: "UTC",
          viewer: { userId: authUser.id, userGroups: [], isAdmin: true },
          maxRows: 1,
          maxResultBytes: 64_000,
        });
        if (!directAvailability.ok) throw new Error(directAvailability.diagnostics[0]?.message);
        expect(directAvailability.ok).toBe(true);
        expect(directAvailability.rows).toHaveLength(1);
        const changedPlanCapability = await executePublishedCustomAppQuery({
          baseId,
          source: actionAvailability,
          capability: { ...actionCapability, planHash: "0".repeat(64) },
          context: actionContext.query,
          signal: new AbortController().signal,
          timeZone: "UTC",
          viewer: { userId: authUser.id, userGroups: [] },
          maxRows: 1,
          maxResultBytes: 64_000,
        });
        expect(changedPlanCapability).toEqual({
          ok: false,
          diagnostics: [{ message: "This published data source no longer matches its query plan capability snapshot." }],
        });
        const changedTableCapability = await executePublishedCustomAppQuery({
          baseId,
          source: actionAvailability,
          capability: { ...actionCapability, tableIds: [baseId] },
          context: actionContext.query,
          signal: new AbortController().signal,
          timeZone: "UTC",
          viewer: { userId: authUser.id, userGroups: [] },
          maxRows: 1,
          maxResultBytes: 64_000,
        });
        expect(changedTableCapability).toEqual({
          ok: false,
          diagnostics: [{ message: "This published data source no longer matches its table capability snapshot." }],
        });
        const actionResponse = await api.request(
          `/apps/runtime/${applied.data.shortId}/request/actions/actions/approve?request_id=${body.recordId}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId: testUuid() }),
          },
        );
        expect(actionResponse.status).toBe(202);
        expect(actionInvocation).toMatchObject({
          launcherId,
          expectedRevision: 1,
          inputs: { request: recordId },
          authorization: {
            kind: "custom-app-action",
            customAppId: appId,
            publishedAt: expect.any(String),
            pageId: "request",
            pageParams: { request_id: recordId },
            timeZone: "UTC",
            blockId: "actions",
            actionId: "approve",
            revision: 1,
          },
        });
        const statusRuns = new Map<
          string,
          {
            principal: GridsWorkflowPrincipal;
            authorization: GridsWorkflowAuthorization;
            launcherId: string;
            channel: "customApp" | "scanner";
          }
        >();
        const createStatusApi = (serviceAccountId: string) =>
          new Hono<AuthContext>().route(
            "/apps",
            createCustomAppsApi({
              requireAuthenticated: authenticateAsDelegatedServiceAccount(authenticatedUser, serviceAccountId),
              invokeCustomAppLauncher: async (input) => {
                const invocation = input as CustomAppLauncherInvocation;
                const runId = testUuid();
                if (!invocation.authorization) throw new Error("Grids App action authorization is missing");
                statusRuns.set(runId, {
                  principal: invocation.principal,
                  authorization: invocation.authorization,
                  launcherId: invocation.launcherId,
                  channel: "customApp",
                });
                await registerWorkflowRun(runId, "customApp");
                return ok({
                  runId,
                  workflowId,
                  revision: "1",
                  mode: "execute",
                  channel: "customApp",
                  created: true,
                  status: "queued",
                });
              },
              invokeScannerLauncher: async (input) => {
                const invocation = input as ScannerLauncherInvocation;
                const runId = testUuid();
                if (!invocation.authorization) throw new Error("Grids App scanner authorization is missing");
                statusRuns.set(runId, {
                  principal: invocation.principal,
                  authorization: invocation.authorization,
                  launcherId: invocation.launcherId,
                  channel: "scanner",
                });
                await registerWorkflowRun(runId, "scanner");
                return ok({
                  runId,
                  workflowId,
                  revision: "1",
                  mode: "execute",
                  channel: "scanner",
                  created: true,
                  status: "queued",
                });
              },
              getWorkflowRunScope: async (runId): Promise<GridsWorkflowRunScope | null> => {
                const accepted = statusRuns.get(runId);
                return accepted
                  ? {
                      runId,
                      baseId,
                      workflow: { id: workflowId, shortId: testShortId("W"), name: "Approve request" },
                      principal: accepted.principal,
                      authorization: accepted.authorization,
                      launcherId: accepted.launcherId,
                    }
                  : null;
              },
              getWorkflowRun: async (runId): Promise<GridsWorkflowRun | null> => {
                const accepted = statusRuns.get(runId);
                return accepted
                  ? {
                      id: runId,
                      workflowId,
                      launcherId: accepted.launcherId,
                      baseId,
                      workflowRevision: 1,
                      mode: "execute",
                      channel: accepted.channel,
                      actorUserId: accepted.principal.userId,
                      serviceAccountId: accepted.principal.serviceAccountId,
                      inputs: {},
                      status: "succeeded",
                      result: null,
                      error: null,
                      resultMessage: "Approved",
                      createdAt: "2026-01-01T00:00:00.000Z",
                      startedAt: "2026-01-01T00:00:00.000Z",
                      finishedAt: "2026-01-01T00:00:01.000Z",
                    }
                  : null;
              },
            }),
          );
        const firstServiceAccountApi = createStatusApi(testUuid());
        const secondServiceAccountApi = createStatusApi(testUuid());
        const delegatedActionResponse = await firstServiceAccountApi.request(
          `/apps/runtime/${applied.data.shortId}/request/actions/actions/approve?request_id=${body.recordId}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId: testUuid() }),
          },
        );
        expect(delegatedActionResponse.status).toBe(202);
        const delegatedAction = (await delegatedActionResponse.json()) as { statusUrl: string };
        const statusPath = delegatedAction.statusUrl.replace(/^\/api\/grids/, "");
        const ownStatus = await firstServiceAccountApi.request(statusPath);
        expect(ownStatus.status).toBe(200);
        expect(await ownStatus.json()).toEqual({ status: "succeeded", message: "Approved" });
        expect((await secondServiceAccountApi.request(statusPath)).status).toBe(404);

        actionInvocation = null;
        const rowActionUrl = `/apps/runtime/${applied.data.shortId}/request/requests/row-actions/approve-row?request_id=${body.recordId}`;
        const searchedRowAction = await api.request(rowActionUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operationId: testUuid(),
            rowId: searchableRecordId,
            search: "Unique searchable needle",
          }),
        });
        expect(searchedRowAction.status).toBe(202);
        expect(actionInvocation).toMatchObject({ inputs: { request: searchableRecord.id } });
        actionInvocation = null;
        const rowActionResponse = await api.request(rowActionUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operationId: testUuid(), rowId: body.recordId }),
        });
        expect(rowActionResponse.status).toBe(202);
        expect(actionInvocation).toMatchObject({
          inputs: { request: recordId },
          authorization: { blockId: "requests", actionId: "approve-row" },
        });
        actionInvocation = null;

        const scannerBlock = { id: "returns", type: "scanner" as const, launcherId: launcherPublicId };
        actionDefinition.pages[0]!.rows[0]!.columns[0]!.blocks.push(scannerBlock);
        const scannerConfigHash = "a".repeat(64);
        const [scannerStored] = await sql<Array<{ published_capabilities: Record<string, unknown> }>>`
        SELECT published_capabilities FROM grids.custom_apps WHERE id = ${appId}::uuid
      `;
        if (!scannerStored) throw new Error("Published Grids App is missing");
        const scannerCapabilities = CustomAppCapabilitiesSchema.safeParse({
          ...parseJsonbRow(scannerStored.published_capabilities, {}),
          scannerLaunchers: [
            {
              pageId: "home",
              blockId: scannerBlock.id,
              launcherId,
              workflowId,
              revision: 1,
              configHash: scannerConfigHash,
            },
          ],
        });
        expect(scannerCapabilities.success, scannerCapabilities.success ? undefined : scannerCapabilities.error.message).toBe(true);
        if (!scannerCapabilities.success) throw new Error(scannerCapabilities.error.message);
        await sql`
        UPDATE grids.custom_apps
        SET published_definition = ${JSON.stringify(actionDefinition)}::jsonb,
            published_capabilities = ${JSON.stringify(scannerCapabilities.data)}::jsonb
        WHERE id = ${appId}::uuid
      `;
        const scannerPublished = await getPublishedByShortId(applied.data.shortId);
        expect(scannerPublished?.publishedDefinition).not.toBeNull();
        expect(scannerPublished?.publishedCapabilities?.scannerLaunchers).toHaveLength(1);
        const scannerPath = `/apps/runtime/${applied.data.shortId}/home/${scannerBlock.id}/scanner`;
        expect(
          (
            await publicApi.request(scannerPath, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ operationId: testUuid(), expectedRevision: 1, scannedText: "ITEM-42", inputs: {} }),
            })
          ).status,
        ).toBe(401);
        const scannerResponse = await api.request(scannerPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operationId: testUuid(), expectedRevision: 1, scannedText: "ITEM-42", inputs: {} }),
        });
        expect(scannerResponse.status).toBe(202);
        expect(scannerInvocation).toMatchObject({
          launcherId,
          expectedRevision: 1,
          scannedText: "ITEM-42",
          authorization: {
            kind: "custom-app-scanner",
            customAppId: appId,
            publishedAt: expect.any(String),
            pageId: "home",
            pageParams: {},
            timeZone: "UTC",
            blockId: scannerBlock.id,
            revision: 1,
            configHash: scannerConfigHash,
          },
        });
        const delegatedScannerResponse = await firstServiceAccountApi.request(scannerPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operationId: testUuid(), expectedRevision: 1, scannedText: "ITEM-43", inputs: {} }),
        });
        expect(delegatedScannerResponse.status).toBe(202);
        const delegatedScanner = (await delegatedScannerResponse.json()) as { statusUrl: string };
        const scannerStatusPath = delegatedScanner.statusUrl.replace(/^\/api\/grids/, "");
        expect((await firstServiceAccountApi.request(scannerStatusPath)).status).toBe(200);
        expect((await secondServiceAccountApi.request(scannerStatusPath)).status).toBe(404);
        await sql`UPDATE grids.workflow_launchers SET enabled = false WHERE id = ${launcherId}::uuid`;
        expect((await firstServiceAccountApi.request(scannerStatusPath)).status).toBe(200);
        await sql`UPDATE grids.workflow_launchers SET enabled = true WHERE id = ${launcherId}::uuid`;
        const forgedRowResponse = await api.request(rowActionUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operationId: testUuid(), rowId: testShortId("Z") }),
        });
        expect(forgedRowResponse.status).toBe(404);
        expect(actionInvocation).toBeNull();

        const hiddenRecord = await api.request(recordUrl, {
          method: "PATCH",
          headers: { "content-type": "application/json", "If-Match": "2" },
          body: JSON.stringify({ values: { [fieldPublicId]: "Hidden" } }),
        });
        expect(hiddenRecord.status).toBe(200);
        actionInvocation = null;
        const hiddenAction = await api.request(
          `/apps/runtime/${applied.data.shortId}/request/actions/actions/approve?request_id=${body.recordId}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId: testUuid() }),
          },
        );
        expect(hiddenAction.status).toBe(404);
        expect(actionInvocation).toBeNull();
        const hiddenActionStatus = await firstServiceAccountApi.request(statusPath);
        expect(hiddenActionStatus.status).toBe(200);
        expect(await hiddenActionStatus.json()).toEqual({ status: "succeeded", message: "Approved" });
        const hiddenBlockDefinition = structuredClone(actionDefinition);
        const hiddenActionBlock = hiddenBlockDefinition.pages[1]!.rows[0]!.columns[0]!.blocks.find((block) => block.id === "actions");
        if (!hiddenActionBlock) throw new Error("Action block is missing");
        hiddenActionBlock.availableWhen = {
          query: `from table {${tablePublicId}}\nwhere {${fieldPublicId}} = 'No matching action block record'\nlimit 1`,
        };
        await sql`
          UPDATE grids.custom_apps
          SET published_definition = ${hiddenBlockDefinition}::jsonb
          WHERE id = ${appId}::uuid
        `;
        expect((await firstServiceAccountApi.request(statusPath)).status).toBe(200);
        await sql`
          DELETE FROM grids.custom_app_access
          WHERE custom_app_id = ${appId}::uuid AND access_id = ${appGrant.data.accessId}::uuid
        `;
        expect((await firstServiceAccountApi.request(statusPath)).status).toBe(404);
        await sql`
          INSERT INTO grids.custom_app_access (custom_app_id, access_id)
          VALUES (${appId}::uuid, ${appGrant.data.accessId}::uuid)
        `;

        const blockAvailability = `from table {${tablePublicId}}\nwhere {${fieldPublicId}} = 'No matching form record'\nlimit 1`;
        const unavailableFormDefinition = structuredClone(actionDefinition);
        const unavailableForm = unavailableFormDefinition.pages[0]!.rows[0]!.columns[0]!.blocks[0]!;
        unavailableForm.availableWhen = { query: blockAvailability };
        const compiledBlockAvailability = await compileCustomAppQuery({
          baseId,
          source: blockAvailability,
          context: actionContext.query,
        });
        if (!compiledBlockAvailability.ok) throw new Error(compiledBlockAvailability.error);
        const [actionCapabilities] = await sql<Array<{ published_capabilities: Record<string, unknown> }>>`
        SELECT published_capabilities FROM grids.custom_apps WHERE id = ${appId}::uuid
      `;
        if (!actionCapabilities) throw new Error("Published Grids App capabilities are missing");
        const unavailableFormCapabilities = {
          ...actionCapabilities.published_capabilities,
          availability: [
            ...((actionCapabilities.published_capabilities.availability as unknown[]) ?? []),
            {
              target: "block",
              pageId: "home",
              blockId: "apply",
              sourceHash: customAppViewSourceHash(baseId, blockAvailability),
              planHash: compiledBlockAvailability.data.planHash,
              tableIds: [tableId],
            },
          ],
        };
        await sql`
        UPDATE grids.custom_apps
        SET published_definition = ${unavailableFormDefinition}::jsonb,
            published_capabilities = ${unavailableFormCapabilities}::jsonb
        WHERE id = ${appId}::uuid
      `;
        const unavailableFormResponse = await publicApi.request(`/apps/runtime/${applied.data.shortId}/home/apply/submit`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `custom-app-block-${baseId}` },
          body: JSON.stringify({ [fieldPublicId]: "Must not be created" }),
        });
        expect(unavailableFormResponse.status).toBe(404);

        const pageAvailability = `from table {${tablePublicId}}\nwhere {${fieldPublicId}} = 'No matching page record'\nlimit 1`;
        const unavailablePageDefinition = structuredClone(unavailableFormDefinition);
        unavailablePageDefinition.pages[0]!.availableWhen = { query: pageAvailability };
        const compiledPageAvailability = await compileCustomAppQuery({
          baseId,
          source: pageAvailability,
          context: actionContext.query,
        });
        if (!compiledPageAvailability.ok) throw new Error(compiledPageAvailability.error);
        await sql`
        UPDATE grids.custom_apps
        SET published_definition = ${unavailablePageDefinition}::jsonb,
            published_capabilities = ${{
              ...unavailableFormCapabilities,
              availability: [
                ...((unavailableFormCapabilities.availability as unknown[]) ?? []),
                {
                  target: "page",
                  pageId: "home",
                  sourceHash: customAppViewSourceHash(baseId, pageAvailability),
                  planHash: compiledPageAvailability.data.planHash,
                  tableIds: [tableId],
                },
              ],
            }}::jsonb
        WHERE id = ${appId}::uuid
      `;
        const unavailablePageResponse = await publicApi.request(`/apps/runtime/${applied.data.shortId}/home/apply/submit`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `custom-app-page-${baseId}` },
          body: JSON.stringify({ [fieldPublicId]: "Must not be created" }),
        });
        expect(unavailablePageResponse.status).toBe(404);
        const unavailableStatusPageDefinition = structuredClone(unavailablePageDefinition);
        unavailableStatusPageDefinition.pages[1]!.availableWhen = { query: pageAvailability };
        await sql`
          UPDATE grids.custom_apps
          SET published_definition = ${unavailableStatusPageDefinition}::jsonb,
              published_capabilities = ${{
                ...unavailableFormCapabilities,
                availability: [
                  ...((unavailableFormCapabilities.availability as unknown[]) ?? []),
                  {
                    target: "page",
                    pageId: "request",
                    sourceHash: customAppViewSourceHash(baseId, pageAvailability),
                    planHash: compiledPageAvailability.data.planHash,
                    tableIds: [tableId],
                  },
                ],
              }}::jsonb
          WHERE id = ${appId}::uuid
        `;
        expect((await firstServiceAccountApi.request(statusPath)).status).toBe(404);

        await sql`
        UPDATE grids.custom_apps
        SET published_definition = ${{ schemaVersion: 1, kind: "grids.custom-app" }}::jsonb
        WHERE id = ${appId}::uuid
      `;
        const legacyRuntime = await publicApi.request(`/apps/runtime/${applied.data.shortId}/home/apply/submit`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `custom-app-v1-${baseId}` },
          body: JSON.stringify({ [fieldPublicId]: "Must not be created" }),
        });
        expect(legacyRuntime.status).toBe(404);
      } finally {
        await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
        await sql`DELETE FROM grids.record_event_outbox WHERE base_id = ${baseId}::uuid`;
        if (userBaseAccessId) {
          await sql`DELETE FROM grids.base_access WHERE base_id = ${baseId}::uuid AND access_id = ${userBaseAccessId}::uuid`;
          await sql`DELETE FROM auth.access WHERE id = ${userBaseAccessId}::uuid`;
        }
        // Issued documents and their artifacts are immutable; the integration database owns fixture teardown.
      }
    },
    30_000,
  );
});
