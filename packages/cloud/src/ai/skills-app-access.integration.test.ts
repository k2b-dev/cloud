import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "bun";
import { Hono, type MiddlewareHandler } from "hono";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import * as registry from "../_internal/registry";
import type { AppRegistryEntry } from "../contracts/registry";
import type { AuthContext, RequestAuthority } from "../server";
import { requireAppAccess } from "../server/middleware/app-access";
import * as appAccess from "../services/app-access";
import * as appAccessMetrics from "../services/app-access-metrics";
import { buildProjectedUser } from "../services/session/user";
import { migrateCloudAi } from "./migrate";
import { aiProjects } from "./projects";
import { AiResourceCredentialError } from "./projects-authorization";
import { AiSkillAppForbiddenError, aiSkills } from "./skills";
import { __buildAiSkillsRoutesForTest } from "./skills-routes";

const pass: MiddlewareHandler<AuthContext> = async (_c, next) => next();

databaseSuite()("Skill broker routes (integration)", () => {
  beforeAll(async () => {
    setSystemTime(new Date("2026-10-22T12:00:00Z"));
    await migrateCloudAi();
  });

  afterAll(() => setSystemTime());

  test("scoped reads require both the Skill grant and its owning app; Core mutations stay closed", async () => {
    const suffix = crypto.randomUUID();
    const ownApp: AppRegistryEntry = {
      id: `broker-own-${suffix}`,
      name: "Notebook fixture",
      description: "Skill broker fixture",
      icon: "ti ti-notebook",
      routes: [],
      baseUrl: "http://notebooks.invalid",
      access: { kind: "signedIn" },
    };
    const otherApp: AppRegistryEntry = {
      ...ownApp,
      access: { kind: "roles", roles: ["admin"] },
      id: `broker-other-${suffix}`,
      name: "Other app fixture",
    };
    const core: AppRegistryEntry = {
      ...ownApp,
      id: "core",
      name: "Core",
      access: { kind: "roles", roles: ["admin"], publicRoutes: ["/api/ai/skills", "/api/ai/skills/*"] },
    };
    const [owner] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`broker-owner-${suffix}`}, 'local', 'user', 'Broker fixture owner') RETURNING id`;
    const ownerSubject = { type: "user" as const, userId: owner!.id };
    const ownerAuthority: RequestAuthority = {
      actor: { kind: "user", user: buildProjectedUser({ id: owner!.id, provider: "local", profile: "user", effective_admin: false }) },
      accessSubject: ownerSubject,
      credentialKind: "session",
      scopes: [],
    };
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts(name, kind)
      VALUES (${`broker-reader-${suffix}`}, 'standalone') RETURNING id`;
    const resolved: RequestAuthority = {
      actor: {
        kind: "service_account",
        serviceAccount: {
          id: account!.id,
          name: "Broker fixture reader",
          kind: "standalone",
          status: "active",
          delegatedUserId: null,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdBy: null,
          createdAt: "2026-10-01T00:00:00Z",
        },
        delegatedUser: null,
        scopes: ["read"],
      },
      accessSubject: { type: "service_account", serviceAccountId: account!.id },
      credentialKind: "api_key",
      scopes: ["read"],
    };
    const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
      c.set("actor", resolved.actor);
      c.set("accessSubject", resolved.accessSubject);
      c.set("credentialKind", resolved.credentialKind);
      c.set("credentialScopes", resolved.scopes);
      await next();
    };
    const routes = new Hono<AuthContext>()
      .use("*", authenticate)
      .use(
        "*",
        requireAppAccess(core, async (c) => c.text("Core denied", 403)),
      )
      .route("/api/ai/skills", __buildAiSkillsRoutesForTest({ limit: pass, authenticate: pass }));
    const registered = spyOn(registry, "listApps").mockResolvedValue([core, ownApp, otherApp]);
    const registeredCore = spyOn(registry, "getApp").mockResolvedValue(core);
    const audience = spyOn(appAccess, "usableAppIds");
    const metrics = spyOn(appAccessMetrics, "recordAppAccessDenied").mockImplementation(() => {});
    const created: string[] = [];
    let projectId: string | null = null;
    const deniedCreateName = `broker-create-${suffix}`;
    try {
      const installed = [];
      for (const [label, app] of [
        ["own", ownApp],
        ["other", otherApp],
        ["ungranted", ownApp],
      ] as const) {
        const skill = await aiSkills.create(
          {
            subject: ownerAuthority,
            name: `broker-${label}-${suffix}`,
            description: "Broker fixture.",
            instructions: "Original instructions.",
          },
          ownerAuthority,
        );
        created.push(skill.id);
        installed.push(skill);
        await sql`INSERT INTO ai.app_skills(key, app_id, app_name, name, skill_id, available)
          VALUES (${`app:${app.id}/${skill.name}`}, ${app.id}, ${app.name}, ${skill.name}, ${skill.id}::uuid, true)`;
        if (label !== "ungranted") {
          await aiSkills.admin.grantAccess(skill.id, {
            principal: { type: "service_account", serviceAccountId: account!.id },
            permission: "admin",
          });
        }
      }
      const [own, other, ungranted] = installed;
      audience.mockClear();
      expect(appAccess.evaluateAppAccess(resolved, core)).toBe(false);
      for (const query of ["", `?name=${own!.name}`, `?q=${own!.name}`]) {
        const response = await routes.request(`/api/ai/skills${query}`);
        expect(response.status).toBe(200);
        expect((await response.json()).skills.map((entry: { id: string }) => entry.id)).toEqual([own!.shortId]);
      }
      const allowed = await routes.request(`/api/ai/skills/${own!.shortId}`);
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toMatchObject({ skill: { id: own!.shortId, source: { appId: ownApp.id }, permission: "read" } });
      for (const target of [other!, ungranted!]) {
        const response = await routes.request(`/api/ai/skills/${target.shortId}`);
        expect(response.status).toBe(404);
      }
      for (const [received] of audience.mock.calls) expect(received).toEqual(resolved);
      expect(audience.mock.calls.length).toBeGreaterThan(0);
      expect(registeredCore).not.toHaveBeenCalled();

      // An explicit admin grant on the Skill cannot replace Core's entry check.
      for (const [path, method, body] of [
        ["", "POST", { name: deniedCreateName, description: "Denied.", instructions: "Denied." }],
        [`/${own!.shortId}`, "PUT", { ...own!, expectedRevision: own!.revision, instructions: "Changed." }],
        [`/${own!.shortId}/enabled`, "PUT", { enabled: false }],
        [`/${own!.shortId}`, "DELETE", undefined],
      ] as const) {
        const response = await routes.request(`/api/ai/skills${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: "app_access_denied", app: "core" });
      }
      const [unchanged] = await sql`SELECT revision, instructions FROM ai.skills WHERE id=${own!.id}::uuid`;
      expect(unchanged?.revision).toBe(own!.revision);
      expect(unchanged?.instructions).toBe("Original instructions.");
      expect(await sql`SELECT id FROM ai.skills WHERE name=${deniedCreateName}`).toHaveLength(0);

      // A broker-only credential must not expose user Skills or Projects, even
      // with admin grants. An app-prefixed write/admin scope still only reads.
      const privateSkill = await aiSkills.create({
        subject: ownerAuthority,
        name: `broker-private-${suffix}`,
        description: "Private fixture.",
        instructions: "Private instructions.",
      });
      created.push(privateSkill.id);
      const project = await aiProjects.create({ subject: ownerAuthority, name: `Broker project ${suffix}` });
      projectId = project.id;
      const principal = { type: "service_account" as const, serviceAccountId: account!.id };
      await aiSkills.admin.grantAccess(privateSkill.id, { principal, permission: "admin" });
      await aiProjects.admin.grantAccess(project.id, { principal, permission: "admin" });
      expect(await aiSkills.linkProject(privateSkill.id, project.id, true, ownerAuthority)).toBe(true);
      if (resolved.actor.kind !== "service_account") throw new Error("Missing machine fixture");
      const machine = resolved.actor;
      for (const [kind, scopes] of [
        ["standalone", [`${ownApp.id}:read`]],
        ["standalone", [`${ownApp.id}:write`]],
        ["standalone", [`${ownApp.id}:admin`]],
        ["agent", [`${ownApp.id}:read`]],
        ["resource_bound", ["read"]],
        ["resource_bound", ["admin"]],
      ] as const) {
        resolved.actor = {
          ...machine,
          scopes: [...scopes],
          serviceAccount: {
            ...machine.serviceAccount,
            kind,
            appId: kind === "resource_bound" ? ownApp.id : null,
            resourceType: kind === "resource_bound" ? "notebook" : null,
            resourceId: kind === "resource_bound" ? suffix : null,
          },
        };
        resolved.scopes = [...scopes];
        // Let both apps admit machines: credential scope/binding must still
        // exclude the other app even though it also grants this account admin.
        registered.mockResolvedValue([core, ownApp, { ...otherApp, access: { kind: "signedIn" } }]);
        for (const query of ["", `?name=${own!.name}`, `?q=${own!.name}`]) {
          const response = await routes.request(`/api/ai/skills${query}`);
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ skills: [expect.objectContaining({ id: own!.shortId, permission: "read" })] });
        }
        expect(await (await routes.request(`/api/ai/skills/${own!.shortId}`)).json()).toMatchObject({
          skill: { id: own!.shortId, permission: "read" },
        });
        for (const target of [other!, ungranted!, privateSkill]) {
          expect((await routes.request(`/api/ai/skills/${target.shortId}`)).status).toBe(404);
        }
        expect(await aiProjects.get(project.id, resolved)).toBeNull();
        expect(await aiProjects.list(resolved)).toEqual([]);
        await expect(aiSkills.get(own!.id, resolved, "write", resolved)).rejects.toThrow(AiSkillAppForbiddenError);
        await expect(aiSkills.get(own!.id, resolved, "admin", resolved)).rejects.toThrow(AiSkillAppForbiddenError);
        await expect(
          aiSkills.update(own!.id, resolved, { ...own!, expectedRevision: own!.revision, instructions: "Changed." }, resolved),
        ).rejects.toThrow(AiSkillAppForbiddenError);
        await expect(aiSkills.delete(own!.id, resolved, resolved)).rejects.toThrow(AiSkillAppForbiddenError);
        await expect(
          aiSkills.grantAccess(own!.id, resolved, { principal: { type: "authenticated" }, permission: "read" }, undefined, resolved),
        ).rejects.toThrow(AiSkillAppForbiddenError);
        await expect(
          aiSkills.create({ subject: resolved, name: deniedCreateName, description: "Denied.", instructions: "Denied." }, resolved),
        ).rejects.toThrow(AiResourceCredentialError);
        expect(await aiSkills.get(own!.id, resolved)).toBeNull(); // Missing broker authority.
        const mismatched = { ...resolved, accessSubject: { type: "service_account" as const, serviceAccountId: crypto.randomUUID() } };
        expect(await aiSkills.get(own!.id, mismatched, "read", resolved)).toBeNull();

        // Legacy app entries also retain the binding and scope checks.
        registered.mockResolvedValue([core, { ...ownApp, access: undefined }, { ...otherApp, access: undefined }]);
        expect(await aiSkills.get(own!.id, resolved, "read", resolved)).toMatchObject({ permission: "read" });
        expect(await aiSkills.get(other!.id, resolved, "read", resolved)).toBeNull();
        // Request authority may be narrower than the actor (for example OAuth).
        expect(await aiSkills.get(own!.id, resolved, "read", { ...resolved, scopes: [`${otherApp.id}:read`] })).toBeNull();
        const narrowerActor = { ...resolved, actor: { ...resolved.actor, scopes: [`${otherApp.id}:read`] } };
        expect(await aiSkills.get(own!.id, narrowerActor, "read", resolved)).toBeNull();
        for (const deniedScopes of [[], ["ai:inference"], [`${otherApp.id}:read`]]) {
          const denied = { ...resolved, actor: { ...resolved.actor, scopes: deniedScopes }, scopes: deniedScopes };
          expect(await aiSkills.get(own!.id, denied, "read", denied)).toBeNull();
        }
      }
      const [afterBroker] = await sql`SELECT revision, instructions FROM ai.skills WHERE id=${own!.id}::uuid`;
      expect(afterBroker?.revision).toBe(own!.revision);
      expect(afterBroker?.instructions).toBe("Original instructions.");

      registered.mockResolvedValue([core, { ...ownApp, access: { kind: "roles", roles: ["admin"] } }, otherApp]);
      expect((await routes.request(`/api/ai/skills/${own!.shortId}`)).status).toBe(404);
      expect(await (await routes.request("/api/ai/skills")).json()).toEqual({ skills: [] });
      registered.mockRejectedValue(new Error("Registry unavailable"));
      expect((await routes.request(`/api/ai/skills/${own!.shortId}`)).status).toBe(404);
      expect(await (await routes.request("/api/ai/skills")).json()).toEqual({ skills: [] });
    } finally {
      audience.mockRestore();
      metrics.mockRestore();
      registered.mockRestore();
      registeredCore.mockRestore();
      for (const id of created) await aiSkills.admin.delete(id);
      if (projectId) await aiProjects.admin.delete(projectId);
      await sql`DELETE FROM ai.app_skills WHERE app_id IN (${ownApp.id}, ${otherApp.id})`;
      await sql`DELETE FROM auth.service_accounts WHERE id=${account!.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${owner!.id}::uuid`;
    }
  });
});
