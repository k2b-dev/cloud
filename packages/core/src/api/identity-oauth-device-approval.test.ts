import { afterAll, beforeAll, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import * as settings from "@k2b/cloud/services/settings";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAppApproval } from "../migrate/core/app-approval";
import { migrate as migrateOAuthClients } from "../migrate/core/oauth-clients";
import { cleanupTerminalLogins, createIdentityOAuthDeviceApprovalRoutes, terminalLogins } from "./identity-oauth-device-approval";

const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);
const input = () => ({
  deviceAuthorizationId: "a5ae9b9c-94f4-49a8-a954-c87839affc3d",
  identifier: "alice",
  clientId: "third-party-cli",
  clientName: "Third-party CLI",
  scopes: ["openid", "read"],
  lifetimeSeconds: 3600,
  grantExpiresAt: new Date(NOW + 300_000).toISOString(),
});
const authorize: Parameters<typeof createIdentityOAuthDeviceApprovalRoutes>[2] = async (c) => {
  c.set("oauthIssuerAppId", "third-party-issuer");
  return null;
};
const request = (routes: ReturnType<typeof createIdentityOAuthDeviceApprovalRoutes>, body: unknown) =>
  routes.request("/oauth/device-approval", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeAll(() => setSystemTime(NOW));
afterAll(() => setSystemTime());

describe("Core platform terminal handoff", () => {
  test("authenticates before reading even a malformed or oversized body", async () => {
    const routes = createIdentityOAuthDeviceApprovalRoutes(undefined, undefined, async (c) => c.json({ code: "UNAUTHORIZED" }, 401));
    expect(
      (await routes.request("/oauth/device-approval", { method: "POST", headers: { "content-length": "300000" }, body: "{" })).status,
    ).toBe(401);
  });
  test("rejects malformed, unknown and unbounded statement fields before SQL", async () => {
    let queries = 0;
    const db = new Proxy(sql, {
      apply: () => {
        queries++;
        throw new Error("Unexpected query");
      },
    });
    const routes = createIdentityOAuthDeviceApprovalRoutes(undefined, db, authorize);
    for (const body of [
      {},
      { ...input(), extra: true },
      { ...input(), issuerAppId: "oauth" },
      { ...input(), identifier: " " },
      { ...input(), deviceAuthorizationId: "invalid" },
      { ...input(), clientName: "" },
      { ...input(), scopes: ["admin"] },
      { ...input(), scopes: ["read", "read"] },
      { ...input(), scopes: ["bad scope"] },
      { ...input(), lifetimeSeconds: 0 },
      { ...input(), lifetimeSeconds: 7776001 },
      { ...input(), grantExpiresAt: "invalid" },
    ]) {
      expect((await request(routes, body)).status).toBe(400);
    }
    expect(queries).toBe(0);
  });
  test("binds the signed issuer, displayed name, scope, deadline and capped lifetime without issuer-schema reads", async () => {
    const queries: string[] = [];
    const db = new Proxy(sql, {
      apply: (_target, _this, args) => {
        const query = args[0].join("");
        queries.push(query);
        return Promise.resolve([{ client_id: input().clientId }]);
      },
    });
    const captured: unknown[] = [];
    const hours = spyOn(settings, "get").mockResolvedValue(1);
    try {
      const routes = createIdentityOAuthDeviceApprovalRoutes(
        {
          startTerminalLogin: async (value) => {
            captured.push(value);
            return { comparison: "012345", expiresAt: input().grantExpiresAt };
          },
        },
        db,
        authorize,
      );
      expect((await request(routes, { ...input(), lifetimeSeconds: 7200 })).status).toBe(200);
      expect(captured).toEqual([{ ...input(), issuerAppId: "third-party-issuer" }]);
      expect(queries.join("\n")).toContain("auth.oauth_clients");
      expect(queries.join("\n")).not.toContain("oauth.");
    } finally {
      hours.mockRestore();
    }
  });
});

databaseSuite()("Core terminal evidence without issuer domain tables", () => {
  beforeAll(async () => {
    await migrateAppApproval();
    await migrateOAuthClients();
  });
  test("inbox describes the saved display statement and rejects disabled clients", async () => {
    const id = crypto.randomUUID(),
      grant = crypto.randomUUID(),
      client = `terminal-${id}`;
    await sql`INSERT INTO auth.oauth_clients(client_id,issuer_app_id,status,name) VALUES (${client},'third-party-issuer','active','Current registry name')`;
    await sql`INSERT INTO auth.app_logins(id,issuer,category,browser_hash,challenge,comparison,expires_at,kind,
      device_authorization_id,client_id,scopes,lifetime_seconds,oauth_issuer_app_id,oauth_client_name,oauth_grant_expires_at)
      VALUES (${id}::uuid,'https://login.example.test','login','hash','challenge','012345',now()+interval '5 minutes','terminal',
        ${grant}::uuid,${client},ARRAY['read'],3600,'third-party-issuer','Displayed at start',now()+interval '5 minutes')`;
    try {
      expect(await terminalLogins.describe(sql, [id])).toEqual(new Map([[id, { id: client, name: "Displayed at start" }]]));
      await sql`UPDATE auth.oauth_clients SET status='disabled' WHERE client_id=${client}`;
      expect(await terminalLogins.describe(sql, [id])).toEqual(new Map());
    } finally {
      await sql`DELETE FROM auth.app_logins WHERE id=${id}::uuid`;
      await sql`DELETE FROM auth.oauth_clients WHERE client_id=${client}`;
    }
  });
  test("cleanup retains approved evidence through the grant deadline, independent of UI expiry", async () => {
    const id = crypto.randomUUID(),
      grant = crypto.randomUUID();
    await sql`INSERT INTO auth.app_logins(id,issuer,category,browser_hash,challenge,comparison,expires_at,kind,
      device_authorization_id,client_id,scopes,lifetime_seconds,state,oauth_issuer_app_id,oauth_client_name,oauth_grant_expires_at)
      VALUES (${id}::uuid,'https://login.example.test','login','hash','challenge','012345',now()-interval '1 minute','terminal',
        ${grant}::uuid,'third-party-cli',ARRAY['read'],3600,'approved','third-party-issuer','CLI',now()+interval '5 minutes')`;
    try {
      await cleanupTerminalLogins();
      expect(await sql`SELECT id FROM auth.app_logins WHERE id=${id}::uuid`).toHaveLength(1);
      await sql`UPDATE auth.app_logins SET oauth_grant_expires_at=now()-interval '1 second' WHERE id=${id}::uuid`;
      await cleanupTerminalLogins();
      expect(await sql`SELECT id FROM auth.app_logins WHERE id=${id}::uuid`).toHaveLength(0);
    } finally {
      await sql`DELETE FROM auth.app_logins WHERE id=${id}::uuid`;
    }
  });
});
