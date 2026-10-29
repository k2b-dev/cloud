import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { sql } from "bun";
import { Hono, type MiddlewareHandler } from "hono";
import { generateKeyPair } from "jose";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { bindResourceAppAccess } from "../_internal/app-access-resources";
import { compileCapabilities } from "../_internal/capabilities";
import { person } from "../_internal/define-app.test-fixture";
import * as registry from "../_internal/registry";
import { cliPluginListRoutes } from "../api/cli-plugins";
import { createSearchRoutes } from "../api/search";
import { appAccess, compileAppAccess } from "../contracts/app-access";
import { defineCapabilities, UniversalSearchDataSchema, UniversalSearchInputSchema } from "../contracts/capabilities";
import type { AppRegistryEntry } from "../contracts/registry";
import { requireAppAccess } from "../server/middleware/app-access";
import type { AuthContext, RequestAuthority } from "../server/middleware/auth";
import * as authMiddleware from "../server/middleware/auth";
import { buildAccessPrincipalCondition } from "../server/services/access";
import { discoverableApps } from "./app-discovery";
import * as settings from "./settings";

const suite = databaseSuite();
afterEach(() => setSystemTime());
suite("resource-derived app entry and discovery", () => {
  test("the same existing right controls entry, search and CLI; the next request observes revocation", async () => {
    setSystemTime(new Date("2026-10-28T12:00:00Z"));
    await sql.begin(async (db) => {
      // PostgreSQL forbids temporary-to-permanent foreign keys. Keep revoked
      // grant IDs here so the existence query must reject stale references too.
      await db`CREATE TEMP TABLE app_resource_rights (resource_id text NOT NULL, access_id uuid NOT NULL) ON COMMIT DROP`;
      const uid = `app-resources-${crypto.randomUUID()}`;
      const [user] = await db<
        { id: string }[]
      >`INSERT INTO auth.users (uid, provider, profile, display_name) VALUES (${uid}, 'local', 'guest', 'Fictional Guest') RETURNING id`;
      const [parent] = await db<
        { id: string }[]
      >`INSERT INTO auth.groups (cn, provider, name) VALUES (${uid}, 'local', 'Parent') RETURNING id`;
      const [child] = await db<
        { id: string }[]
      >`INSERT INTO auth.groups (cn, provider, name) VALUES (${`${uid}-child`}, 'local', 'Child') RETURNING id`;
      const [account] = await db<
        { id: string }[]
      >`INSERT INTO auth.service_accounts (name, kind) VALUES (${uid}, 'standalone') RETURNING id`;
      const declaration = appAccess.resources({
        adapters: {
          workspace: {
            hasAnyRight: async (subject, { authority, signal }) => {
              signal.throwIfAborted();
              const bound =
                authority.actor.kind === "service_account" && authority.actor.serviceAccount.kind === "resource_bound"
                  ? authority.actor.serviceAccount.resourceId
                  : null;
              const principal = buildAccessPrincipalCondition({
                subject,
                columns: {
                  userId: db`a.user_id`,
                  groupId: db`a.group_id`,
                  serviceAccountId: db`a.service_account_id`,
                  authenticatedOnly: db`a.authenticated_only`,
                },
              });
              const [row] = await db<
                { allowed: boolean }[]
              >`SELECT EXISTS (SELECT 1 FROM app_resource_rights r JOIN auth.access a ON a.id = r.access_id WHERE a.permission IN ('read','write','admin') AND ${principal} AND (${bound}::text IS NULL OR r.resource_id = ${bound})) AS allowed`;
              return row?.allowed === true;
            },
          },
        },
      });
      const app: AppRegistryEntry = {
        id: "resource-integration",
        name: "Resources",
        description: "Fictional app",
        icon: "ti ti-box",
        routes: ["/app/resources"],
        nav: { href: "/app/resources", section: "primary" },
        cliModules: ["resources"],
        baseUrl: "http://resources.test",
        access: compileAppAccess(declaration),
      };
      let current: RequestAuthority = {
        actor: { kind: "user", user: { ...person, id: user!.id, profile: "guest", roles: ["guest"] } },
        accessSubject: { type: "user", userId: user!.id },
        credentialKind: "session",
        scopes: [],
      };
      const install: MiddlewareHandler<AuthContext> = async (c, next) => {
        c.set("actor", current.actor);
        c.set("accessSubject", current.accessSubject);
        c.set("credentialKind", current.credentialKind);
        c.set("credentialScopes", current.scopes);
        if (current.actor.kind === "user") c.set("user", current.actor.user);
        await next();
      };
      const stop = bindResourceAppAccess(app.id, declaration);
      const spies = [
        spyOn(registry, "listApps").mockResolvedValue([app]),
        spyOn(settings, "get").mockResolvedValue("all_users"),
        spyOn(authMiddleware.auth.session, "authenticateRequest").mockImplementation(async () =>
          current.actor.kind === "user"
            ? {
                user: current.actor.user,
                data: { userId: current.actor.user.id, sid: "fixture", authEpoch: 0, kind: "web", expiresAt: "2026-10-29T12:00:00Z" },
              }
            : null,
        ),
        spyOn(authMiddleware, "loadAuthenticatedActor").mockImplementation(async (c) => {
          await install(c, async () => {});
          return { token: "fixture", user: current.actor.kind === "user" ? current.actor.user : null, actor: current.actor };
        }),
      ];
      const capabilities = defineCapabilities({
        protocolVersion: 2,
        types: { item: { title: "Item", description: "Fictional item" } },
        queries: {
          search: {
            title: "Search",
            description: "Find items",
            input: UniversalSearchInputSchema,
            data: UniversalSearchDataSchema,
            openWorld: false,
            universalSearch: { tags: [{ tag: "item", title: "Items", description: "Find items", aliases: [] }] },
            run: async () => ok({ data: [] }),
          },
        },
      });
      const manifest = compileCapabilities(app.id, capabilities).manifest;
      const signer = {
        issuer: "https://cloud.test",
        kid: "22222222-2222-4222-8222-222222222222",
        key: (await generateKeyPair("RS256")).privateKey,
        signUntil: new Date("2100-01-01"),
      };
      let searchCalls = 0;
      const search = createSearchRoutes({
        authenticate: install,
        listApps: async () => [app],
        listCapabilities: async () => [
          {
            appId: app.id,
            appName: app.name,
            appDescription: app.description,
            appIcon: app.icon,
            endpoint: "http://resources.test/capabilities",
            manifest,
          },
        ],
        withActiveSigner: async (_purpose, callback) => callback(signer, sql),
        signInvocation: async (params) =>
          (await import("./identity/invocation-token")).signInvocationToken({ ...params, signer, issuer: "https://cloud.test" }),
        fetch: async () => {
          searchCalls++;
          return Response.json({ data: [] });
        },
      });
      const direct = new Hono<AuthContext>()
        .use(requireAppAccess(app, async () => new Response("Forbidden", { status: 403 })))
        .get("*", (c) => c.text("private content"));
      const cli = new Hono<AuthContext>().route("/cli/plugins", cliPluginListRoutes);
      const assertSurfaces = async (allowed: boolean) => {
        expect(await discoverableApps(current, [app])).toEqual(allowed ? [app] : []);
        expect((await direct.request("/app/resources")).status).toBe(allowed ? 200 : 403);
        const cliResponse = await cli.request("/cli/plugins", { headers: { cookie: "session_token=fixture" } });
        expect(cliResponse.status).toBe(200);
        expect((await cliResponse.json()).plugins.map((plugin: { name: string }) => plugin.name)).toEqual(allowed ? ["resources"] : []);
        const before = searchCalls;
        const searchResponse = await search.request("/search?q=item");
        expect(searchResponse.status).toBe(200);
        expect((await searchResponse.json()).apps.map((entry: { id: string }) => entry.id)).toEqual(allowed ? [app.id] : []);
        expect(searchCalls - before).toBe(allowed ? 1 : 0);
      };
      const grants: string[] = [];
      try {
        await assertSurfaces(false);
        await db`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${user!.id}::uuid, ${child!.id}::uuid)`;
        await db`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parent!.id}::uuid, ${child!.id}::uuid)`;
        const [grant] = await db<
          { id: string }[]
        >`INSERT INTO auth.access (group_id, permission) VALUES (${parent!.id}::uuid, 'none') RETURNING id`;
        grants.push(grant!.id);
        await db`INSERT INTO app_resource_rights VALUES ('one', ${grant!.id}::uuid)`;
        await assertSurfaces(false);
        await db`UPDATE auth.access SET permission = 'read' WHERE id = ${grant!.id}::uuid`;
        await assertSurfaces(true); // A guest uses the app only through its existing group right.
        await db`DELETE FROM auth.user_groups_v2 WHERE user_id = ${user!.id}::uuid`;
        await assertSurfaces(false);
        await db`UPDATE auth.access SET group_id = NULL, authenticated_only = true WHERE id = ${grant!.id}::uuid`;
        await assertSurfaces(true);
        await db`DELETE FROM auth.access WHERE id = ${grant!.id}::uuid`;
        await assertSurfaces(false);
        current = {
          actor: {
            kind: "service_account",
            delegatedUser: null,
            scopes: ["read"],
            serviceAccount: {
              id: account!.id,
              name: "Fixture",
              kind: "standalone",
              status: "active",
              delegatedUserId: null,
              appId: null,
              resourceType: null,
              resourceId: null,
              createdBy: null,
              createdAt: "2026-10-28T12:00:00Z",
            },
          },
          accessSubject: { type: "service_account", serviceAccountId: account!.id },
          credentialKind: "api_key",
          scopes: ["read"],
        };
        expect(await discoverableApps(current, [app])).toEqual([]);
        const [serviceGrant] = await db<
          { id: string }[]
        >`INSERT INTO auth.access (service_account_id, permission) VALUES (${account!.id}::uuid, 'write') RETURNING id`;
        grants.push(serviceGrant!.id);
        await db`INSERT INTO app_resource_rights VALUES ('one', ${serviceGrant!.id}::uuid)`;
        expect(await discoverableApps(current, [app])).toEqual([app]);
        expect((await direct.request("/app/resources")).status).toBe(200);
        current.scopes = ["other:read"];
        expect((await direct.request("/app/resources")).status).toBe(403);
        current.scopes = ["read"];
        if (current.actor.kind !== "service_account") throw new Error("fixture");
        current.actor.serviceAccount = {
          ...current.actor.serviceAccount,
          kind: "resource_bound",
          appId: app.id,
          resourceType: "workspace",
          resourceId: "other",
        };
        expect((await direct.request("/app/resources")).status).toBe(403);
        current.actor.serviceAccount.resourceId = "one";
        expect((await direct.request("/app/resources")).status).toBe(200);
        await db`DELETE FROM auth.access WHERE id = ${serviceGrant!.id}::uuid`;
        expect((await direct.request("/app/resources")).status).toBe(403);
      } finally {
        stop();
        for (const spy of spies) spy.mockRestore();
        for (const id of grants) await db`DELETE FROM auth.access WHERE id = ${id}::uuid`;
        await db`DELETE FROM auth.service_accounts WHERE id = ${account!.id}::uuid`;
        await db`DELETE FROM auth.groups WHERE id IN (${parent!.id}::uuid, ${child!.id}::uuid)`;
        await db`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
      }
    });
  });
});
