import { beforeAll, expect, test } from "bun:test";
import { accounts, serviceAccountCredentials } from "@k2b/cloud/services";
import { createTestBrowserSignIn } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { apply, publish } from "../service/custom-apps";
import { deleteTestWorkflowScope } from "../service/workflow-test-fixture";
import { WORKFLOW_REVISION_HEADER } from "../workflows/contracts";
import api from ".";

const suite = suiteFor("database", "nats", "valkey");
const scheduled = `triggers:
  schedule:
    cron: "0 8 * * *"
    timezone: UTC
steps:
  - succeed:
      message: Done`;
const plain = `steps:
  - succeed:
      message: Done`;

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

type Call = (path: string, method?: string, body?: unknown, extraHeaders?: Record<string, string>) => Promise<Response>;
const caller =
  (headers: Record<string, string>): Call =>
  async (path, method = "GET", body, extraHeaders) =>
    api.request(path, {
      method,
      headers: {
        ...headers,
        ...extraHeaders,
        "x-forwarded-for": uniqueCallerAddress(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
const tokenCaller = async (accountId: string, scopes = ["grids:admin"]): Promise<Call> => {
  const credential = await serviceAccountCredentials.createApiToken({ serviceAccountId: accountId, name: "Grids parity", scopes });
  if (!credential.ok) throw new Error(credential.error.message);
  return caller({ authorization: `Bearer ${credential.data.token}` });
};

suite("Grids explicit machine principals", () => {
  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind}: human grants, real bearer, independent App/Base boundaries and revocation`, async () => {
      const ownerId = testUuid();
      // Auth account IDs use gen_random_uuid(), unlike Grids resource UUIDv7 fixtures.
      const accountId = crypto.randomUUID();
      const boundId = crypto.randomUUID();
      const guestId = testUuid();
      const baseId = testUuid();
      const baseShortId = testShortId();
      const tableId = testUuid();
      const tableShortId = testShortId();
      const fieldId = testUuid();
      const fieldShortId = testShortId();
      const formId = testUuid();
      const formShortId = testShortId();
      const accessIds: string[] = [];
      const delegatedAccounts: string[] = [];
      const accountName = `Parity ${kind} ${accountId}`;
      try {
        await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
          VALUES (${ownerId}::uuid, ${`grids-parity-${ownerId}`}, 'local', 'user', 'Grids author')`;
        await sql`INSERT INTO auth.service_accounts (id, name, kind)
          VALUES (${accountId}::uuid, ${accountName}, ${kind})`;
        await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Parity base')`;
        await sql`INSERT INTO grids.tables (id, short_id, base_id, name)
          VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Assignments')`;
        await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
          VALUES (${fieldId}::uuid, ${fieldShortId}, ${tableId}::uuid, 'Participants', 'principal', '{}'::jsonb, 0)`;
        await sql`INSERT INTO grids.forms (id, short_id, table_id, name, config, is_active, position)
          VALUES (${formId}::uuid, ${formShortId}, ${tableId}::uuid, 'Assignment',
            ${{ fields: [{ kind: "user_input", fieldId }] }}::jsonb, TRUE, 0)`;
        const ownerAccessId = testUuid();
        accessIds.push(ownerAccessId);
        await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${ownerAccessId}::uuid, ${ownerId}::uuid, 'admin')`;
        await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${ownerAccessId}::uuid)`;
        await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
          VALUES (${guestId}::uuid, ${`grids-parity-guest-${guestId}`}, 'local', 'guest', 'Restricted guest')`;
        await sql`INSERT INTO auth.service_accounts (id, name, kind, app_id, resource_type, resource_id)
          VALUES (${boundId}::uuid, 'Bound parity key', 'resource_bound', 'grids', 'base', ${baseId})`;
        // A personal API credential retains the human access subject and directory
        // visibility. Standalone/agent callers below authenticate as themselves.
        const asHuman = async (userId: string) => {
          const user = await accounts.users.get({ id: userId });
          if (!user) throw new Error("Missing personal-key owner");
          const credential = await serviceAccountCredentials.createUserApiToken({
            name: "Grids author key",
            user,
            browserSignIn: await createTestBrowserSignIn(userId),
          });
          if (!credential.ok) throw new Error(credential.error.message);
          expect(credential.data.credential.scopes).toEqual([]);
          delegatedAccounts.push(credential.data.credential.serviceAccountId);
          return caller({ authorization: `Bearer ${credential.data.token}` });
        };
        const human = await asHuman(ownerId);
        const machine = await tokenCaller(accountId);
        const app = await apply({
          schemaVersion: 5,
          kind: "grids.custom-app",
          id: testShortId(),
          baseId: baseShortId,
          name: "Explicit machine app",
          startPageId: "home",
          pages: [
            {
              id: "home",
              title: "Home",
              navigation: { visible: true },
              parameters: {},
              rows: [
                { id: "intro", columns: [{ id: "main", span: 12, blocks: [{ id: "intro", type: "markdown", markdown: "Granted" }] }] },
              ],
            },
            {
              id: "mine",
              title: "My assignments",
              navigation: { visible: true },
              parameters: {},
              availableWhen: { query: `from table {${tableShortId}}\nwhere oneof(Participants, @auth.subjects)` },
              rows: [
                {
                  id: "mine",
                  columns: [{ id: "main", span: 12, blocks: [{ id: "mine", type: "markdown", markdown: "Assigned to you" }] }],
                },
              ],
            },
          ],
        });
        if (!app.ok) throw new Error(app.error.message);
        const published = await publish(app.data.id);
        if (!published.ok) throw new Error(published.error.message);
        const appPath = `/apps/runtime/${app.data.shortId}`;
        expect((await machine(appPath)).status).toBe(404);
        expect((await machine(`/bases/${baseShortId}`)).status).toBe(403);
        const grant = async (path: string, permission: string) => {
          const response = await human(path, "POST", { principal: { type: "service_account", serviceAccountId: accountId }, permission });
          expect(response.status).toBe(201);
          const body = (await response.json()) as { accessId: string };
          accessIds.push(body.accessId);
          return body.accessId;
        };
        const appAccess = `/access/by-custom-app/${app.data.shortId}`;
        const appGrantId = await grant(appAccess, "read");
        expect((await machine(appPath)).status).toBe(200);
        expect((await machine(`/bases/${baseShortId}`)).status).toBe(403);
        expect(await (await human(appAccess)).json()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              principal: { type: "service_account", serviceAccountId: accountId },
              displayName: accountName,
              serviceAccountKind: kind,
            }),
          ]),
        );
        const insufficientScope = await tokenCaller(accountId, ["openid"]);
        expect((await insufficientScope(appPath)).status).toBe(404);

        // Persisted legacy app grants cannot widen a resource-bound credential.
        const boundGrant = await human(appAccess, "POST", {
          principal: { type: "service_account", serviceAccountId: boundId },
          permission: "read",
        });
        expect(boundGrant.status).toBe(400);
        const legacyBoundGrant = testUuid();
        accessIds.push(legacyBoundGrant);
        await sql`INSERT INTO auth.access (id, service_account_id, permission) VALUES (${legacyBoundGrant}::uuid, ${boundId}::uuid, 'read')`;
        await sql`INSERT INTO grids.custom_app_access (custom_app_id, access_id) VALUES (${app.data.id}::uuid, ${legacyBoundGrant}::uuid)`;
        const bound = await tokenCaller(boundId);
        expect((await bound(appPath)).status).toBe(404);

        const baseGrantId = await grant(`/access/by-base/${baseShortId}`, "admin");
        expect(await (await machine(`/access/by-base/${baseShortId}`)).json()).toEqual(
          expect.arrayContaining([expect.objectContaining({ displayName: accountName, serviceAccountKind: kind })]),
        );
        expect((await machine(`/bases/${baseShortId}`)).status).toBe(200);
        const values = [{ type: "service_account", id: accountId }];
        const created = await human(`/records/by-table/${tableShortId}`, "POST", { [fieldShortId]: values });
        expect(created.status).toBe(201);
        const record = (await created.json()) as { id: string; data: Record<string, unknown> };
        expect(record.data[fieldShortId]).toEqual(values);
        const updatedValues = [...values, { type: "user", id: ownerId }];
        const update = await human(`/records/${tableShortId}/${record.id}`, "PATCH", { values: { [fieldShortId]: updatedValues } });
        expect(update.status).toBe(200);
        expect((await update.json()).data[fieldShortId]).toEqual(updatedValues);
        const form = await human(`/forms/${formShortId}/submit`, "POST", { [fieldShortId]: values });
        expect(form.status).toBe(201);
        const query = { query: { filter: { fieldId: fieldShortId, op: "containsAny", value: [accountId] } } };
        const humanQuery = await human(`/tables/${tableShortId}/query`, "POST", query);
        expect(humanQuery.status).toBe(200);
        const humanRows = (await humanQuery.json()) as { items: unknown[]; relationLabels: Record<string, string> };
        expect(humanRows.items).toHaveLength(2);
        expect((await machine(`${appPath}/mine`)).status).toBe(200);
        expect(humanRows.relationLabels[accountId]).toBe(accountName);
        const guestGrant = await human(`/access/by-base/${baseShortId}`, "POST", {
          principal: { type: "user", userId: guestId },
          permission: "write",
        });
        expect(guestGrant.status).toBe(201);
        accessIds.push((await guestGrant.json()).accessId);
        const guest = await asHuman(guestId);
        expect((await guest(`${appPath}/mine`)).status).toBe(404);
        const guestQuery = await guest(`/tables/${tableShortId}/query`, "POST", query);
        expect(guestQuery.status).toBe(200);
        expect((await guestQuery.json()).relationLabels?.[accountId]).toBeUndefined();
        expect((await guest(`/records/by-table/${tableShortId}`, "POST", { [fieldShortId]: values })).status).toBe(400);
        const readOnly = await tokenCaller(accountId, ["grids:read"]);
        expect((await readOnly(`/records/by-table/${tableShortId}`, "POST", {})).status).toBe(403);
        const machineQuery = await machine(`/tables/${tableShortId}/query`, "POST", query);
        expect(machineQuery.status).toBe(200);
        const machineRows = (await machineQuery.json()) as { items: unknown[]; relationLabels: Record<string, string> };
        expect(machineRows.items).toHaveLength(2);
        expect(machineRows.relationLabels[accountId]).toBeUndefined();
        // The directory deliberately requires a user. Resource access is not authority
        // to discover or validate arbitrary identities, even for an administrator token.
        expect((await machine(`/records/by-table/${tableShortId}`, "POST", { [fieldShortId]: values })).status).toBe(403);
        expect((await machine(`/forms/${formShortId}/submit`, "POST", { [fieldShortId]: values })).status).toBe(403);
        expect((await machine(`/records/${tableShortId}/${record.id}`, "PATCH", { values: { [fieldShortId]: values } })).status).toBe(403);
        const preview = await human(`/gql/by-base/${baseShortId}/preview`, "POST", { query: `from table {${tableShortId}}` });
        expect(preview.status).toBe(200);
        const previewBody = await preview.json();
        expect(previewBody.ok).toBe(true);
        expect(JSON.stringify(previewBody.rows)).toContain(accountName);
        const machinePreview = await machine(`/gql/by-base/${baseShortId}/preview`, "POST", { query: `from table {${tableShortId}}` });
        expect(machinePreview.status).toBe(200);
        const machinePreviewBody = await machinePreview.json();
        expect(machinePreviewBody.ok).toBe(true);
        expect(JSON.stringify(machinePreviewBody.rows)).toContain("Private service account");
        expect(JSON.stringify(machinePreviewBody.rows)).not.toContain(accountName);

        // No durable owner means no scheduled/event authority. Both creation and
        // later activation/source changes must refuse before creating activations.
        const workflowsPath = `/workflows/by-base/${baseShortId}`;
        for (const source of [
          scheduled,
          `triggers:\n  recordEvent:\n    event: created\n    table: Assignments\nsteps:\n  - succeed:\n      message: Done`,
        ]) {
          expect((await machine(workflowsPath, "POST", { name: "Unsafe automatic", source, enabled: true })).status).toBe(403);
          const draft = await machine(workflowsPath, "POST", { name: "Disabled automatic", source, enabled: false });
          expect(draft.status).toBe(201);
          const workflow = (await draft.json()) as { id: string; revision: number };
          expect(
            (
              await machine(
                `/workflows/${workflow.id}`,
                "PATCH",
                { enabled: true },
                { [WORKFLOW_REVISION_HEADER]: String(workflow.revision) },
              )
            ).status,
          ).toBe(403);
        }
        const direct = await machine(workflowsPath, "POST", { name: "Direct", source: plain, enabled: true });
        expect(direct.status).toBe(201);
        const directWorkflow = (await direct.json()) as { id: string; revision: number };
        expect(
          (
            await machine(
              `/workflows/${directWorkflow.id}`,
              "PATCH",
              { source: scheduled },
              { [WORKFLOW_REVISION_HEADER]: String(directWorkflow.revision) },
            )
          ).status,
        ).toBe(403);

        expect((await human(`/access/${appGrantId}`, "DELETE")).status).toBe(204);
        expect((await machine(appPath)).status).toBe(404);
        expect((await machine(`/bases/${baseShortId}`)).status).toBe(200);
        const restoredAppGrant = await grant(appAccess, "read");
        expect((await human(`/access/${baseGrantId}`, "DELETE")).status).toBe(204);
        expect((await machine(`/bases/${baseShortId}`)).status).toBe(403);
        expect((await machine(`/tables/${tableShortId}/query`, "POST", query)).status).toBe(403);
        expect((await machine(appPath)).status).toBe(200);
        expect((await machine(`${appPath}/mine`)).status).toBe(200);
        expect((await human(`/access/${restoredAppGrant}`, "DELETE")).status).toBe(204);
        expect((await machine(appPath)).status).toBe(404);
      } finally {
        await deleteTestWorkflowScope(baseId);
        await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
        if (accessIds.length) await sql`DELETE FROM auth.access WHERE id IN ${sql(accessIds)}`;
        await sql`DELETE FROM auth.service_accounts WHERE id IN ${sql([accountId, boundId, ...delegatedAccounts])}`;
        await sql`DELETE FROM auth.users WHERE id IN (${ownerId}::uuid, ${guestId}::uuid)`;
      }
    });
  }
});
