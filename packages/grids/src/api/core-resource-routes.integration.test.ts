import { beforeAll, describe, expect } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { sql } from "bun";
import { Hono } from "hono";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { dropFieldUniqueIndex, ensureFieldUniqueIndex } from "../service/field-indexes";
import { encodeRecordChangeFeedCursor } from "../service/record-change-feed";
import { deleteExpiredExternalRecordOperations } from "../service/record-external-identity";
import baseNavigationRoutes from "./base-navigation";
import basesRoutes from "./bases";
import fieldsRoutes from "./fields";
import recordsRoutes from "./records";
import tablesRoutes from "./tables";
import viewsRoutes from "./views";

type Fixture = {
  user: User;
  baseId: string;
  basePublicId: string;
  foreignBaseId: string;
  foreignBasePublicId: string;
  tableId: string;
  tablePublicId: string;
  foreignTableId: string;
  foreignTablePublicId: string;
  foreignViewId: string;
  foreignViewPublicId: string;
  uniqueFieldId: string;
  uniqueFieldPublicId: string;
  serviceAccountIds: string[];
  accessIds: string[];
  tokens: Record<"read" | "write" | "admin" | "delegated", string>;
};

const app = new Hono<AuthContext>()
  .route("/bases", basesRoutes)
  .route("/bases", baseNavigationRoutes)
  .route("/tables", tablesRoutes)
  .route("/fields", fieldsRoutes)
  .route("/records", recordsRoutes)
  .route("/views", viewsRoutes);

const jsonRequest = (token: string, body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });

const count = async (table: "tables" | "fields" | "records" | "views", column: string, value: string): Promise<number> => {
  const rows = await sql.unsafe(`SELECT count(*)::int AS count FROM grids.${table} WHERE ${column} = $1::uuid`, [value]);
  return Number((rows[0] as { count: number } | undefined)?.count ?? 0);
};

const sideEffectCounts = async (baseId: string): Promise<{ audit: number; outbox: number }> => {
  const [row] = await sql<Array<{ audit: number; outbox: number }>>`
    SELECT
      (
        SELECT count(*)::int
        FROM grids.audit_log
        WHERE base_id = ${baseId}::uuid
          OR table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)
      ) AS audit,
      (SELECT count(*)::int FROM grids.record_event_outbox WHERE base_id = ${baseId}::uuid) AS outbox
  `;
  return { audit: Number(row?.audit ?? 0), outbox: Number(row?.outbox ?? 0) };
};

const newFixture = (): Fixture => {
  const userId = testUuid();
  const user: User = {
    id: userId,
    uid: `route-matrix-${userId}`,
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "Route",
    sn: "Matrix",
    displayName: "Route Matrix",
    mail: null,
    avatarHash: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
    ipa: null,
  };

  return {
    user,
    baseId: testUuid(),
    basePublicId: testShortId("B"),
    foreignBaseId: testUuid(),
    foreignBasePublicId: testShortId("X"),
    tableId: testUuid(),
    tablePublicId: testShortId("T"),
    foreignTableId: testUuid(),
    foreignTablePublicId: testShortId("F"),
    foreignViewId: testUuid(),
    foreignViewPublicId: testShortId("V"),
    uniqueFieldId: testUuid(),
    uniqueFieldPublicId: testShortId("U"),
    serviceAccountIds: [],
    accessIds: [],
    tokens: { read: "", write: "", admin: "", delegated: "" },
  };
};

const setupFixture = async (fixture: Fixture): Promise<void> => {
  await sql`
    INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
    VALUES (
      ${fixture.user.id}::uuid,
      ${fixture.user.uid},
      'local',
      'user',
      ${fixture.user.displayName},
      ${fixture.user.givenname},
      ${fixture.user.sn}
    )
  `;
  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES
      (${fixture.baseId}::uuid, ${fixture.basePublicId}, 'Route matrix'),
      (${fixture.foreignBaseId}::uuid, ${fixture.foreignBasePublicId}, 'Foreign route matrix')
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES
      (${fixture.tableId}::uuid, ${fixture.tablePublicId}, ${fixture.baseId}::uuid, 'Items', 0),
      (${fixture.foreignTableId}::uuid, ${fixture.foreignTablePublicId}, ${fixture.foreignBaseId}::uuid, 'Foreign items', 0)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position, unique_constraint)
    VALUES (
      ${fixture.uniqueFieldId}::uuid,
      ${fixture.uniqueFieldPublicId},
      ${fixture.tableId}::uuid,
      'Serial',
      'text',
      '{}'::jsonb,
      0,
      TRUE
    )
  `;
  await ensureFieldUniqueIndex(fixture.uniqueFieldId, "text", fixture.tableId);
  await sql`
    INSERT INTO grids.views (id, short_id, table_id, base_id, name, source, ui, position)
    VALUES (
      ${fixture.foreignViewId}::uuid,
      ${fixture.foreignViewPublicId},
      ${fixture.foreignTableId}::uuid,
      ${fixture.foreignBaseId}::uuid,
      'Foreign view',
      ${`from table {${fixture.foreignTableId}}`},
      '{}'::jsonb,
      0
    )
  `;

  const account = await serviceAccounts.getOrCreateResourceBound({
    name: "Grids route matrix",
    appId: "grids",
    resourceType: "base",
    resourceId: fixture.baseId,
    createdBy: fixture.user.id,
  });
  if (!account.ok) throw new Error(account.error.message);
  fixture.serviceAccountIds.push(account.data.id);

  for (const authorizedBaseId of [fixture.baseId, fixture.foreignBaseId]) {
    const accessId = testUuid();
    fixture.accessIds.push(accessId);
    await sql`
      INSERT INTO auth.access (id, service_account_id, permission)
      VALUES (${accessId}::uuid, ${account.data.id}::uuid, 'admin'::auth.permission_level)
    `;
    await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${authorizedBaseId}::uuid, ${accessId}::uuid)`;
  }

  for (const scope of ["read", "write", "admin"] as const) {
    const credential = await serviceAccountCredentials.createResourceApiToken({
      serviceAccountId: account.data.id,
      actor: fixture.user,
      name: `Route matrix ${scope}`,
      scopes: [`grids:${scope}`],
    });
    if (!credential.ok) throw new Error(credential.error.message);
    fixture.tokens[scope] = credential.data.token;
  }

  const userAccessId = testUuid();
  fixture.accessIds.push(userAccessId);
  await sql`
    INSERT INTO auth.access (id, user_id, permission)
    VALUES (${userAccessId}::uuid, ${fixture.user.id}::uuid, 'read'::auth.permission_level)
  `;
  await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${fixture.baseId}::uuid, ${userAccessId}::uuid)`;

  const delegatedAccount = await serviceAccounts.createUserDelegated({
    name: "Grids route matrix delegated",
    delegatedUserId: fixture.user.id,
    createdBy: fixture.user.id,
  });
  if (!delegatedAccount.ok) throw new Error(delegatedAccount.error.message);
  fixture.serviceAccountIds.push(delegatedAccount.data.id);
  const delegatedCredential = await serviceAccountCredentials.createApiToken({
    serviceAccountId: delegatedAccount.data.id,
    name: "Route matrix delegated admin scope",
    createdBy: fixture.user.id,
    scopes: ["grids:admin"],
  });
  if (!delegatedCredential.ok) throw new Error(delegatedCredential.error.message);
  fixture.tokens.delegated = delegatedCredential.data.token;
};

const cleanupFixture = async (fixture: Fixture) => {
  const errors: unknown[] = [];
  const attempt = async (cleanup: () => Promise<unknown>) => {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  };

  await attempt(() => dropFieldUniqueIndex(fixture.uniqueFieldId, { throwOnError: true }));
  await attempt(
    () => sql`
      DELETE FROM grids.audit_log
      WHERE base_id IN (${fixture.baseId}::uuid, ${fixture.foreignBaseId}::uuid)
        OR table_id IN (${fixture.tableId}::uuid, ${fixture.foreignTableId}::uuid)
    `,
  );
  await attempt(() => sql`DELETE FROM grids.bases WHERE id IN (${fixture.baseId}::uuid, ${fixture.foreignBaseId}::uuid)`);
  for (const accessId of fixture.accessIds) await attempt(() => sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`);
  for (const serviceAccountId of fixture.serviceAccountIds) {
    await attempt(() => sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid`);
  }
  await attempt(() => sql`DELETE FROM auth.users WHERE id = ${fixture.user.id}::uuid`);

  if (errors.length > 0) throw new AggregateError(errors, "Route matrix fixture cleanup failed");
};

beforeAll(async () => {
  process.env.APP_SECRET ??= "grids-core-resource-routes-integration-secret";
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("classic resource route contracts", () => {
  postgresTest(
    "shared navigation enforces admin scope, base ownership, revision conflicts and harmless removal",
    async () => {
      const fixture = newFixture();
      await setupFixture(fixture);
      try {
        const path = `/bases/${fixture.basePublicId}/navigation`;
        for (const token of [fixture.tokens.read, fixture.tokens.write, fixture.tokens.delegated]) {
          expect((await app.request(path, bearer(token))).status).toBe(403);
          expect((await app.request(path, jsonRequest(token, { revision: 0, groups: [] }, "PUT"))).status).toBe(403);
        }
        expect(await (await app.request(path, bearer(fixture.tokens.admin))).json()).toEqual({ revision: 0, groups: [] });
        const group = { id: "GROUP1", name: "Operations", entries: [{ type: "table", id: fixture.tablePublicId }] };
        const save = (revision: number, groups: unknown[]) =>
          app.request(path, jsonRequest(fixture.tokens.admin, { revision, groups }, "PUT"));
        const foreign = await save(0, [{ ...group, entries: [{ type: "table", id: fixture.foreignTablePublicId }] }]);
        expect(foreign.status, await foreign.text()).toBe(400);
        expect((await save(0, [{ ...group, entries: [{ type: "table", id: "Unknown record" }] }])).status).toBe(400);
        expect((await save(0, [group])).status).toBe(200);
        const raced = await Promise.all([save(1, [group]), save(1, [])]);
        expect(raced.map((res) => res.status).sort()).toEqual([200, 409]);
        expect((await save(2, [group])).status).toBe(200);
        await sql`UPDATE grids.tables SET deleted_at = now() WHERE id = ${fixture.tableId}::uuid`;
        expect((await save(3, [group])).status).toBe(200);
        expect((await save(4, [])).status).toBe(200);
        expect(await count("tables", "id", fixture.tableId)).toBe(1);
        expect(await (await app.request(path, bearer(fixture.tokens.admin))).json()).toEqual({ revision: 5, groups: [] });
        expect((await app.request(`/bases/${fixture.foreignBasePublicId}/navigation`, bearer(fixture.tokens.admin))).status).not.toBe(200);
      } finally {
        await cleanupFixture(fixture);
      }
    },
    20_000,
  );
  postgresTest(
    "enforces auth, credential caps, resource binding, validation, and result mappings",
    async () => {
      const fixture = newFixture();
      let primaryError: unknown;
      let primaryFailed = false;
      try {
        await setupFixture(fixture);

        expect((await app.request(`/tables/by-base/${fixture.basePublicId}`)).status).toBe(401);

        const readable = await app.request(`/tables/by-base/${fixture.basePublicId}`, bearer(fixture.tokens.read));
        expect(readable.status).toBe(200);
        expect((await readable.json()).map((table: { id: string }) => table.id)).toContain(fixture.tablePublicId);

        for (let index = 0; index < 101; index += 1) {
          await sql`
            INSERT INTO grids.tables (id, short_id, base_id, name, position)
            VALUES (${testUuid()}::uuid, ${testShortId("Q")}, ${fixture.baseId}::uuid, ${`Bounded search ${index}`}, ${index + 10})
          `;
        }
        const boundedSearch = await app.request(`/tables/by-base/${fixture.basePublicId}?q=Bounded%20search`, bearer(fixture.tokens.read));
        expect(boundedSearch.status).toBe(200);
        expect(await boundedSearch.json()).toHaveLength(100);

        const foreign = await app.request(`/tables/by-base/${fixture.foreignBasePublicId}`, bearer(fixture.tokens.admin));
        expect(foreign.status).toBe(403);

        expect((await app.request(`/bases/${fixture.basePublicId}`, bearer(fixture.tokens.delegated))).status).toBe(200);
        expect((await app.request(`/bases/${fixture.foreignBasePublicId}`, bearer(fixture.tokens.delegated))).status).toBe(403);
        expect((await app.request(`/tables/${fixture.foreignTablePublicId}`, bearer(fixture.tokens.delegated))).status).toBe(403);
        expect((await app.request(`/views/${fixture.foreignViewPublicId}`, bearer(fixture.tokens.delegated))).status).toBe(404);

        const formId = testUuid();
        const formPublicId = testShortId("M");
        await sql`
          INSERT INTO grids.forms (id, short_id, table_id, name, config, is_active)
          VALUES (${formId}::uuid, ${formPublicId}, ${fixture.tableId}::uuid, 'Public intake', '{"fields":[]}'::jsonb, TRUE)
        `;
        const policyInput = { policy: { mode: "selected", sources: ["direct"] } };
        expect(
          (await app.request(`/tables/${fixture.tablePublicId}/mutation-policy/impact`, jsonRequest(fixture.tokens.read, policyInput)))
            .status,
        ).toBe(403);
        const impact = await app.request(
          `/tables/${fixture.tablePublicId}/mutation-policy/impact`,
          jsonRequest(fixture.tokens.admin, policyInput),
        );
        expect(impact.status).toBe(200);
        expect(await impact.json()).toEqual({
          items: [{ kind: "form", id: formPublicId, name: "Public intake" }],
          total: 1,
          limit: 50,
          truncated: false,
          complete: true,
        });
        const storedPolicyInput = { policy: { mode: "selected", sources: ["form"] } };
        expect(
          (
            await app.request(
              `/tables/${fixture.tablePublicId}/mutation-policy`,
              jsonRequest(fixture.tokens.read, storedPolicyInput, "PUT"),
            )
          ).status,
        ).toBe(403);
        const updatedPolicy = await app.request(
          `/tables/${fixture.tablePublicId}/mutation-policy`,
          jsonRequest(fixture.tokens.admin, storedPolicyInput, "PUT"),
        );
        expect(updatedPolicy.status).toBe(200);
        expect(await updatedPolicy.json()).toEqual(storedPolicyInput);
        const unconfirmedFreeze = await app.request(
          `/tables/${fixture.tablePublicId}/mutation-policy`,
          jsonRequest(fixture.tokens.admin, { policy: { mode: "selected", sources: [] } }, "PUT"),
        );
        expect(unconfirmedFreeze.status).toBe(400);
        const [policyAudit] = await sql<Array<{ action: string; diff: unknown }>>`
          SELECT action, diff FROM grids.audit_log
          WHERE table_id = ${fixture.tableId}::uuid AND action = 'mutation_policy.updated'
          ORDER BY created_at DESC LIMIT 1
        `;
        expect(policyAudit).toMatchObject({ action: "mutation_policy.updated" });
        expect(JSON.stringify(policyAudit?.diff)).not.toContain(formId);

        const beforeForgedCreate = {
          records: await count("records", "table_id", fixture.tableId),
          sideEffects: await sideEffectCounts(fixture.baseId),
        };
        const forgedCreate = await app.request(`/records/by-table/${fixture.tablePublicId}?origin=form`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${fixture.tokens.admin}`,
            "content-type": "application/json",
            "x-grids-mutation-origin": "form",
          },
          body: JSON.stringify({ [fixture.uniqueFieldPublicId]: "forged-source" }),
        });
        expect(forgedCreate.status).toBe(403);
        expect(await count("records", "table_id", fixture.tableId)).toBe(beforeForgedCreate.records);
        expect(await sideEffectCounts(fixture.baseId)).toEqual(beforeForgedCreate.sideEffects);

        const resetPolicy = await app.request(
          `/tables/${fixture.tablePublicId}/mutation-policy`,
          jsonRequest(fixture.tokens.admin, { policy: { mode: "all" } }, "PUT"),
        );
        expect(resetPolicy.status).toBe(200);

        const unknown = await app.request(`/fields/by-table/${testUuid()}`, bearer(fixture.tokens.admin));
        expect(unknown.status).toBe(404);
        expect(await unknown.json()).toEqual({ message: "Table not found" });

        const invalidId = await app.request("/fields/by-table/not-a-uuid", bearer(fixture.tokens.admin));
        expect(invalidId.status).toBe(404);
        expect(await invalidId.json()).toEqual({ message: "Table not found" });

        for (const [path, options, message] of [
          ["/bases/not-a-uuid", bearer(fixture.tokens.admin), "Base not found"],
          ["/tables/by-base/not-a-uuid", bearer(fixture.tokens.admin), "Base not found"],
          ["/records/by-table/not-a-uuid", jsonRequest(fixture.tokens.admin, {}), "Table not found"],
          [`/records/${fixture.tablePublicId}/not-a-uuid`, bearer(fixture.tokens.admin), "Record not found"],
          ["/views/not-a-uuid", bearer(fixture.tokens.admin), "View not found"],
          ["/tables/not-a-uuid/query", jsonRequest(fixture.tokens.admin, { query: {} }), "Table not found"],
        ] as const) {
          const response = await app.request(path, options);
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({ message });
        }

        const tableCount = await count("tables", "base_id", fixture.baseId);
        const initialSideEffects = await sideEffectCounts(fixture.baseId);
        const deniedTableCreate = await app.request(
          `/tables/by-base/${fixture.basePublicId}`,
          jsonRequest(fixture.tokens.write, { name: "Denied table" }),
        );
        expect(deniedTableCreate.status).toBe(403);
        expect(await count("tables", "base_id", fixture.baseId)).toBe(tableCount);
        expect(await sideEffectCounts(fixture.baseId)).toEqual(initialSideEffects);

        const invalidTableCreate = await app.request(
          `/tables/by-base/${fixture.basePublicId}`,
          jsonRequest(fixture.tokens.admin, { name: "" }),
        );
        expect(invalidTableCreate.status).toBe(400);
        expect(await count("tables", "base_id", fixture.baseId)).toBe(tableCount);
        expect(await sideEffectCounts(fixture.baseId)).toEqual(initialSideEffects);

        const fieldCount = await count("fields", "table_id", fixture.tableId);
        const deniedFieldCreate = await app.request(
          `/fields/by-table/${fixture.tablePublicId}`,
          jsonRequest(fixture.tokens.write, { name: "Denied field", type: "text" }),
        );
        expect(deniedFieldCreate.status).toBe(403);
        expect(await count("fields", "table_id", fixture.tableId)).toBe(fieldCount);
        expect(await sideEffectCounts(fixture.baseId)).toEqual(initialSideEffects);

        const invalidFieldCreate = await app.request(
          `/fields/by-table/${fixture.tablePublicId}`,
          jsonRequest(fixture.tokens.admin, { name: "", type: "text" }),
        );
        expect(invalidFieldCreate.status).toBe(400);
        expect(await count("fields", "table_id", fixture.tableId)).toBe(fieldCount);
        expect(await sideEffectCounts(fixture.baseId)).toEqual(initialSideEffects);

        const createdField = await app.request(
          `/fields/by-table/${fixture.tablePublicId}`,
          jsonRequest(fixture.tokens.admin, { name: "Notes", type: "text" }),
        );
        expect(createdField.status).toBe(201);
        const createdFieldBody = (await createdField.json()) as { id: string };
        expect(await count("fields", "table_id", fixture.tableId)).toBe(fieldCount + 1);

        const tableUpdate = await app.request(
          `/tables/${fixture.tablePublicId}`,
          jsonRequest(
            fixture.tokens.admin,
            {
              columns: [{ fieldId: createdFieldBody.id, label: "Public notes" }],
              displayConfig: { mode: "cards", cards: { imageFieldId: createdFieldBody.id, fieldIds: [createdFieldBody.id] } },
              auditPolicy: {
                update: { enabled: false, questions: [], scope: "selected", fieldIds: [createdFieldBody.id] },
              },
            },
            "PATCH",
          ),
        );
        expect(tableUpdate.status).toBe(200);
        expect(await tableUpdate.json()).toMatchObject({
          id: fixture.tablePublicId,
          columns: [{ fieldId: createdFieldBody.id }],
          displayConfig: { cards: { imageFieldId: createdFieldBody.id, fieldIds: [createdFieldBody.id] } },
          auditPolicy: { update: { fieldIds: [createdFieldBody.id] } },
        });
        expect(
          (
            await app.request(
              `/tables/${fixture.tablePublicId}`,
              jsonRequest(fixture.tokens.admin, { columns: [{ fieldId: "MISS01" }] }, "PATCH"),
            )
          ).status,
        ).toBe(400);

        const createdView = await app.request(
          `/views/by-table/${fixture.tablePublicId}`,
          jsonRequest(fixture.tokens.admin, {
            name: "Public presentation",
            shared: true,
            ui: {
              columns: [{ fieldId: createdFieldBody.id }],
              groupedColumnOrder: [`group:0:${createdFieldBody.id}:year`],
              hiddenGroupedColumns: [`agg:0:${createdFieldBody.id}:count`],
            },
          }),
        );
        const createdViewText = await createdView.text();
        expect(createdView.status, createdViewText).toBe(201);
        const createdViewBody = JSON.parse(createdViewText) as { id: string; ui: Record<string, unknown> };
        expect(createdViewBody.ui).toMatchObject({
          columns: [{ fieldId: createdFieldBody.id }],
          groupedColumnOrder: [`group:0:${createdFieldBody.id}:year`],
          hiddenGroupedColumns: [`agg:0:${createdFieldBody.id}:count`],
        });
        const viewRoundTrip = await app.request(
          `/views/${createdViewBody.id}`,
          jsonRequest(fixture.tokens.admin, { name: "Renamed presentation", ui: createdViewBody.ui }, "PATCH"),
        );
        expect(viewRoundTrip.status).toBe(200);
        expect(await viewRoundTrip.json()).toMatchObject({ name: "Renamed presentation", ui: createdViewBody.ui });

        const beforeDeniedRecord = await sideEffectCounts(fixture.baseId);
        const deniedRecordCreate = await app.request(
          `/records/by-table/${fixture.tablePublicId}`,
          jsonRequest(fixture.tokens.read, { [fixture.uniqueFieldPublicId]: "SERIAL-1" }),
        );
        expect(deniedRecordCreate.status).toBe(403);
        expect(await count("records", "table_id", fixture.tableId)).toBe(0);
        expect(await sideEffectCounts(fixture.baseId)).toEqual(beforeDeniedRecord);

        const beforeCreatedRecord = await sideEffectCounts(fixture.baseId);
        const createdRecord = await app.request(
          `/records/by-table/${fixture.tablePublicId}`,
          jsonRequest(fixture.tokens.write, { [fixture.uniqueFieldPublicId]: "SERIAL-1" }),
        );
        expect(createdRecord.status).toBe(201);
        const createdRecordBody = (await createdRecord.json()) as { id: string; version: number };
        expect(createdRecordBody).toMatchObject({ version: 1 });
        expect(await count("records", "table_id", fixture.tableId)).toBe(1);
        expect(await sideEffectCounts(fixture.baseId)).toEqual({
          audit: beforeCreatedRecord.audit + 1,
          outbox: beforeCreatedRecord.outbox + 1,
        });

        const [recordBeforeConflict] = await sql<Array<{ data: Record<string, unknown>; version: number }>>`
          SELECT data, version
          FROM grids.records
          WHERE table_id = ${fixture.tableId}::uuid
        `;
        const beforeConflict = await sideEffectCounts(fixture.baseId);
        const duplicateRecord = await app.request(
          `/records/by-table/${fixture.tablePublicId}`,
          jsonRequest(fixture.tokens.write, { [fixture.uniqueFieldPublicId]: "SERIAL-1" }),
        );
        expect(duplicateRecord.status).toBe(409);
        expect(await count("records", "table_id", fixture.tableId)).toBe(1);
        const [recordAfterConflict] = await sql<Array<{ data: Record<string, unknown>; version: number }>>`
          SELECT data, version
          FROM grids.records
          WHERE table_id = ${fixture.tableId}::uuid
        `;
        expect(recordAfterConflict).toEqual(recordBeforeConflict);
        expect(await sideEffectCounts(fixture.baseId)).toEqual(beforeConflict);

        const recordPath = `/records/${fixture.tablePublicId}/${createdRecordBody.id}`;
        const patchRecord = (values: Record<string, unknown>, ifMatch?: string) =>
          app.request(recordPath, {
            method: "PATCH",
            headers: {
              authorization: `Bearer ${fixture.tokens.write}`,
              "content-type": "application/json",
              ...(ifMatch === undefined ? {} : { "If-Match": ifMatch }),
            },
            body: JSON.stringify({ values }),
          });
        const beforeMalformedPatch = await sideEffectCounts(fixture.baseId);
        for (const invalidVersion of ["", "0", "1.5", "1e2", "current", "9007199254740992"]) {
          const invalidPatch = await patchRecord({ [fixture.uniqueFieldPublicId]: "SERIAL-2" }, invalidVersion);
          expect(invalidPatch.status).toBe(400);
          expect(await invalidPatch.json()).toEqual({ message: "If-Match must contain a positive integer Record version" });
        }
        expect(await sideEffectCounts(fixture.baseId)).toEqual(beforeMalformedPatch);

        const missingGuardNoop = await patchRecord({ [fixture.uniqueFieldPublicId]: "SERIAL-1" });
        expect(missingGuardNoop.status).toBe(200);
        expect(await missingGuardNoop.json()).toMatchObject({ version: 1 });
        expect(await sideEffectCounts(fixture.baseId)).toEqual(beforeMalformedPatch);

        const updatedRecord = await patchRecord({ [fixture.uniqueFieldPublicId]: "SERIAL-2" }, "1");
        expect(updatedRecord.status).toBe(200);
        expect(await updatedRecord.json()).toMatchObject({ version: 2, data: { [fixture.uniqueFieldPublicId]: "SERIAL-2" } });
        const afterUpdate = await sideEffectCounts(fixture.baseId);
        expect(afterUpdate).toEqual({ audit: beforeMalformedPatch.audit + 1, outbox: beforeMalformedPatch.outbox + 1 });

        const stalePatch = await patchRecord({ [fixture.uniqueFieldPublicId]: "SERIAL-3" }, "1");
        expect(stalePatch.status).toBe(409);
        expect(await sideEffectCounts(fixture.baseId)).toEqual(afterUpdate);

        const guardedNoop = await patchRecord({ [fixture.uniqueFieldPublicId]: "SERIAL-2" }, "2");
        expect(guardedNoop.status).toBe(200);
        expect(await guardedNoop.json()).toMatchObject({ version: 2 });
        expect(await sideEffectCounts(fixture.baseId)).toEqual(afterUpdate);

        const views = await app.request(`/views/by-table/${fixture.tablePublicId}`, bearer(fixture.tokens.read));
        expect(views.status).toBe(200);

        const viewCount = await count("views", "table_id", fixture.tableId);
        const beforeInvalidView = await sideEffectCounts(fixture.baseId);
        const invalidView = await app.request(
          `/views/by-table/${fixture.tablePublicId}`,
          jsonRequest(fixture.tokens.admin, { name: "Broken view", shared: true, source: "from table Missing" }),
        );
        expect(invalidView.status).toBe(400);
        expect(await count("views", "table_id", fixture.tableId)).toBe(viewCount);
        expect(await sideEffectCounts(fixture.baseId)).toEqual(beforeInvalidView);
      } catch (error) {
        primaryError = error;
        primaryFailed = true;
        throw error;
      } finally {
        try {
          await cleanupFixture(fixture);
        } catch (cleanupError) {
          if (primaryFailed) {
            throw new AggregateError([primaryError, cleanupError], "Route matrix failed and fixture cleanup also failed");
          }
          throw cleanupError;
        }
      }
    },
    20_000,
  );

  postgresTest(
    "pages a permission-aware public-ID Record change feed",
    async () => {
      const fixture = newFixture();
      let primaryError: unknown;
      let primaryFailed = false;
      try {
        await setupFixture(fixture);
        const feedPath = `/records/by-base/${fixture.basePublicId}/changes`;
        expect((await app.request(feedPath)).status).toBe(401);
        expect((await app.request(`/records/by-base/${fixture.foreignBasePublicId}/changes`, bearer(fixture.tokens.read))).status).toBe(
          403,
        );
        expect(
          (await app.request(`${feedPath}?tableId=${encodeURIComponent(fixture.foreignTablePublicId)}`, bearer(fixture.tokens.read)))
            .status,
        ).toBe(404);
        expect((await app.request(`${feedPath}?cursor=invalid`, bearer(fixture.tokens.read))).status).toBe(400);

        const expiredCursor = encodeRecordChangeFeedCursor(
          { baseId: fixture.baseId, tableId: null },
          { occurredAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString(), eventId: testUuid() },
          process.env.APP_SECRET!,
        );
        expect((await app.request(`${feedPath}?cursor=${encodeURIComponent(expiredCursor)}`, bearer(fixture.tokens.read))).status).toBe(
          409,
        );

        const created = await app.request(
          `/records/by-table/${fixture.tablePublicId}`,
          jsonRequest(fixture.tokens.write, { [fixture.uniqueFieldPublicId]: "FEED-1" }),
        );
        expect(created.status).toBe(201);
        const createdRecord = (await created.json()) as { id: string; version: number };
        const updated = await app.request(`/records/${fixture.tablePublicId}/${createdRecord.id}`, {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${fixture.tokens.write}`,
            "content-type": "application/json",
            "if-match": "1",
          },
          body: JSON.stringify({ values: { [fixture.uniqueFieldPublicId]: "FEED-2" } }),
        });
        expect(updated.status).toBe(200);
        const trashed = await app.request(
          `/records/${fixture.tablePublicId}/${createdRecord.id}/trash`,
          jsonRequest(fixture.tokens.write, {}),
        );
        expect(trashed.status).toBe(204);

        const otherTableId = testUuid();
        const otherTablePublicId = testShortId("C");
        const otherRecordId = testUuid();
        const otherRecordPublicId = testShortId("R");
        await sql`
          INSERT INTO grids.tables (id, short_id, base_id, name)
          VALUES (${otherTableId}::uuid, ${otherTablePublicId}, ${fixture.baseId}::uuid, 'Other changes')
        `;
        await sql`
          INSERT INTO grids.records (id, short_id, table_id)
          VALUES (${otherRecordId}::uuid, ${otherRecordPublicId}, ${otherTableId}::uuid)
        `;
        const [otherEvent] = await sql<Array<{ id: string }>>`
          SELECT grids.enqueue_record_event(
            ${otherTableId}::uuid,
            ${otherRecordId}::uuid,
            ${JSON.stringify({
              v: 1,
              type: "record.created",
              version: 1,
              changedFieldIds: [],
              actorId: null,
            })}::jsonb
          )::text AS id
        `;
        await sql`
          INSERT INTO grids.record_event_snapshots (
            id, base_id, table_id, record_id, event_type, record_version, data, deleted_at
          ) VALUES (
            ${otherEvent!.id}::uuid, ${fixture.baseId}::uuid, ${otherTableId}::uuid, ${otherRecordId}::uuid,
            'record.created', 1, '{}'::jsonb, NULL
          )
        `;

        const events = await sql<Array<{ id: string }>>`
          SELECT id::text FROM grids.record_event_outbox WHERE base_id = ${fixture.baseId}::uuid ORDER BY created_at, id
        `;
        for (const [index, event] of events.entries()) {
          await sql`
            UPDATE grids.record_event_outbox
            SET created_at = ${new Date(Date.now() - (events.length - index) * 1_000).toISOString()}::timestamptz
            WHERE id = ${event.id}::uuid
          `;
        }

        const first = await app.request(`${feedPath}?limit=1`, bearer(fixture.tokens.read));
        expect(first.status).toBe(200);
        const firstPage = (await first.json()) as {
          items: Array<{ baseId: string; tableId: string; recordId: string; type: string; version: number }>;
          cursor: string;
          hasMore: boolean;
          retentionDays: number;
        };
        expect(firstPage).toMatchObject({
          items: [
            {
              baseId: fixture.basePublicId,
              tableId: fixture.tablePublicId,
              recordId: createdRecord.id,
              type: "record.created",
              version: 1,
            },
          ],
          hasMore: true,
          retentionDays: 30,
        });
        const second = await app.request(
          `${feedPath}?limit=100&cursor=${encodeURIComponent(firstPage.cursor)}`,
          bearer(fixture.tokens.read),
        );
        expect(second.status).toBe(200);
        const secondPage = (await second.json()) as typeof firstPage;
        expect(secondPage.items.map((item) => item.type)).toEqual(["record.updated", "record.deleted", "record.created"]);
        expect(new Set([...firstPage.items, ...secondPage.items].map((item) => `${item.tableId}:${item.recordId}:${item.type}`)).size).toBe(
          4,
        );
        const serialized = JSON.stringify([firstPage, secondPage]);
        for (const internalId of [fixture.baseId, fixture.tableId, otherTableId, otherRecordId])
          expect(serialized).not.toContain(internalId);

        const tablePage = await app.request(`${feedPath}?tableId=${fixture.tablePublicId}&limit=100`, bearer(fixture.tokens.read));
        expect(tablePage.status).toBe(200);
        expect(((await tablePage.json()) as typeof firstPage).items.map((item) => item.type)).toEqual([
          "record.created",
          "record.updated",
          "record.deleted",
        ]);

        const empty = await app.request(`${feedPath}?cursor=${encodeURIComponent(secondPage.cursor)}`, bearer(fixture.tokens.read));
        expect(await empty.json()).toMatchObject({ items: [], cursor: secondPage.cursor, hasMore: false });

        await sql`
          DELETE FROM grids.base_access
          WHERE base_id = ${fixture.baseId}::uuid AND access_id = ${fixture.accessIds[0]}::uuid
        `;
        expect((await app.request(`${feedPath}?cursor=${encodeURIComponent(secondPage.cursor)}`, bearer(fixture.tokens.read))).status).toBe(
          403,
        );
      } catch (error) {
        primaryError = error;
        primaryFailed = true;
        throw error;
      } finally {
        try {
          await cleanupFixture(fixture);
        } catch (cleanupError) {
          if (primaryFailed) throw new AggregateError([primaryError, cleanupError], "Record change feed test and cleanup failed");
          throw cleanupError;
        }
      }
    },
    20_000,
  );

  postgresTest(
    "atomically binds external identities and replays conditional Record upserts",
    async () => {
      const fixture = newFixture();
      let primaryError: unknown;
      let primaryFailed = false;
      try {
        await setupFixture(fixture);
        const path = `/records/by-table/${fixture.tablePublicId}/external`;
        const externalRef = {
          provider: "crm",
          providerAccount: "main",
          resourceKind: "contact",
          externalId: "003ABC",
        };
        const request = (
          token: string,
          operationKey: string | undefined,
          values: Record<string, unknown>,
          ifVersion?: number,
          ref = externalRef,
        ) =>
          app.request(path, {
            method: "PUT",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              ...(operationKey === undefined ? {} : { "Idempotency-Key": operationKey }),
            },
            body: JSON.stringify({ externalRef: ref, values, ...(ifVersion === undefined ? {} : { ifVersion }) }),
          });

        const beforeDenied = await sideEffectCounts(fixture.baseId);
        expect((await request(fixture.tokens.read, "denied", { [fixture.uniqueFieldPublicId]: "EXT-1" })).status).toBe(403);
        expect((await request(fixture.tokens.write, undefined, { [fixture.uniqueFieldPublicId]: "EXT-1" })).status).toBe(400);
        expect(await count("records", "table_id", fixture.tableId)).toBe(0);
        expect(await sideEffectCounts(fixture.baseId)).toEqual(beforeDenied);
        for (const part of ["provider", "providerAccount", "resourceKind", "externalId"] as const) {
          const invalidRef = { ...externalRef, [part]: `${externalRef[part]}\0x` };
          expect(
            (await request(fixture.tokens.write, `nul-${part}`, { [fixture.uniqueFieldPublicId]: "EXT-NUL" }, undefined, invalidRef))
              .status,
          ).toBe(400);
        }
        expect(await count("records", "table_id", fixture.tableId)).toBe(0);
        expect(await sideEffectCounts(fixture.baseId)).toEqual(beforeDenied);

        const [first, retry] = await Promise.all([
          request(fixture.tokens.write, "create-003ABC", { [fixture.uniqueFieldPublicId]: "EXT-1" }),
          request(fixture.tokens.write, "create-003ABC", { [fixture.uniqueFieldPublicId]: "EXT-1" }),
        ]);
        expect([first.status, retry.status].sort()).toEqual([200, 201]);
        const firstBody = (await first.json()) as {
          recordId: string;
          tableId: string;
          version: number;
          created: boolean;
          changed: boolean;
          replayed: boolean;
        };
        const retryBody = (await retry.json()) as typeof firstBody;
        expect(firstBody.recordId).toBe(retryBody.recordId);
        expect(firstBody.recordId).toMatch(/^[A-Za-z0-9]{6}$/);
        expect(firstBody.tableId).toBe(fixture.tablePublicId);
        expect([firstBody.replayed, retryBody.replayed].sort()).toEqual([false, true]);
        expect(firstBody).toMatchObject({ created: true, changed: true, version: 1 });
        expect(retryBody).toMatchObject({ created: true, changed: true, version: 1 });
        expect(await count("records", "table_id", fixture.tableId)).toBe(1);
        const [identityCounts] = await sql<Array<{ bindings: number; operations: number; internal_record_id: string }>>`
          SELECT
            (SELECT count(*)::int FROM grids.record_external_bindings WHERE table_id = ${fixture.tableId}::uuid) AS bindings,
            (
              SELECT count(*)::int
              FROM grids.record_external_operations operation
              JOIN grids.record_external_bindings binding ON binding.id = operation.binding_id
              WHERE binding.table_id = ${fixture.tableId}::uuid
            ) AS operations,
            (SELECT record_id::text FROM grids.record_external_bindings WHERE table_id = ${fixture.tableId}::uuid) AS internal_record_id
        `;
        expect(identityCounts).toMatchObject({ bindings: 1, operations: 1 });
        expect(identityCounts?.internal_record_id).not.toBe(firstBody.recordId);
        const afterCreate = await sideEffectCounts(fixture.baseId);
        expect(afterCreate).toEqual({ audit: beforeDenied.audit + 1, outbox: beforeDenied.outbox + 1 });

        const mismatchedReplay = await request(fixture.tokens.write, "create-003ABC", {
          [fixture.uniqueFieldPublicId]: "EXT-CHANGED",
        });
        expect(mismatchedReplay.status).toBe(409);
        const missingVersion = await request(fixture.tokens.write, "update-003ABC-missing-version", {
          [fixture.uniqueFieldPublicId]: "EXT-2",
        });
        expect(missingVersion.status).toBe(409);
        expect(await sideEffectCounts(fixture.baseId)).toEqual(afterCreate);

        const updated = await request(fixture.tokens.write, "update-003ABC-v2", { [fixture.uniqueFieldPublicId]: "EXT-2" }, 1);
        expect(updated.status).toBe(200);
        expect(await updated.json()).toMatchObject({
          created: false,
          changed: true,
          replayed: false,
          recordId: firstBody.recordId,
          version: 2,
        });
        const afterUpdate = await sideEffectCounts(fixture.baseId);
        expect(afterUpdate).toEqual({ audit: afterCreate.audit + 1, outbox: afterCreate.outbox + 1 });

        const replayedUpdate = await request(fixture.tokens.write, "update-003ABC-v2", { [fixture.uniqueFieldPublicId]: "EXT-2" }, 1);
        expect(replayedUpdate.status).toBe(200);
        expect(await replayedUpdate.json()).toMatchObject({ changed: true, replayed: true, version: 2 });
        const oldCreateReplay = await request(fixture.tokens.write, "create-003ABC", { [fixture.uniqueFieldPublicId]: "EXT-1" });
        expect(await oldCreateReplay.json()).toMatchObject({ created: true, changed: true, replayed: true, version: 1 });
        const noop = await request(fixture.tokens.write, "noop-003ABC-v2", { [fixture.uniqueFieldPublicId]: "EXT-2" }, 2);
        expect(noop.status).toBe(200);
        expect(await noop.json()).toMatchObject({ created: false, changed: false, replayed: false, version: 2 });
        const stale = await request(fixture.tokens.write, "stale-003ABC-v1", { [fixture.uniqueFieldPublicId]: "EXT-3" }, 1);
        expect(stale.status).toBe(409);
        expect(await sideEffectCounts(fixture.baseId)).toEqual(afterUpdate);

        const otherAccount = await request(
          fixture.tokens.write,
          "create-003ABC-other-account",
          { [fixture.uniqueFieldPublicId]: "EXT-OTHER" },
          undefined,
          { ...externalRef, providerAccount: "secondary" },
        );
        expect(otherAccount.status).toBe(201);
        expect((await otherAccount.json()) as { recordId: string }).not.toMatchObject({ recordId: firstBody.recordId });
        expect(await count("records", "table_id", fixture.tableId)).toBe(2);

        await sql`UPDATE grids.fields SET deleted_at = now() WHERE id = ${fixture.uniqueFieldId}::uuid`;
        const replayAfterSchemaChange = await request(fixture.tokens.write, "create-003ABC", {
          [fixture.uniqueFieldPublicId]: "EXT-1",
        });
        expect(replayAfterSchemaChange.status).toBe(200);
        expect(await replayAfterSchemaChange.json()).toMatchObject({ recordId: firstBody.recordId, version: 1, replayed: true });

        const [expiredReceipt] = await sql<Array<{ id: string; bindingId: string }>>`
          SELECT operation.id::text AS id, operation.binding_id::text AS "bindingId"
          FROM grids.record_external_operations operation
          JOIN grids.record_external_bindings binding ON binding.id = operation.binding_id
          WHERE binding.record_id = ${identityCounts!.internal_record_id}::uuid AND operation.created = TRUE
        `;
        expect(expiredReceipt).toBeDefined();
        await sql`
          UPDATE grids.record_external_operations
          SET created_at = now() - interval '31 days'
          WHERE id = ${expiredReceipt!.id}::uuid
        `;
        await deleteExpiredExternalRecordOperations();
        const [retentionState] = await sql<Array<{ expired: number; fresh: number }>>`
          SELECT
            count(*) FILTER (WHERE id = ${expiredReceipt!.id}::uuid)::int AS expired,
            count(*) FILTER (WHERE binding_id = ${expiredReceipt!.bindingId}::uuid AND id <> ${expiredReceipt!.id}::uuid)::int AS fresh
          FROM grids.record_external_operations
        `;
        expect(retentionState).toEqual({ expired: 0, fresh: 2 });
        const [bindingsAfterRetention] = await sql<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM grids.record_external_bindings WHERE table_id = ${fixture.tableId}::uuid
        `;
        expect(bindingsAfterRetention?.count).toBe(2);
        expect(await count("records", "table_id", fixture.tableId)).toBe(2);
      } catch (error) {
        primaryError = error;
        primaryFailed = true;
        throw error;
      } finally {
        try {
          await cleanupFixture(fixture);
        } catch (cleanupError) {
          if (primaryFailed) throw new AggregateError([primaryError, cleanupError], "External Record route test and cleanup failed");
          throw cleanupError;
        }
      }
    },
    20_000,
  );

  postgresTest(
    "processes bounded external Record batches independently and in order",
    async () => {
      const fixture = newFixture();
      let primaryError: unknown;
      let primaryFailed = false;
      try {
        await setupFixture(fixture);
        const relationFieldId = testUuid();
        const relationFieldPublicId = testShortId("L");
        const targetRecordId = testUuid();
        const targetRecordPublicId = testShortId("R");
        await sql`
          INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
          VALUES (
            ${relationFieldId}::uuid,
            ${relationFieldPublicId},
            ${fixture.tableId}::uuid,
            'Related',
            'relation',
            ${{ targetTableId: fixture.tableId }}::jsonb,
            1
          )
        `;
        await sql`
          INSERT INTO grids.records (id, short_id, table_id, data)
          VALUES (
            ${targetRecordId}::uuid,
            ${targetRecordPublicId},
            ${fixture.tableId}::uuid,
            ${{ [fixture.uniqueFieldId]: "TARGET" }}::jsonb
          )
        `;
        const path = `/records/by-table/${fixture.tablePublicId}/external/batch`;
        const item = (
          externalId: string,
          idempotencyKey: string,
          value: string,
          ifVersion?: number,
          values: Record<string, unknown> = { [fixture.uniqueFieldPublicId]: value },
        ) => ({
          idempotencyKey,
          externalRef: { provider: "crm", providerAccount: "batch", resourceKind: "contact", externalId },
          values,
          ...(ifVersion === undefined ? {} : { ifVersion }),
        });
        const request = (token: string, items: unknown[], signal?: AbortSignal) =>
          app.request(path, { ...jsonRequest(token, { items }), ...(signal ? { signal } : {}) });

        const before = await sideEffectCounts(fixture.baseId);
        expect((await request(fixture.tokens.read, [item("denied", "denied-v1", "DENIED")])).status).toBe(403);
        expect(
          (
            await request(
              fixture.tokens.write,
              Array.from({ length: 101 }, (_, index) => item(`${index}`, `limit-${index}`, `${index}`)),
            )
          ).status,
        ).toBe(400);
        expect((await request(fixture.tokens.write, [item("nul", "nul\0key", "NUL")])).status).toBe(400);
        const aborted = new AbortController();
        aborted.abort();
        const stopped = await request(fixture.tokens.write, [item("stopped", "stopped-v1", "STOPPED")], aborted.signal);
        expect(stopped.status).toBe(200);
        expect(await stopped.json()).toEqual({ items: [], complete: false });
        expect(await count("records", "table_id", fixture.tableId)).toBe(1);
        expect(await sideEffectCounts(fixture.baseId)).toEqual(before);

        const first = item("A", "a-v1", "A-1", undefined, {
          [fixture.uniqueFieldPublicId]: "A-1",
          [relationFieldPublicId]: [targetRecordPublicId],
        });
        const batchItems = [
          first,
          item("B", "b-v1", "B-1"),
          item("invalid-field", "invalid-field-v1", "unused", undefined, { [testShortId("Z")]: "unknown" }),
          item("unique-conflict", "unique-conflict-v1", "B-1"),
          first,
          item("A", "a-v2", "A-2", 1),
          item("A", "a-noop-v2", "A-2", 2),
          item("A", "a-stale-v1", "A-3", 1),
        ];
        const response = await request(fixture.tokens.write, batchItems);
        expect(response.status).toBe(200);
        const payload = (await response.json()) as {
          complete: boolean;
          items: Array<
            | {
                index: number;
                ok: true;
                recordId: string;
                tableId: string;
                version: number;
                created: boolean;
                changed: boolean;
                replayed: boolean;
              }
            | { index: number; ok: false; error: { code: string; message: string; status: number } }
          >;
        };
        expect(payload.complete).toBe(true);
        expect(payload.items.map((outcome) => [outcome.index, outcome.ok])).toEqual([
          [0, true],
          [1, true],
          [2, false],
          [3, false],
          [4, true],
          [5, true],
          [6, true],
          [7, false],
        ]);
        expect(payload.items[0]).toMatchObject({
          ok: true,
          tableId: fixture.tablePublicId,
          version: 1,
          created: true,
          changed: true,
          replayed: false,
        });
        expect(payload.items[2]).toMatchObject({ ok: false, error: { code: "BAD_INPUT", status: 400 } });
        expect(payload.items[3]).toMatchObject({ ok: false, error: { code: "CONFLICT", status: 409 } });
        expect(payload.items[4]).toMatchObject({ ok: true, version: 1, created: true, changed: true, replayed: true });
        expect(payload.items[5]).toMatchObject({ ok: true, version: 2, created: false, changed: true, replayed: false });
        expect(payload.items[6]).toMatchObject({ ok: true, version: 2, created: false, changed: false, replayed: false });
        expect(payload.items[7]).toMatchObject({ ok: false, error: { code: "CONFLICT", status: 409 } });
        expect(payload.items[0] && "recordId" in payload.items[0] ? payload.items[0].recordId : null).toBe(
          payload.items[4] && "recordId" in payload.items[4] ? payload.items[4].recordId : null,
        );
        const afterFirstBatch = await sideEffectCounts(fixture.baseId);
        const retried = await request(fixture.tokens.write, batchItems);
        expect(retried.status).toBe(200);
        const retriedPayload = (await retried.json()) as typeof payload;
        expect(retriedPayload.items.filter((outcome) => outcome.ok).map((outcome) => [outcome.index, outcome.replayed])).toEqual([
          [0, true],
          [1, true],
          [4, true],
          [5, true],
          [6, true],
        ]);
        expect(await sideEffectCounts(fixture.baseId)).toEqual(afterFirstBatch);
        const serialized = JSON.stringify(payload);
        for (const internalId of [fixture.baseId, fixture.tableId, fixture.uniqueFieldId, relationFieldId, targetRecordId]) {
          expect(serialized).not.toContain(internalId);
        }

        expect(await count("records", "table_id", fixture.tableId)).toBe(3);
        const [relationCount] = await sql<Array<{ count: number }>>`
          SELECT count(*)::int AS count
          FROM grids.record_links link
          JOIN grids.record_external_bindings binding ON binding.record_id = link.from_record_id
          WHERE binding.external_id = 'A'
            AND link.from_field_id = ${relationFieldId}::uuid
            AND link.to_record_id = ${targetRecordId}::uuid
        `;
        expect(relationCount?.count).toBe(1);
        const [identityCounts] = await sql<Array<{ bindings: number; operations: number }>>`
          SELECT
            count(DISTINCT binding.id)::int AS bindings,
            count(operation.id)::int AS operations
          FROM grids.record_external_bindings binding
          LEFT JOIN grids.record_external_operations operation ON operation.binding_id = binding.id
          WHERE binding.table_id = ${fixture.tableId}::uuid
        `;
        expect(identityCounts).toEqual({ bindings: 2, operations: 4 });
        expect(afterFirstBatch).toEqual({ audit: before.audit + 3, outbox: before.outbox + 3 });
      } catch (error) {
        primaryError = error;
        primaryFailed = true;
        throw error;
      } finally {
        try {
          await cleanupFixture(fixture);
        } catch (cleanupError) {
          if (primaryFailed) throw new AggregateError([primaryError, cleanupError], "External Record batch test and cleanup failed");
          throw cleanupError;
        }
      }
    },
    20_000,
  );
});
