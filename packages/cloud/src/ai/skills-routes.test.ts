import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import * as registry from "../_internal/registry";
import type { AppRegistryEntry } from "../contracts/registry";
import type { AuthContext, RequestAuthority } from "../server";
import { requireAppAccess } from "../server/middleware/app-access";
import { evaluateAppAccess } from "../services/app-access";
import * as appAccessMetrics from "../services/app-access-metrics";
import { session } from "../services/session";
import { aiProjects } from "./projects";
import type { AiSkill } from "./skills";
import { AiSkillAppForbiddenError, AiSkillRevisionConflictError, aiSkills } from "./skills";
import { __buildAiSkillsRoutesForTest } from "./skills-routes";

const userId = "11111111-1111-4111-8111-111111111111";
const skillId = "22222222-2222-4222-8222-222222222222";
const skillShortId = "sKi234";
const subject = { type: "user" as const, userId };

const user = { id: userId, roles: ["user"] } as AuthContext["Variables"]["user"];
const authority: RequestAuthority = { actor: { kind: "user", user }, accessSubject: subject, credentialKind: "session", scopes: [] };
const authorization = { actor: authority.actor, accessSubject: subject };
const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
  spyOn(session, "getToken").mockReturnValue("skill-user-session");
  c.set("actor", { kind: "user", user });
  c.set("accessSubject", subject);
  c.set("user", user);
  c.set("credentialKind", "session");
  c.set("credentialScopes", []);
  await next();
};
const pass: MiddlewareHandler<AuthContext> = async (_c, next) => next();
const core: AppRegistryEntry = {
  id: "core",
  name: "Core",
  description: "Platform services",
  icon: "ti ti-cloud",
  routes: ["/api/ai/skills"],
  baseUrl: "http://core.invalid",
  access: { kind: "signedIn", publicRoutes: ["/api/ai/skills", "/api/ai/skills/*"] },
};
const apiAuthority = (kind: "resource_bound" | "standalone", scopes: string[]): RequestAuthority => ({
  actor: {
    kind: "service_account",
    serviceAccount: {
      id: "44444444-4444-4444-8444-444444444444",
      name: "Notebook reader",
      kind,
      status: "active",
      delegatedUserId: null,
      appId: kind === "resource_bound" ? "notebooks" : null,
      resourceType: kind === "resource_bound" ? "notebook" : null,
      resourceId: kind === "resource_bound" ? "55555555-5555-4555-8555-555555555555" : null,
      createdBy: null,
      createdAt: "2026-10-01T00:00:00Z",
    },
    delegatedUser: null,
    scopes,
  },
  accessSubject: { type: "service_account", serviceAccountId: "44444444-4444-4444-8444-444444444444" },
  credentialKind: "api_key",
  scopes,
});
const authenticateAuthority =
  (resolved: RequestAuthority): MiddlewareHandler<AuthContext> =>
  async (c, next) => {
    spyOn(session, "getToken").mockReturnValue(resolved.actor.kind === "user" ? "skill-user-session" : null);
    c.set("actor", resolved.actor);
    c.set("accessSubject", resolved.accessSubject);
    c.set("credentialKind", resolved.credentialKind);
    c.set("credentialScopes", resolved.scopes);
    await next();
  };
const broker = (resolved: RequestAuthority) =>
  new Hono<AuthContext>()
    .use("*", authenticateAuthority(resolved))
    .use(
      "*",
      requireAppAccess(core, async (c) => c.text("Core denied", 403)),
    )
    .route("/api/ai/skills", __buildAiSkillsRoutesForTest({ limit: pass, authenticate: pass }));

const skill = (permission: AiSkill["permission"] = "admin"): AiSkill => ({
  source: null,
  id: skillId,
  shortId: skillShortId,
  name: "weekly-status",
  description: "Summarize recent work.",
  instructions: "List wins and blockers.",
  extraFrontmatter: {},
  references: [{ path: "references/style.md", content: "Be concise." }],
  referenceCount: 1,
  permission,
  enabled: true,
  manualOnly: false,
  revision: 3,
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T11:00:00.000Z",
});

beforeEach(() => {
  setSystemTime(new Date("2026-10-22T12:00:00Z"));
  spyOn(session, "getToken").mockReturnValue(null);
  spyOn(session, "appSessionFallback").mockReturnValue(null);
  spyOn(session, "authenticateRequest").mockResolvedValue({
    user,
    data: { userId, sid: "skill-user-session", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z", kind: "web" },
  });
  spyOn(registry, "getApp").mockResolvedValue(core);
  spyOn(appAccessMetrics, "recordAppAccessDenied").mockImplementation(() => {});
});
afterEach(() => {
  mock.restore();
  setSystemTime();
});

describe("AI Skill routes", () => {
  test("Core's public-path exception admits broker reads with the original app-scoped authority", async () => {
    const appSkill = { ...skill("read"), source: { appId: "notebooks", appName: "Notebooks" } };
    const list = spyOn(aiSkills, "list").mockResolvedValue([appSkill]);
    const search = spyOn(aiSkills, "search").mockResolvedValue({ skills: [appSkill], more: false });
    const get = spyOn(aiSkills, "getByShortId").mockResolvedValue(appSkill);
    for (const resolved of [
      apiAuthority("resource_bound", ["read"]),
      apiAuthority("standalone", ["notebooks:read"]),
      { ...authority, credentialKind: "oauth" as const, scopes: ["notebooks:read"] },
    ]) {
      expect(evaluateAppAccess(resolved, core)).toBe(false);
      const routes = broker(resolved);
      for (const suffix of ["", "?name=weekly-status", "?q=weekly", `/${skillShortId}`]) {
        const response = await routes.request(`/api/ai/skills${suffix}`);
        expect(response.status).toBe(200);
      }
      expect(list).toHaveBeenCalledWith(resolved.accessSubject, { authority: resolved });
      expect(list).toHaveBeenCalledWith(resolved.accessSubject, { name: "weekly-status", authority: resolved });
      expect(search).toHaveBeenCalledWith(resolved.accessSubject, "weekly", 30, { authority: resolved });
      expect(get).toHaveBeenCalledWith(skillShortId, resolved.accessSubject, "read", resolved);
    }
    // Broker reads rely on the owning-app/resource decision, not Core's registry entry.
    expect(registry.getApp).not.toHaveBeenCalled();
  });

  test("broker reads preserve a denied Skill result", async () => {
    const list = spyOn(aiSkills, "list").mockResolvedValue([]);
    const get = spyOn(aiSkills, "getByShortId").mockResolvedValue(null);
    const resolved = apiAuthority("resource_bound", ["read"]);
    const routes = broker(resolved);
    expect(await (await routes.request("/api/ai/skills")).json()).toEqual({ skills: [] });
    expect((await routes.request(`/api/ai/skills/${skillShortId}`)).status).toBe(404);
    expect(list).toHaveBeenCalledWith(resolved.accessSubject, { authority: resolved });
    expect(get).toHaveBeenCalledWith(skillShortId, resolved.accessSubject, "read", resolved);
  });

  test("every management route retains Core entry even when its path is exempt at the outer gate", async () => {
    const get = spyOn(aiSkills, "getByShortId").mockResolvedValue(skill());
    const effects = [
      spyOn(aiSkills, "create"),
      spyOn(aiSkills, "update"),
      spyOn(aiSkills, "delete"),
      spyOn(aiSkills, "setEnabled"),
      spyOn(aiSkills, "grantAccess"),
      spyOn(aiSkills, "updateAccess"),
      spyOn(aiSkills, "revokeAccess"),
      spyOn(aiSkills, "linkProject"),
      spyOn(aiSkills, "projectSkills"),
      spyOn(aiSkills, "linkedProjects"),
      spyOn(aiSkills, "listAccess"),
      spyOn(aiProjects, "getByShortId"),
    ];
    const content = { name: "weekly-status", description: "Weekly status.", instructions: "List wins." };
    const requests = [
      { path: "", method: "POST", body: content },
      { path: `/${skillShortId}`, method: "PUT", body: { ...content, expectedRevision: 3 } },
      { path: `/${skillShortId}`, method: "DELETE" },
      { path: `/${skillShortId}/enabled`, method: "PUT", body: { enabled: false } },
      { path: `/${skillShortId}/projects/proj12`, method: "PUT", body: { linked: true } },
      { path: `/${skillShortId}/access`, method: "POST", body: { principal: { type: "authenticated" }, permission: "read" } },
      { path: `/${skillShortId}/access/aCc234`, method: "PATCH", body: { permission: "write" } },
      { path: `/${skillShortId}/access/aCc234`, method: "DELETE" },
      { path: "/project-links/proj12", method: "GET" },
      { path: `/${skillShortId}/projects`, method: "GET" },
      { path: `/${skillShortId}/access`, method: "GET" },
    ];
    for (const resolved of [
      apiAuthority("resource_bound", ["admin", "core:admin"]),
      apiAuthority("standalone", ["notebooks:admin"]),
      { ...authority, credentialKind: "oauth" as const, scopes: ["notebooks:admin"] },
    ]) {
      const routes = broker(resolved);
      for (const { path, method, body } of requests) {
        const response = await routes.request(`/api/ai/skills${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: "app_access_denied", app: "core" });
        expect(response.headers.get("cache-control")).toContain("private, no-store");
      }
    }
    expect(get).not.toHaveBeenCalled();
    for (const effect of effects) expect(effect).not.toHaveBeenCalled();
  });

  test("Core registry loss denies management before effects", async () => {
    const create = spyOn(aiSkills, "create");
    const registered = spyOn(registry, "getApp");
    const request = () =>
      broker(authority).request("/api/ai/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test", description: "Test.", instructions: "Test." }),
      });
    registered.mockResolvedValue(null);
    expect((await request()).status).toBe(403);
    registered.mockRejectedValue(new Error("Registry unavailable"));
    expect((await request()).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  test("an undeclared Core retains step-one legacy management until its declaration is deployed", async () => {
    spyOn(registry, "getApp").mockResolvedValue({ ...core, access: undefined });
    const create = spyOn(aiSkills, "create").mockResolvedValue(skill());
    const response = await broker(authority).request("/api/ai/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test", description: "Test.", instructions: "Test." }),
    });
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("general standalone management remains user-backed even when Core entry allows it", async () => {
    const resolved = apiAuthority("standalone", ["read", "write"]);
    expect(evaluateAppAccess(resolved, core)).toBe(true);
    const create = spyOn(aiSkills, "create");
    const get = spyOn(aiSkills, "getByShortId");
    const remove = spyOn(aiSkills, "delete");
    for (const access of [undefined, core.access]) {
      spyOn(registry, "getApp").mockResolvedValue({ ...core, access });
      const routes = broker(resolved);
      const response = await routes.request("/api/ai/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "weekly-status", description: "Weekly status.", instructions: "List wins." }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("user-backed") });
      expect((await routes.request(`/api/ai/skills/${skillShortId}`, { method: "DELETE" })).status).toBe(403);
    }
    expect(create).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test("project links check both managers and return public IDs from paginated search", async () => {
    const projectId = "33333333-3333-4333-8333-333333333333";
    const project = spyOn(aiProjects, "getByShortId").mockResolvedValue({
      id: projectId,
      shortId: "proj12",
      name: "Finance",
      permission: "admin",
      description: "",
      icon: "",
      instructions: "",
      defaultModelProfileId: null,
      revision: 1,
      createdAt: "",
      updatedAt: "",
    });
    spyOn(aiSkills, "getByShortId").mockResolvedValue(skill());
    const list = spyOn(aiSkills, "projectSkills").mockResolvedValue({ items: [skill()], page: 2, hasNext: true });
    const link = spyOn(aiSkills, "linkProject").mockResolvedValue(true);
    const routes = __buildAiSkillsRoutesForTest({ limit: pass, authenticate });
    const response = await routes.request("/project-links/proj12?q=finance&available=true&page=2");
    expect(response.status).toBe(200);
    expect(project).toHaveBeenCalledWith("proj12", authorization, "admin");
    expect(list).toHaveBeenCalledWith(projectId, authorization, { query: "finance", available: true, page: 2, authority });
    expect(await response.json()).toMatchObject({ items: [{ id: skillShortId }], page: 2, hasNext: true });
    const request = () =>
      routes.request(`/${skillShortId}/projects/proj12`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ linked: true }),
      });
    expect((await request()).status).toBe(200);
    expect(link).toHaveBeenCalledWith(skillId, projectId, true, authorization, authority);
    project.mockResolvedValue(null);
    link.mockClear();
    expect((await request()).status).toBe(404);
    expect(link).not.toHaveBeenCalled();
    expect((await routes.request("/project-links/proj12?page=0")).status).toBe(400);
  });

  test("slash-menu search includes manual-only Skills and rejects oversized queries", async () => {
    const search = spyOn(aiSkills, "search").mockResolvedValue({ skills: [{ ...skill(), manualOnly: true }], more: false });
    const routes = __buildAiSkillsRoutesForTest({ limit: pass, authenticate });
    const response = await routes.request("/?q=reciepts");
    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledWith(authorization, "reciepts", 30, { authority });
    expect((await response.json()).skills[0]).toMatchObject({ id: skillShortId, manualOnly: true });
    expect((await routes.request("/?q=" + "x".repeat(201))).status).toBe(400);
  });

  test("exact name lookup lists disabled Skills and rejects combining name with search", async () => {
    const list = spyOn(aiSkills, "list").mockResolvedValue([{ ...skill(), enabled: false }]);
    const search = spyOn(aiSkills, "search");
    const routes = __buildAiSkillsRoutesForTest({ limit: pass, authenticate });
    const response = await routes.request("/?name=%20weekly-status%20");
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(authorization, { name: "weekly-status", authority });
    expect((await response.json()).skills[0]).toMatchObject({ id: skillShortId, enabled: false });
    list.mockClear();
    expect((await routes.request("/?q=a&name=b")).status).toBe(400);
    expect((await routes.request("/?name=" + "x".repeat(65))).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  test("removed template route stays absent", async () => {
    const routes = __buildAiSkillsRoutesForTest({ limit: pass, authenticate });
    expect((await routes.request("/templates/cloud-mail")).status).toBe(404);
  });
  test("readable app skills explain administrator overrides when a mutation is refused", async () => {
    spyOn(aiSkills, "getByShortId").mockRejectedValue(new AiSkillAppForbiddenError("Mail"));
    const routes = __buildAiSkillsRoutesForTest({ limit: pass, authenticate });
    const response = await routes.request(`/${skillShortId}`, { method: "DELETE" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("Mail") });
  });

  test("updates consciously merged content only to the selected Skill at its reviewed revision", async () => {
    const installed = { ...skill("write"), name: "cloud-mail" };
    spyOn(aiSkills, "getByShortId").mockResolvedValue(installed);
    const update = spyOn(aiSkills, "update").mockResolvedValue({ ...installed, revision: 4 });
    const access = spyOn(aiSkills, "grantAccess");
    const remove = spyOn(aiSkills, "delete");
    const enabled = spyOn(aiSkills, "setEnabled");
    const routes = __buildAiSkillsRoutesForTest({ limit: pass, authenticate });
    const template = { name: installed.name, description: installed.description, instructions: installed.instructions };
    const { skill: current } = await (await routes.request(`/${skillShortId}`)).json();
    const proposal = {
      ...template,
      expectedRevision: current.revision,
      instructions: `${template.instructions}\n\nPreserve our custom policy.`,
      extraFrontmatter: { metadata: { owner: "mail-team" } },
      references: [...[], ...current.references],
    };
    const request = () =>
      routes.request(`/${skillShortId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proposal),
      });
    expect((await request()).status).toBe(200);
    const content = proposal;
    expect(update).toHaveBeenCalledWith(skillId, authorization, content, authority);
    expect(access).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(enabled).not.toHaveBeenCalled();
    update.mockRejectedValue(new AiSkillRevisionConflictError());
    expect((await request()).status).toBe(409);
  });

  test("creates a permission-owned skill and projects only the public id", async () => {
    spyOn(aiSkills, "create").mockResolvedValue(skill());
    const routes = __buildAiSkillsRoutesForTest({ limit: pass, authenticate });
    const response = await routes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "weekly-status",
        description: "Summarize recent work.",
        instructions: "List wins and blockers.",
        references: [{ path: "references/style.md", content: "Be concise." }],
      }),
    });

    expect(response.status).toBe(201);
    expect(aiSkills.create).toHaveBeenCalledWith(
      {
        subject: authorization,
        name: "weekly-status",
        description: "Summarize recent work.",
        instructions: "List wins and blockers.",
        extraFrontmatter: {},
        references: [{ path: "references/style.md", content: "Be concise." }],
      },
      authority,
    );
    expect((await response.json()).skill).toMatchObject({ id: skillShortId, shortId: skillShortId, permission: "admin" });
  });

  test("requires write permission and the expected revision for a full update", async () => {
    spyOn(aiSkills, "getByShortId").mockResolvedValue(skill("write"));
    spyOn(aiSkills, "update").mockResolvedValue({ ...skill("write"), revision: 4 });
    const routes = __buildAiSkillsRoutesForTest({ limit: pass, authenticate });
    const update = {
      expectedRevision: 3,
      name: "weekly-status",
      description: "Summarize recent work.",
      instructions: "List wins, blockers, and next steps.",
      extraFrontmatter: {},
      references: [],
    };
    const response = await routes.request(`/${skillShortId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });

    expect(response.status).toBe(200);
    expect(aiSkills.getByShortId).toHaveBeenCalledWith(skillShortId, authorization, "write", authority);
    expect(aiSkills.update).toHaveBeenCalledWith(skillId, authorization, update, authority);
  });

  test("keeps access management and deletion behind admin permission", async () => {
    spyOn(aiSkills, "getByShortId").mockResolvedValue(null);
    const routes = __buildAiSkillsRoutesForTest({ limit: pass, authenticate });
    expect((await routes.request(`/${skillShortId}/access`)).status).toBe(404);
    expect((await routes.request(`/${skillShortId}`, { method: "DELETE" })).status).toBe(404);
    expect(aiSkills.getByShortId).toHaveBeenCalledWith(skillShortId, authorization, "admin", authority);
  });

  test("passes request authority through grant changes and deletion", async () => {
    spyOn(aiSkills, "getByShortId").mockResolvedValue(skill());
    const grant = {
      id: "aCc234",
      shortId: "aCc234",
      principal: { type: "authenticated" as const },
      permission: "read" as const,
      createdAt: "2026-10-01T00:00:00Z",
    };
    const add = spyOn(aiSkills, "grantAccess").mockResolvedValue(grant);
    const update = spyOn(aiSkills, "updateAccess").mockResolvedValue(true);
    const revoke = spyOn(aiSkills, "revokeAccess").mockResolvedValue(true);
    const remove = spyOn(aiSkills, "delete").mockResolvedValue(true);
    const routes = __buildAiSkillsRoutesForTest({ limit: pass, authenticate });
    const input = { principal: grant.principal, permission: grant.permission };
    expect(
      (
        await routes.request(`/${skillShortId}/access`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(201);
    expect(add).toHaveBeenCalledWith(skillId, authorization, input, undefined, authority);
    expect(
      (
        await routes.request(`/${skillShortId}/access/${grant.shortId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ permission: "write" }),
        })
      ).status,
    ).toBe(200);
    expect(update).toHaveBeenCalledWith(skillId, grant.shortId, authorization, "write", undefined, authority);
    expect((await routes.request(`/${skillShortId}/access/${grant.shortId}`, { method: "DELETE" })).status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(skillId, grant.shortId, authorization, undefined, authority);
    expect((await routes.request(`/${skillShortId}`, { method: "DELETE" })).status).toBe(200);
    expect(remove).toHaveBeenCalledWith(skillId, authorization, authority);
  });

  test("updates only the current user's Skill preference", async () => {
    spyOn(aiSkills, "getByShortId").mockResolvedValue(skill("read"));
    spyOn(aiSkills, "setEnabled").mockResolvedValue(false);
    const routes = __buildAiSkillsRoutesForTest({ limit: pass, authenticate });
    const response = await routes.request(`/${skillShortId}/enabled`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
    expect(aiSkills.setEnabled).toHaveBeenCalledWith(skillId, authorization, false, authority);
  });

  test("rejects anonymous Skill reads and creation before invoking the service", async () => {
    const list = spyOn(aiSkills, "list");
    const get = spyOn(aiSkills, "getByShortId");
    const routes = __buildAiSkillsRoutesForTest({ limit: pass });
    for (const path of ["/", "/?q=test", "/?name=test", `/${skillShortId}`, "/templates/skill-creator"]) {
      expect((await routes.request(path)).status).toBe(401);
    }
    expect(
      (
        await routes.request("/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "test", description: "Test.", instructions: "Test." }),
        })
      ).status,
    ).toBe(401);
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  test("rejects public Skill grants before invoking the service", async () => {
    const grant = spyOn(aiSkills, "grantAccess");
    const routes = __buildAiSkillsRoutesForTest({ limit: pass, authenticate });
    expect(
      (
        await routes.request(`/${skillShortId}/access`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ principal: { type: "public" }, permission: "read" }),
        })
      ).status,
    ).toBe(400);
    expect(grant).not.toHaveBeenCalled();
  });
});
