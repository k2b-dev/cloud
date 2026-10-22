import { beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { aiSkills, aiSkillsRoutes } from "@k2b/cloud/ai";
import { createAiOpenAiRoutes, createCoreApiRouter } from "@k2b/cloud/api";
import type { AppRegistryEntry } from "@k2b/cloud/contracts";
import type { AuthContext, RequestAuthority } from "@k2b/cloud/server";
import { requireAppAccess } from "@k2b/cloud/server/middleware/app-access";
import { sql } from "bun";
import { Hono } from "hono";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import * as registry from "../../cloud/src/_internal/registry";
import { migrateCloudAi } from "../../cloud/src/ai/migrate";
import * as appAccess from "../../cloud/src/services/app-access";
import * as appAccessMetrics from "../../cloud/src/services/app-access-metrics";
import {
  type AuthenticatedServiceAccountCredential,
  serviceAccountCredentials,
} from "../../cloud/src/services/service-account-credentials";
import { session } from "../../cloud/src/services/session";
import { buildProjectedUser } from "../../cloud/src/services/session/user";
import * as settings from "../../cloud/src/services/settings";
import { aiChatTaskRoutes } from "./ai-chat-task-routes";

const token = `cld_${"a".repeat(24)}_${"b".repeat(64)}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const browserHeaders = { cookie: "session_token=skills-mount-session", "content-type": "application/json" };

// Match Core's production API composition, including both dedicated brokers,
// the wildcard Task middleware and the complete generic API/type surface.
const mounted = (core: AppRegistryEntry) => {
  const unused = async () => {
    throw new Error("Unused notification");
  };
  const { api } = createCoreApiRouter({
    notifications: { sendMagicLink: unused, sendIpaLoginHint: unused, sendPasswordReset: unused, sendNewBrowserSignIn: async () => {} },
  });
  const coreApi = new Hono()
    .route("/ai/openai/v1", createAiOpenAiRoutes())
    .route("/ai/skills", aiSkillsRoutes)
    .route("/ai", aiChatTaskRoutes)
    .route("/", api);
  return new Hono<AuthContext>()
    .use(
      "*",
      requireAppAccess(core, async () => new Response("Core denied", { status: 403 })),
    )
    .route("/api", coreApi);
};

suiteFor("database", "valkey")("Core Skills broker mount order", () => {
  beforeAll(async () => migrateCloudAi());

  test("non-user reads reach real app/resource checks while management and Task/chat guards stay intact", async () => {
    setSystemTime(new Date("2026-10-22T12:00:00Z"));
    const suffix = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const accountId = crypto.randomUUID();
    const user = buildProjectedUser({ id: userId, provider: "local", profile: "user", effective_admin: false });
    const subject = { type: "user" as const, userId };
    const owner: RequestAuthority = { actor: { kind: "user", user }, accessSubject: subject, credentialKind: "session", scopes: [] };
    const ownApp: AppRegistryEntry = {
      id: `skills-mount-${suffix}`,
      name: "Skill fixture",
      description: "Mount regression fixture",
      icon: "ti ti-book",
      routes: [],
      baseUrl: "http://skills.invalid",
      access: { kind: "signedIn" },
    };
    let core: AppRegistryEntry = {
      ...ownApp,
      id: "core",
      name: "Core",
      // PR1's registered undeclared Core must work before PR3 is deployed.
      access: undefined,
    };
    let apps = [ownApp];
    const otherApp = { ...ownApp, id: `skills-other-${suffix}` };
    let current: AuthenticatedServiceAccountCredential = {
      serviceAccount: {
        id: accountId,
        name: "Skill reader",
        kind: "resource_bound",
        status: "active",
        delegatedUserId: null,
        appId: ownApp.id,
        resourceType: "notebook",
        resourceId: suffix,
        createdBy: null,
        createdAt: "2026-10-01T00:00:00Z",
      },
      delegatedUser: null,
      credential: {
        id: crypto.randomUUID(),
        serviceAccountId: accountId,
        name: "Skill reader key",
        kind: "api_token",
        status: "active",
        tokenPrefix: "cld_fixture",
        scopes: ["read"],
        expiresAt: null,
        lastUsedAt: null,
        createdBy: null,
        createdAt: "2026-10-01T00:00:00Z",
        revokedAt: null,
        revokedBy: null,
      },
    };
    const boundAccount = { ...current.serviceAccount };
    const spies: { mockRestore(): void }[] = [];
    const created: string[] = [];
    // Fixture only persisted identity/registry lookups. Cookie/bearer selection,
    // normal credential resolution, middleware, app access and Skill SQL are real.
    spies.push(spyOn(serviceAccountCredentials, "authenticateApiToken").mockImplementation(async () => current));
    spies.push(
      spyOn(session, "authenticateRequest").mockImplementation(async (_c, value) =>
        value === "skills-mount-session"
          ? { user, data: { userId, sid: "skills-mount-session", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z", kind: "web" } }
          : null,
      ),
    );
    spies.push(spyOn(registry, "listApps").mockImplementation(async () => [core, ...apps, otherApp]));
    spies.push(spyOn(registry, "getApp").mockImplementation(async (id) => (id === "core" ? core : null)));
    // Persisted test configuration follows the existing auth fixtures' request budget.
    spies.push(spyOn(settings, "get").mockResolvedValue(1000));
    spies.push(spyOn(appAccessMetrics, "recordAppAccessDenied").mockImplementation(() => {}));
    const audience = spyOn(appAccess, "usableAppIds");
    spies.push(audience);
    const create = spyOn(aiSkills, "create");
    spies.push(create);
    try {
      await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${userId}::uuid,${`skills-mount-${suffix}`},'local','user')`;
      await sql`INSERT INTO auth.service_accounts(id,name,kind,app_id,resource_type,resource_id)
        VALUES(${accountId}::uuid,'Skill reader','resource_bound',${ownApp.id},'notebook',${suffix})`;
      const skills = [];
      for (const [label, app] of [
        ["own", ownApp],
        ["other", otherApp],
        ["ungranted", ownApp],
      ] as const) {
        const skill = await aiSkills.create(
          { subject, name: `mount-${label}-${suffix}`, description: "Fixture.", instructions: "Original instructions." },
          owner,
        );
        created.push(skill.id);
        skills.push(skill);
        await sql`INSERT INTO ai.app_skills(key,app_id,app_name,name,skill_id,available)
          VALUES(${`app:${app.id}/${skill.name}`},${app.id},${app.name},${skill.name},${skill.id}::uuid,true)`;
        if (label !== "ungranted") {
          await aiSkills.admin.grantAccess(skill.id, {
            principal: { type: "service_account", serviceAccountId: accountId },
            permission: "admin",
          });
        }
      }
      const [own, other, ungranted] = skills;
      if (!own || !other || !ungranted) throw new Error("Skill fixtures missing");
      // Cover PR1 legacy Core and the later declaration/exact public exception.
      for (const access of [undefined, { kind: "signedIn" as const, publicRoutes: ["/api/ai/skills", "/api/ai/skills/*"] }]) {
        core = { ...core, access };
        const router = mounted(core);
        for (const kind of ["resource_bound", "standalone"] as const) {
          current.serviceAccount =
            kind === "resource_bound" ? { ...boundAccount } : { ...boundAccount, kind, appId: null, resourceType: null, resourceId: null };
          current.credential.scopes = kind === "resource_bound" ? ["read"] : [`${ownApp.id}:read`];
          audience.mockClear();
          for (const query of ["", `?name=${own.name}`, `?q=${own.name}`]) {
            const response = await router.request(`/api/ai/skills${query}`, { headers });
            expect(response.status).toBe(200);
            expect((await response.json()).skills.map((entry: { id: string }) => entry.id)).toEqual([own.shortId]);
          }
          expect((await router.request(`/api/ai/skills/${own.shortId}`, { headers })).status).toBe(200);
          for (const target of [other, ungranted]) {
            expect((await router.request(`/api/ai/skills/${target.shortId}`, { headers })).status).toBe(404);
          }
          expect(audience.mock.calls.length).toBeGreaterThan(0);
          for (const [authority] of audience.mock.calls) {
            expect(authority).toMatchObject({
              actor: {
                kind: "service_account",
                serviceAccount: current.serviceAccount,
                scopes: current.credential.scopes,
                delegatedUser: null,
              },
              accessSubject: { type: "service_account", serviceAccountId: accountId },
              credentialKind: "api_key",
              scopes: current.credential.scopes,
            });
          }
          apps = [{ ...ownApp, access: { kind: "roles", roles: ["admin"] } }];
          expect(await (await router.request("/api/ai/skills", { headers })).json()).toEqual({ skills: [] });
          expect((await router.request(`/api/ai/skills/${own.shortId}`, { headers })).status).toBe(404);
          apps = [ownApp];
        }
      }
      const router = mounted(core);
      const content = { name: `mount-new-${suffix}`, description: "Fixture.", instructions: "New instructions." };
      // Core entry allows a general standalone key, but the old production
      // user requirement must still reject every management operation.
      current.serviceAccount = { ...boundAccount, kind: "standalone", appId: null, resourceType: null, resourceId: null };
      current.credential.scopes = ["read", "write"];
      create.mockClear();
      for (const [path, method, body] of [
        ["", "POST", content],
        [`/${own.shortId}`, "PUT", { ...content, expectedRevision: own.revision }],
        [`/${own.shortId}`, "DELETE", undefined],
        [`/${own.shortId}/enabled`, "PUT", { enabled: false }],
        [`/${own.shortId}/projects/proj12`, "PUT", { linked: true }],
        [`/${own.shortId}/access`, "POST", { principal: { type: "authenticated" }, permission: "read" }],
        [`/${own.shortId}/access/aCc234`, "PATCH", { permission: "write" }],
        [`/${own.shortId}/access/aCc234`, "DELETE", undefined],
        ["/project-links/proj12", "GET", undefined],
        [`/${own.shortId}/projects`, "GET", undefined],
        [`/${own.shortId}/access`, "GET", undefined],
      ] as const) {
        const response = await router.request(`/api/ai/skills${path}`, {
          headers,
          method,
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("user-backed") });
      }
      expect(create).not.toHaveBeenCalled();
      const [unchanged] = await sql`SELECT revision,instructions FROM ai.skills WHERE id=${own.id}::uuid`;
      expect(unchanged?.revision).toBe(own.revision);
      expect(unchanged?.instructions).toBe("Original instructions.");
      const taskRouter = mounted({ ...core, access: undefined });
      for (const path of ["/api/ai/tasks", "/api/ai/conversations"]) {
        const response = await taskRouter.request(path, { headers });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ message: expect.stringContaining("user-backed") });
        expect((await taskRouter.request(path)).status).toBe(401);
      }
      // Both a real resolved browser user and a delegated API actor may manage;
      // the same delegated user's target-only scope cannot enter Core management.
      for (const requestHeaders of [browserHeaders, headers]) {
        current.serviceAccount = { ...current.serviceAccount, kind: "user_delegated", delegatedUserId: userId };
        current.delegatedUser = user;
        current.credential.scopes = ["core:write"];
        const response = await router.request("/api/ai/skills", { headers: requestHeaders, method: "POST", body: JSON.stringify(content) });
        expect(response.status).toBe(201);
        expect(create).toHaveBeenCalledTimes(1);
        const payload: { skill: { id: string } } = await response.json();
        const id = payload.skill.id;
        const added = await aiSkills.getByShortId(id, subject, "admin", owner);
        if (!added) throw new Error("Created Skill missing");
        created.push(added.id);
        expect(create.mock.calls.at(-1)?.[1]).toMatchObject({
          credentialKind: requestHeaders === browserHeaders ? "session" : "api_key",
          scopes: requestHeaders === browserHeaders ? [] : ["core:write"],
          accessSubject: subject,
        });
        await aiSkills.admin.delete(added.id);
        created.pop();
        create.mockClear();
      }
      current.credential.scopes = [`${ownApp.id}:write`];
      create.mockClear();
      const denied = await router.request("/api/ai/skills", { headers, method: "POST", body: JSON.stringify(content) });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "app_access_denied", app: "core" });
      expect(create).not.toHaveBeenCalled();
      core = { ...core, access: { kind: "roles", roles: ["admin"], publicRoutes: ["/api/ai/skills", "/api/ai/skills/*"] } };
      const userDenied = await router.request("/api/ai/skills", { headers: browserHeaders, method: "POST", body: JSON.stringify(content) });
      expect(userDenied.status).toBe(403);
      expect(await userDenied.json()).toMatchObject({ code: "app_access_denied", app: "core" });
      expect(create).not.toHaveBeenCalled();
      for (const scopes of [["ai:inference"], ["identity:invoke"]]) {
        current.serviceAccount = { ...boundAccount, resourceType: "cloud.app", resourceId: ownApp.id };
        current.delegatedUser = null;
        current.credential.scopes = scopes;
        for (const path of ["/api/ai/skills", `/api/ai/skills/${own.shortId}`]) {
          expect((await router.request(path, { headers })).status).toBe(401);
          expect((await router.request(path)).status).toBe(401);
        }
        expect((await router.request("/api/ai/skills", { headers, method: "POST", body: JSON.stringify(content) })).status).toBe(401);
      }
    } finally {
      for (const spy of spies.reverse()) spy.mockRestore();
      for (const id of created) await aiSkills.admin.delete(id);
      await sql`DELETE FROM ai.app_skills WHERE app_id IN (${ownApp.id},${otherApp.id})`;
      await sql`DELETE FROM auth.service_accounts WHERE id=${accountId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
      setSystemTime();
    }
  });
});
