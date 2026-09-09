import { beforeAll, describe, expect } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { sql } from "bun";
import { Hono } from "hono";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import routes from "./html-template-fields";

const app = new Hono<AuthContext>().route("/html-template-fields", routes);

const request = (token: string, body: unknown): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("HTML template field route", () => {
  postgresTest("requires admin scope and reports invalid input", async () => {
    const userId = testUuid();
    const baseId = testUuid();
    const tableId = testUuid();
    const fieldId = testUuid();
    const accessId = testUuid();
    const baseShortId = testShortId("B");
    const tableShortId = testShortId("T");
    const fieldShortId = testShortId("H");
    const user: User = {
      id: userId,
      uid: `html-template-route-${userId}`,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: "HTML",
      sn: "Template",
      displayName: "HTML Template",
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
    let serviceAccountId: string | undefined;

    try {
      await sql`
        INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
        VALUES (${userId}::uuid, ${user.uid}, 'local', 'user', ${user.displayName}, ${user.givenname}, ${user.sn})
      `;
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'HTML template route')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name, position)
        VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Items', 0)
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${fieldId}::uuid, ${fieldShortId}, ${tableId}::uuid, 'HTML', 'html_template', '{}'::jsonb, 0)
      `;

      const account = await serviceAccounts.getOrCreateResourceBound({
        name: "HTML template route",
        appId: "grids",
        resourceType: "base",
        resourceId: baseId,
        createdBy: userId,
      });
      if (!account.ok) throw new Error(account.error.message);
      serviceAccountId = account.data.id;
      await sql`
        INSERT INTO auth.access (id, service_account_id, permission)
        VALUES (${accessId}::uuid, ${serviceAccountId}::uuid, 'admin'::auth.permission_level)
      `;
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${accessId}::uuid)`;

      const token = async (scope: "read" | "admin") => {
        const result = await serviceAccountCredentials.createResourceApiToken({
          serviceAccountId: serviceAccountId!,
          actor: user,
          name: `HTML template route ${scope}`,
          scopes: [`grids:${scope}`],
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.data.token;
      };
      const [readToken, adminToken] = await Promise.all([token("read"), token("admin")]);
      const validBody = { currentFieldId: fieldShortId, template: "<p>Hello</p>", css: "" };

      expect((await app.request(`/html-template-fields/by-table/${tableShortId}/check`, request(readToken, validBody))).status).toBe(403);
      expect((await app.request(`/html-template-fields/by-table/${tableShortId}/check`, request(adminToken, validBody))).status).toBe(200);
      expect(
        (
          await app.request(
            `/html-template-fields/by-table/${tableShortId}/check`,
            request(adminToken, { currentFieldId: fieldShortId, template: "<p>Hello</p>" }),
          )
        ).status,
      ).toBe(400);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      if (serviceAccountId) await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
