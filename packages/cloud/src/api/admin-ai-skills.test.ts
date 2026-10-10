import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { aiAppSkills } from "../ai/app-skill-store";
import { AiSkillInputError, AiSkillRevisionConflictError, aiSkills } from "../ai/skills";
import type { AuthContext } from "../server";
import { createAdminAiSkillsRoutes } from "./admin-ai-skills";

const pass: MiddlewareHandler<AuthContext> = async (_c, next) => next();
const skillId = "33333333-3333-4333-8333-333333333333";
const skillShortId = "sKl234";
const skill = {
  id: skillId,
  shortId: skillShortId,
  name: "weekly-status",
  description: "Create weekly status updates.",
  revision: 1,
  source: null,
  referenceCount: 0,
  accessCount: 0,
  adminCount: 0,
  createdAt: "2026-08-21T10:00:00.000Z",
  updatedAt: "2026-08-21T10:00:00.000Z",
};

afterEach(() => mock.restore());

describe("admin AI Skill routes", () => {
  test("rejects public grants on the platform-admin recovery route", async () => {
    const grant = spyOn(aiSkills.admin, "grantAccess");
    const routes = createAdminAiSkillsRoutes(pass);
    const response = await routes.request("/AbC234/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal: { type: "public" }, permission: "admin" }),
    });
    expect(response.status).toBe(400);
    expect(grant).not.toHaveBeenCalled();
  });

  test("requires a platform administrator by default", async () => {
    const response = await createAdminAiSkillsRoutes().request("/");

    expect(response.status).toBe(401);
  });

  test("lists platform-wide Skills and orphan summary without exposing internal ids", async () => {
    spyOn(aiSkills.admin, "list").mockResolvedValue({ items: [skill], total: 1, page: 1, perPage: 25 });
    spyOn(aiAppSkills, "appSkillIssues").mockResolvedValue([
      { appId: "mail", appName: "Mail", name: "cloud-mail", state: "deleted", available: true },
    ]);
    spyOn(aiSkills.admin, "summary").mockResolvedValue({ total: 1, unmanaged: 1, totalAccess: 0 });
    const routes = createAdminAiSkillsRoutes(pass);

    const response = await routes.request("/?search=weekly&page=1&perPage=25");

    expect(response.status).toBe(200);
    expect(aiSkills.admin.list).toHaveBeenCalledWith({ search: "weekly", page: 1, perPage: 25 });
    expect(await response.json()).toMatchObject({
      items: [{ id: skillShortId, shortId: skillShortId, adminCount: 0 }],
      summary: { unmanaged: 1 },
    });
  });

  test("grants recovery access to a Skill with no current admin", async () => {
    const access = {
      id: "aCc234",
      shortId: "aCc234",
      principal: { type: "user" as const, userId: "11111111-1111-4111-8111-111111111111" },
      permission: "admin" as const,
      createdAt: "2026-08-21T10:00:00.000Z",
    };
    spyOn(aiSkills.admin, "getByShortId").mockResolvedValue(skill);
    spyOn(aiSkills.admin, "grantAccess").mockResolvedValue(access);
    const routes = createAdminAiSkillsRoutes(pass);

    const response = await routes.request(`/${skillShortId}/access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal: access.principal, permission: "admin" }),
    });

    expect(response.status).toBe(201);
    expect(aiSkills.admin.grantAccess).toHaveBeenCalledWith(skillId, {
      principal: access.principal,
      permission: "admin",
    });
  });

  test("deletes a Skill", async () => {
    spyOn(aiSkills.admin, "getByShortId").mockResolvedValue(skill);
    spyOn(aiSkills.admin, "delete").mockResolvedValue(true);
    const routes = createAdminAiSkillsRoutes(pass);

    const response = await routes.request(`/${skillShortId}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(aiSkills.admin.delete).toHaveBeenCalledWith(skillId);
    expect(await response.json()).toEqual({ deleted: true });
  });
  test("requires admin access and explicit confirmation for app Skill resets", async () => {
    const apply = spyOn(aiAppSkills, "reset").mockResolvedValue(true);
    const input = { expectedRevision: 3, expectedAppVersion: "b".repeat(64), confirmed: true };
    const request = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) };
    expect((await createAdminAiSkillsRoutes().request(`/${skillShortId}/reset`, request)).status).toBe(401);
    const denied: MiddlewareHandler<AuthContext> = async (c) => c.json({ message: "Forbidden" }, 403);
    expect((await createAdminAiSkillsRoutes(denied).request(`/${skillShortId}/reset`, request)).status).toBe(403);
    expect(apply).not.toHaveBeenCalled();
    spyOn(aiSkills.admin, "getByShortId").mockResolvedValue(skill);
    const routes = createAdminAiSkillsRoutes(pass);
    expect(
      (await routes.request(`/${skillShortId}/reset`, { ...request, body: JSON.stringify({ ...input, confirmed: false }) })).status,
    ).toBe(400);
    expect(apply).not.toHaveBeenCalled();
    expect((await routes.request(`/${skillShortId}/reset`, request)).status).toBe(200);
    expect(apply).toHaveBeenCalledWith(skillId, input.expectedRevision, input.expectedAppVersion);
    const { expectedAppVersion: _reviewed, ...unreviewed } = input;
    expect((await routes.request(`/${skillShortId}/reset`, { ...request, body: JSON.stringify(unreviewed) })).status).toBe(400);
    apply.mockRejectedValue(new AiSkillRevisionConflictError());
    const stale = await routes.request(`/${skillShortId}/reset`, request);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ message: new AiSkillRevisionConflictError().message });
  });
  test("returns serialized current and app content for the diff", async () => {
    spyOn(aiSkills.admin, "getByShortId").mockResolvedValue(skill);
    const version = {
      current: { markdown: "Current", references: [] },
      app: { markdown: "App", references: [] },
      appVersion: "e".repeat(64),
      status: "update_available" as const,
    };
    spyOn(aiAppSkills, "appVersion").mockResolvedValue(version);
    const response = await createAdminAiSkillsRoutes(pass).request(`/${skillShortId}/app-version`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(version);
    expect(aiAppSkills.appVersion).toHaveBeenCalledWith(skillId);
  });
  test.each(["restore", "adopt"] as const)("%s requires confirmation, targets the exact app/name and reports conflicts", async (action) => {
    const restore = spyOn(aiAppSkills, action).mockResolvedValue(true);
    const request = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmed: true }) };
    const path = `/apps/inventory/skills/inventory-counting/${action}`;
    expect((await createAdminAiSkillsRoutes().request(path, request)).status).toBe(401);
    const routes = createAdminAiSkillsRoutes(pass);
    expect((await routes.request(path, { ...request, body: JSON.stringify({ confirmed: false }) })).status).toBe(400);
    expect(restore).not.toHaveBeenCalled();
    expect((await routes.request(path, request)).status).toBe(200);
    expect(restore).toHaveBeenCalledWith("inventory", "inventory-counting");
    restore.mockRejectedValue(new AiSkillRevisionConflictError("A Skill with this name already exists."));
    expect((await routes.request(path, request)).status).toBe(409);
    restore.mockRejectedValue(new AiSkillInputError("No app source is available for this Skill."));
    expect((await routes.request(path, request)).status).toBe(400);
  });
  test("reset reports missing app source and removed template endpoints stay absent", async () => {
    spyOn(aiSkills.admin, "getByShortId").mockResolvedValue(skill);
    spyOn(aiAppSkills, "reset").mockRejectedValue(new AiSkillInputError("No app source is available for this Skill."));
    const routes = createAdminAiSkillsRoutes(pass);
    const response = await routes.request(`/${skillShortId}/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, expectedAppVersion: "c".repeat(64), confirmed: true }),
    });
    expect(response.status).toBe(400);
    expect((await routes.request("/templates")).status).toBe(404);
    expect((await routes.request(`/${skillShortId}/template`, { method: "POST" })).status).toBe(404);
  });
});
