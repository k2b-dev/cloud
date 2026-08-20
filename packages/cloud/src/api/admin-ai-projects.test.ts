import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { AiProjectLastAdminError, aiProjects } from "../ai/projects";
import type { AuthContext } from "../server";
import { createAdminAiProjectsRoutes } from "./admin-ai-projects";

const pass: MiddlewareHandler<AuthContext> = async (_c, next) => next();
const projectId = "22222222-2222-4222-8222-222222222222";
const projectShortId = "pRk234";
const project = {
  id: projectId,
  shortId: projectShortId,
  appId: "assistant",
  name: "Support",
  description: "Shared support context",
  icon: "ti ti-folders",
  accessCount: 0,
  adminCount: 0,
  createdAt: "2026-08-17T10:00:00.000Z",
  updatedAt: "2026-08-17T10:00:00.000Z",
};

afterEach(() => mock.restore());

describe("admin AI Project routes", () => {
  test("requires a platform administrator by default", async () => {
    const response = await createAdminAiProjectsRoutes().request("/");

    expect(response.status).toBe(401);
  });

  test("lists platform-wide Projects and unmanaged summary without exposing internal ids", async () => {
    spyOn(aiProjects.admin, "list").mockResolvedValue({ items: [project], total: 1, page: 1, perPage: 25 });
    spyOn(aiProjects.admin, "summary").mockResolvedValue({ total: 1, unmanaged: 1, totalAccess: 0 });
    const routes = createAdminAiProjectsRoutes(pass);

    const response = await routes.request("/?search=support&page=1&perPage=25");

    expect(response.status).toBe(200);
    expect(aiProjects.admin.list).toHaveBeenCalledWith({ search: "support", page: 1, perPage: 25 });
    expect(await response.json()).toMatchObject({
      items: [{ id: projectShortId, shortId: projectShortId, adminCount: 0 }],
      summary: { unmanaged: 1 },
    });
  });

  test("grants recovery access to a Project with no current admin", async () => {
    const access = {
      id: "aCc234",
      shortId: "aCc234",
      principal: { type: "user" as const, userId: "11111111-1111-4111-8111-111111111111" },
      permission: "admin" as const,
      createdAt: "2026-08-17T10:00:00.000Z",
    };
    spyOn(aiProjects.admin, "getByShortId").mockResolvedValue(project);
    spyOn(aiProjects.admin, "grantAccess").mockResolvedValue(access);
    const routes = createAdminAiProjectsRoutes(pass);

    const response = await routes.request(`/${projectShortId}/access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal: access.principal, permission: "admin" }),
    });

    expect(response.status).toBe(201);
    expect(aiProjects.admin.grantAccess).toHaveBeenCalledWith(projectId, {
      principal: access.principal,
      permission: "admin",
    });
    expect(await response.json()).toEqual({ access });
  });

  test("reports the shared last-admin invariant as a conflict", async () => {
    spyOn(aiProjects.admin, "getByShortId").mockResolvedValue({ ...project, accessCount: 1, adminCount: 1 });
    spyOn(aiProjects.admin, "revokeAccess").mockRejectedValue(new AiProjectLastAdminError());
    const routes = createAdminAiProjectsRoutes(pass);

    const response = await routes.request(`/${projectShortId}/access/aCc234`, { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ message: "A Project must keep at least one admin access entry." });
  });

  test("deletes a Project through the platform recovery surface", async () => {
    spyOn(aiProjects.admin, "getByShortId").mockResolvedValue(project);
    spyOn(aiProjects.admin, "delete").mockResolvedValue(true);
    const routes = createAdminAiProjectsRoutes(pass);

    const response = await routes.request(`/${projectShortId}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(aiProjects.admin.delete).toHaveBeenCalledWith(projectId);
    expect(await response.json()).toEqual({ deleted: true });
  });
});
