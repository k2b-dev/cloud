import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { User } from "@valentinkolb/cloud/contracts";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { sql } from "bun";
import { Hono, type MiddlewareHandler } from "hono";
import type { DslQueryExecuteResponse } from "../contracts";
import { migrate } from "../migrate";
import { createGqlApi } from "./gql";
import { compileGqlViewWrite } from "./gql-runtime";
import apiRoutes from "./index";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;
if (process.env.GRIDS_DB_TEST === "1") setDefaultTimeout(60_000);

const uuid = () => Bun.randomUUIDv7();
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

type GqlApiFixture = {
  baseId: string;
  internalBaseId: string;
  accessId: string;
  tableId: string;
  viewId: string;
  amountId: string;
  stageId: string;
};

type GqlRelationApiFixture = {
  baseId: string;
  internalBaseId: string;
  accessId: string;
  ordersTableId: string;
  customersTableId: string;
  byCustomerViewId: string;
  amountId: string;
  customerLinkId: string;
  customerNameId: string;
};

type CompileViewResponse =
  | { ok: true; tableId: string; source: string }
  | { ok: false; diagnostics: Array<{ message: string; line?: number; column?: number }> };

type AutocompleteResponse = {
  ok: true;
  diagnostics: Array<{ message: string; line?: number; column?: number }>;
  items: Array<{ label: string; insertText: string; detail?: string }>;
};

const testUser = (overrides: { id?: string; uid?: string; roles?: User["roles"] } = {}): User => {
  const id = overrides.id ?? uuid();
  return {
    id,
    uid: overrides.uid ?? `gql-api-${id}`,
    roles: overrides.roles ?? ["admin"],
    provider: "local",
    profile: "user",
    givenname: "GQL",
    sn: "API",
    displayName: "GQL API",
    mail: `gql-api-${id}@example.test`,
    avatarHash: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
    ipa: null,
  };
};

const authenticateAs =
  (user: User): MiddlewareHandler<AuthContext> =>
  async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("accessSubject", { type: "user", userId: user.id });
    c.set("user", user);
    await next();
  };

const apiFor = (user: User) => new Hono<AuthContext>().route("/gql", createGqlApi({ requireAuthenticated: authenticateAs(user) }));

const viewWriteCompilerFor = (user: User) =>
  new Hono<AuthContext>().use(authenticateAs(user)).post("/:baseId/:tableId", async (c) =>
    c.json(
      await compileGqlViewWrite(c, {
        baseId: c.req.param("baseId"),
        tableId: c.req.param("tableId"),
        source: (await c.req.json<{ source: string }>()).source,
      }),
    ),
  );

const jsonRequest = (method: "POST" | "PATCH", body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const existingAuthUserId = async (): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`
    SELECT id::text AS id FROM auth.users ORDER BY id LIMIT 1
  `;
  if (!row) throw new Error("GQL API integration test needs one existing auth.users row for audit-log actor FK");
  return row.id;
};

const grantBaseRead = async (baseId: string, userId: string): Promise<string> => {
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (user_id, permission)
    VALUES (${userId}::uuid, 'read'::auth.permission_level)
    RETURNING id::text AS id
  `;
  if (!access) throw new Error("Failed to create test base access");
  await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${access.id}::uuid)`;
  return access.id;
};

const insertFixture = async (userId: string): Promise<GqlApiFixture> => {
  const baseId = uuid();
  const basePublicId = shortId("B");
  const tableId = uuid();
  const tablePublicId = shortId("T");
  const viewId = uuid();
  const viewPublicId = shortId("V");
  const amountId = uuid();
  const amountPublicId = shortId("F");
  const stageId = uuid();
  const stagePublicId = shortId("F");

  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${basePublicId}, 'GQL API integration')
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES (${tableId}::uuid, ${tablePublicId}, ${baseId}::uuid, 'Orders', 0)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
    VALUES
      (${amountId}::uuid, ${amountPublicId}, ${tableId}::uuid, 'Amount', 'number', '{}'::jsonb, 0),
      (
        ${stageId}::uuid,
        ${stagePublicId},
        ${tableId}::uuid,
        'Stage',
        'select',
        ${{
          options: [
            { id: "open", label: "Open" },
            { id: "closed", label: "Closed" },
            { id: "hold", label: "On hold" },
          ],
        }}::jsonb,
        1
      )
  `;
  await sql`
    INSERT INTO grids.views (id, short_id, table_id, name, source, ui, position)
    VALUES (${viewId}::uuid, ${viewPublicId}, ${tableId}::uuid, 'Visible orders', ${`from table {${tablePublicId}}`}, '{}'::jsonb, 0)
  `;
  const accessId = await grantBaseRead(baseId, userId);

  return {
    baseId: basePublicId,
    internalBaseId: baseId,
    accessId,
    tableId: tablePublicId,
    viewId: viewPublicId,
    amountId: amountPublicId,
    stageId: stagePublicId,
  };
};

const insertAutocompleteBaseFixture = async (
  userId: string,
): Promise<{
  baseId: string;
  internalBaseId: string;
  accessId: string;
  publicTableId: string;
  internalPublicTableId: string;
  secretTableId: string;
  secretLinkId: string;
}> => {
  const baseId = uuid();
  const basePublicId = shortId("B");
  const publicTableId = uuid();
  const publicTablePublicId = shortId("T");
  const secretTableId = uuid();
  const secretTablePublicId = shortId("T");
  const publicAmountId = uuid();
  const secretLinkId = uuid();
  const secretLinkPublicId = shortId("F");
  const secretCodeId = uuid();
  const secretViewId = uuid();

  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${basePublicId}, 'GQL autocomplete permissions')
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES
      (${publicTableId}::uuid, ${publicTablePublicId}, ${baseId}::uuid, 'PublicOrders', 0),
      (${secretTableId}::uuid, ${secretTablePublicId}, ${baseId}::uuid, 'SecretDeals', 1)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
    VALUES
      (${publicAmountId}::uuid, ${shortId("F")}, ${publicTableId}::uuid, 'PublicAmount', 'number', '{}'::jsonb, 0),
      (${secretLinkId}::uuid, ${secretLinkPublicId}, ${publicTableId}::uuid, 'SecretDeal', 'relation', ${{ targetTableId: secretTableId }}::jsonb, 1),
      (${secretCodeId}::uuid, ${shortId("F")}, ${secretTableId}::uuid, 'SecretCode', 'text', '{}'::jsonb, 0)
  `;
  await sql`
    INSERT INTO grids.views (id, short_id, table_id, name, source, ui, position)
    VALUES (${secretViewId}::uuid, ${shortId("V")}, ${secretTableId}::uuid, 'Secret view', ${`from table {${secretTablePublicId}}`}, '{}'::jsonb, 0)
  `;

  const accessId = await grantBaseRead(baseId, userId);
  return {
    baseId: basePublicId,
    internalBaseId: baseId,
    accessId,
    publicTableId: publicTablePublicId,
    internalPublicTableId: publicTableId,
    secretTableId: secretTablePublicId,
    secretLinkId: secretLinkPublicId,
  };
};

const insertRelationFixture = async (userId: string): Promise<GqlRelationApiFixture> => {
  const baseId = uuid();
  const basePublicId = shortId("B");
  const ordersTableId = uuid();
  const ordersTablePublicId = shortId("T");
  const customersTableId = uuid();
  const customersTablePublicId = shortId("T");
  const byCustomerViewId = uuid();
  const byCustomerViewPublicId = shortId("V");
  const amountId = uuid();
  const amountPublicId = shortId("F");
  const customerLinkId = uuid();
  const customerLinkPublicId = shortId("F");
  const customerNameId = uuid();
  const customerNamePublicId = shortId("F");
  const orderAId = uuid();
  const orderBId = uuid();
  const orderCId = uuid();
  const customerAId = uuid();
  const customerBId = uuid();
  const customerCId = uuid();

  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${basePublicId}, 'GQL API relation integration')
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES
      (${ordersTableId}::uuid, ${ordersTablePublicId}, ${baseId}::uuid, 'Orders', 0),
      (${customersTableId}::uuid, ${customersTablePublicId}, ${baseId}::uuid, 'Customers', 1)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
    VALUES
      (${amountId}::uuid, ${amountPublicId}, ${ordersTableId}::uuid, 'Amount', 'number', '{}'::jsonb, 0),
      (${customerLinkId}::uuid, ${customerLinkPublicId}, ${ordersTableId}::uuid, 'Customer', 'relation', ${{ targetTableId: customersTableId }}::jsonb, 1),
      (${customerNameId}::uuid, ${customerNamePublicId}, ${customersTableId}::uuid, 'Name', 'text', '{}'::jsonb, 0)
  `;
  await sql`
    INSERT INTO grids.views (id, short_id, table_id, name, source, ui, position)
    VALUES (
      ${byCustomerViewId}::uuid,
      ${byCustomerViewPublicId},
      ${ordersTableId}::uuid,
      'Revenue by customer',
      ${`from table {${ordersTablePublicId}}\ngroup by {${customerLinkPublicId}}\naggregate sum({${amountPublicId}}) as revenue`},
      '{}'::jsonb,
      0
    )
  `;
  await sql`
    INSERT INTO grids.records (id, short_id, table_id, data, version)
    VALUES
      (${customerAId}::uuid, ${shortId("R")}, ${customersTableId}::uuid, ${{ [customerNameId]: "Alice" }}::jsonb, 1),
      (${customerBId}::uuid, ${shortId("R")}, ${customersTableId}::uuid, ${{ [customerNameId]: "Bob" }}::jsonb, 1),
      (${customerCId}::uuid, ${shortId("R")}, ${customersTableId}::uuid, ${{ [customerNameId]: "Charlie" }}::jsonb, 1),
      (${orderAId}::uuid, ${shortId("R")}, ${ordersTableId}::uuid, ${{ [amountId]: "12.50" }}::jsonb, 1),
      (${orderBId}::uuid, ${shortId("R")}, ${ordersTableId}::uuid, ${{ [amountId]: "4.00" }}::jsonb, 1),
      (${orderCId}::uuid, ${shortId("R")}, ${ordersTableId}::uuid, ${{ [amountId]: "8.00" }}::jsonb, 1)
  `;
  await sql`
    INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
    VALUES
      (${orderAId}::uuid, ${customerLinkId}::uuid, ${customerAId}::uuid, 0),
      (${orderBId}::uuid, ${customerLinkId}::uuid, ${customerBId}::uuid, 0),
      (${orderCId}::uuid, ${customerLinkId}::uuid, ${customerCId}::uuid, 0)
  `;
  const accessId = await grantBaseRead(baseId, userId);

  return {
    baseId: basePublicId,
    internalBaseId: baseId,
    accessId,
    ordersTableId,
    customersTableId,
    byCustomerViewId: byCustomerViewPublicId,
    amountId: amountPublicId,
    customerLinkId,
    customerNameId,
  };
};

const cleanupFixture = async (baseId: string, accessId?: string): Promise<void> => {
  await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
  await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") {
    process.env.APP_SECRET ??= "grids-gql-integration-cursor-secret";
    await migrate();
  }
});

describe("GQL API route contract", () => {
  postgresTest("exposes GQL under /gql and leaves the legacy /query-dsl alias removed", async () => {
    const baseId = uuid();

    const gqlResponse = await apiRoutes.request(`/gql/by-base/${baseId}/preview`);
    expect(gqlResponse.status).toBe(401);
    expect(await gqlResponse.json()).toEqual({ message: "Authentication required" });

    const legacyResponse = await apiRoutes.request(`/query-dsl/by-base/${baseId}/preview`);
    expect(legacyResponse.status).toBe(404);
  });

  postgresTest("autocomplete exposes every source and field in a readable Base", async () => {
    const userId = await existingAuthUserId();
    const fixture = await insertAutocompleteBaseFixture(userId);
    const app = apiFor(testUser({ id: userId, roles: ["user"] }));

    try {
      const sourceResponse = await app.request(
        `/gql/by-base/${fixture.baseId}/autocomplete`,
        jsonRequest("POST", { query: "from table " }),
      );
      expect(sourceResponse.status).toBe(200);
      const sources = (await sourceResponse.json()) as AutocompleteResponse;
      expect(sources.items.map((item) => item.label)).toContain("PublicOrders");
      expect(sources.items.map((item) => item.label)).toContain("SecretDeals");

      const viewResponse = await app.request(`/gql/by-base/${fixture.baseId}/autocomplete`, jsonRequest("POST", { query: "from view " }));
      const views = (await viewResponse.json()) as AutocompleteResponse;
      expect(views.items.map((item) => item.label)).toContain("Secret view");

      const fieldResponse = await app.request(
        `/gql/by-base/${fixture.baseId}/autocomplete`,
        jsonRequest("POST", { query: "from table PublicOrders\nselect " }),
      );
      const fields = (await fieldResponse.json()) as AutocompleteResponse;
      expect(fields.items.map((item) => item.label)).toContain("PublicAmount");
      expect(fields.items.map((item) => item.label)).not.toContain("SecretCode");

      const otherTableFieldsResponse = await app.request(
        `/gql/by-base/${fixture.baseId}/autocomplete`,
        jsonRequest("POST", { query: "from table SecretDeals\nselect SecretCode" }),
      );
      const otherTableFields = (await otherTableFieldsResponse.json()) as AutocompleteResponse;
      expect(otherTableFields.diagnostics).toEqual([]);

      const sameBaseJoinResponse = await viewWriteCompilerFor(testUser({ id: userId, roles: ["user"] })).request(
        `/${fixture.internalBaseId}/${fixture.internalPublicTableId}`,
        jsonRequest("POST", {
          source: `from table {${fixture.publicTableId}} as visible\njoin table {${fixture.secretTableId}} as hidden on visible.{${fixture.secretLinkId}} = hidden.id`,
        }),
      );
      expect(sameBaseJoinResponse.status).toBe(200);
      const sameBaseJoin = (await sameBaseJoinResponse.json()) as CompileViewResponse;
      expect(sameBaseJoin.ok).toBe(true);
    } finally {
      await cleanupFixture(fixture.internalBaseId, fixture.accessId);
    }
  });

  postgresTest("canonicalizes implicit table and view current sources at the public API boundary", async () => {
    const user = testUser({ id: await existingAuthUserId(), roles: ["user"] });
    const fixture = await insertFixture(user.id);
    const app = apiFor(user);

    try {
      const tableScoped = await app.request(
        `/gql/by-base/${fixture.baseId}/compile-view`,
        jsonRequest("POST", {
          currentSource: { kind: "table", tableId: fixture.tableId },
          query: `
            select Amount
            where Stage = 'Open'
          `,
        }),
      );
      expect(tableScoped.status).toBe(200);
      const tableBody = (await tableScoped.json()) as CompileViewResponse;
      expect(tableBody.ok).toBe(true);
      if (!tableBody.ok) throw new Error(tableBody.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
      expect(tableBody.source).toBe(`from table {${fixture.tableId}}
select {${fixture.amountId}}
where {${fixture.stageId}} = 'open'`);

      const viewScoped = await app.request(
        `/gql/by-base/${fixture.baseId}/compile-view`,
        jsonRequest("POST", {
          currentSource: { kind: "view", viewId: fixture.viewId },
          query: `
            select Amount
            limit 2
          `,
        }),
      );
      expect(viewScoped.status).toBe(200);
      const viewBody = (await viewScoped.json()) as CompileViewResponse;
      expect(viewBody.ok).toBe(true);
      if (!viewBody.ok) throw new Error(viewBody.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
      expect(viewBody.source).toBe(`from view {${fixture.viewId}}
select {${fixture.amountId}}
limit 2`);
    } finally {
      await cleanupFixture(fixture.internalBaseId, fixture.accessId);
    }
  });

  postgresTest("previews derived relation search by target labels without an explicit join", async () => {
    const user = testUser({ id: await existingAuthUserId(), roles: ["user"] });
    const fixture = await insertRelationFixture(user.id);
    const app = apiFor(user);

    try {
      const response = await app.request(
        `/gql/by-base/${fixture.baseId}/preview`,
        jsonRequest("POST", {
          currentSource: { kind: "view", viewId: fixture.byCustomerViewId },
          query: `
            search 'Alice' in Customer
          `,
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: true;
        mode: "groups";
        columns: Array<{ key: string; type: string; sqlType: string }>;
        rows: Array<{ values: Record<string, unknown> }>;
      };
      if (!body.ok) throw new Error(JSON.stringify(body));
      expect(body.mode).toBe("groups");
      expect(body.columns.find((column) => column.key === "gk_0")).toMatchObject({ type: "relation", sqlType: "text" });
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0]?.values.gk_0).toBe("Alice");
      expect(Number(body.rows[0]?.values[`${fixture.amountId}__sum`])).toBe(12.5);
    } finally {
      await cleanupFixture(fixture.internalBaseId, fixture.accessId);
    }
  });

  postgresTest("paginates exact saved-view GQL with signed, permission-checked cursors", async () => {
    const user = testUser({ id: await existingAuthUserId(), roles: ["user"] });
    const fixture = await insertRelationFixture(user.id);
    const app = apiFor(user);

    try {
      const executePath = `/gql/by-base/${fixture.baseId}/views/${fixture.byCustomerViewId}/execute`;
      const firstResponse = await app.request(executePath, jsonRequest("POST", { pageSize: 2 }));
      expect(firstResponse.status).toBe(200);
      const first = (await firstResponse.json()) as DslQueryExecuteResponse;
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));
      expect(first.rows).toHaveLength(2);
      expect(first.page?.nextCursor).toBeTruthy();

      const secondResponse = await app.request(executePath, jsonRequest("POST", { pageSize: 1, cursor: first.page?.nextCursor }));
      const second = (await secondResponse.json()) as DslQueryExecuteResponse;
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error(JSON.stringify(second.diagnostics));
      expect(second.rows).toHaveLength(1);
      expect(first.rows.map((row) => row.values.gk_0)).not.toContain(second.rows[0]?.values.gk_0);
      expect(second.page?.nextCursor).toBeNull();

      const cursor = first.page?.nextCursor ?? "";
      const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
      const tamperedResponse = await app.request(executePath, jsonRequest("POST", { cursor: tampered }));
      const tamperedBody = (await tamperedResponse.json()) as DslQueryExecuteResponse;
      expect(tamperedBody.ok).toBe(false);
      if (tamperedBody.ok) throw new Error("expected cursor diagnostic");
      expect(tamperedBody.diagnostics[0]?.message).toBe("The result cursor is invalid or no longer matches this query.");

      await sql`DELETE FROM auth.access WHERE id = ${fixture.accessId}::uuid`;
      const revokedResponse = await app.request(executePath, jsonRequest("POST", { cursor }));
      expect(revokedResponse.status).toBe(200);
      const revoked = (await revokedResponse.json()) as DslQueryExecuteResponse;
      expect(revoked.ok).toBe(false);
      if (revoked.ok) throw new Error("expected permission diagnostic");
      expect(revoked.diagnostics[0]?.message).toBe("View not found or you do not have permission to access it.");
    } finally {
      await cleanupFixture(fixture.internalBaseId, fixture.accessId);
    }
  });

  postgresTest("returns parser and canonicalization diagnostics instead of generic API errors", async () => {
    const user = testUser({ id: await existingAuthUserId(), roles: ["user"] });
    const fixture = await insertFixture(user.id);
    const app = apiFor(user);

    try {
      const legacySyntax = await app.request(
        `/gql/by-base/${fixture.baseId}/compile-view`,
        jsonRequest("POST", {
          query: "from table #Orders",
        }),
      );
      expect(legacySyntax.status).toBe(200);
      const legacyBody = (await legacySyntax.json()) as CompileViewResponse;
      expect(legacyBody.ok).toBe(false);
      if (legacyBody.ok) throw new Error("expected parser diagnostics");
      expect(legacyBody.diagnostics[0]?.message.startsWith("legacy # references are not valid in GQL")).toBe(true);

      const unknownOption = await app.request(
        `/gql/by-base/${fixture.baseId}/compile-view`,
        jsonRequest("POST", {
          query: "from table Orders\nwhere Stage = 'Missing'",
        }),
      );
      expect(unknownOption.status).toBe(200);
      const optionBody = (await unknownOption.json()) as CompileViewResponse;
      expect(optionBody.ok).toBe(false);
      if (optionBody.ok) throw new Error("expected canonicalization diagnostics");
      expect(optionBody.diagnostics[0]?.message).toBe('unknown option "Missing" for "Stage"; expected one of: Open, Closed, On hold');
    } finally {
      await cleanupFixture(fixture.internalBaseId, fixture.accessId);
    }
  });
});
