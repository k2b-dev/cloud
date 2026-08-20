import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { aiSkills } from "../ai/skills";
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
  referenceCount: 0,
  accessCount: 0,
  adminCount: 0,
  createdAt: "2026-08-21T10:00:00.000Z",
  updatedAt: "2026-08-21T10:00:00.000Z",
};

afterEach(() => mock.restore());

describe("admin AI Skill routes", () => {
  test("requires a platform administrator by default", async () => {
    const response = await createAdminAiSkillsRoutes().request("/");

    expect(response.status).toBe(401);
  });

  test("lists platform-wide Skills and orphan summary without exposing internal ids", async () => {
    spyOn(aiSkills.admin, "list").mockResolvedValue({ items: [skill], total: 1, page: 1, perPage: 25 });
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
});
