import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AuthContext } from "../server";
import type { AiSkill } from "./skills";
import { AiSkillRevisionConflictError, aiSkills } from "./skills";
import { __buildAiSkillsRoutesForTest } from "./skills-routes";

const userId = "11111111-1111-4111-8111-111111111111";
const skillId = "22222222-2222-4222-8222-222222222222";
const skillShortId = "sKi234";
const subject = { type: "user" as const, userId };

const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
  const user = { id: userId, roles: ["user"] } as AuthContext["Variables"]["user"];
  c.set("actor", { kind: "user", user });
  c.set("accessSubject", subject);
  c.set("user", user);
  await next();
};
const pass: MiddlewareHandler<AuthContext> = async (_c, next) => next();

const skill = (permission: AiSkill["permission"] = "admin"): AiSkill => ({
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
  revision: 3,
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T11:00:00.000Z",
});

afterEach(() => mock.restore());

describe("AI Skill routes", () => {
  test("previews a built-in template without reading or overwriting an installed Skill", async () => {
    const read = spyOn(aiSkills, "getByShortId");
    const update = spyOn(aiSkills, "update");
    const seed = spyOn(aiSkills, "seedOnce");
    const routes = __buildAiSkillsRoutesForTest({ limit: pass, authenticate });
    const response = await routes.request("/templates/cloud-mail");
    expect(response.status).toBe(200);
    const { template } = await response.json();
    expect(template.name).toBe("cloud-mail");
    expect(template.instructions).toContain("Cloud Mail");
    expect(template).not.toHaveProperty("key");
    expect(read).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
    expect((await routes.request("/templates/not-a-builtin")).status).toBe(404);
    const anonymous = __buildAiSkillsRoutesForTest({ limit: pass, authenticate: pass });
    expect((await anonymous.request("/templates/cloud-mail")).status).toBe(403);
  });

  test("applies a consciously merged template only to the selected Skill at its reviewed revision", async () => {
    const installed = { ...skill("write"), name: "cloud-mail" };
    spyOn(aiSkills, "getByShortId").mockResolvedValue(installed);
    const update = spyOn(aiSkills, "update").mockResolvedValue({ ...installed, revision: 4 });
    const access = spyOn(aiSkills, "grantAccess");
    const remove = spyOn(aiSkills, "delete");
    const enabled = spyOn(aiSkills, "setEnabled");
    const routes = __buildAiSkillsRoutesForTest({ limit: pass, authenticate });
    const { template } = await (await routes.request("/templates/cloud-mail")).json();
    const { skill: current } = await (await routes.request(`/${skillShortId}`)).json();
    const proposal = {
      ...template,
      expectedRevision: current.revision,
      instructions: `${template.instructions}\n\nPreserve our custom policy.`,
      extraFrontmatter: { metadata: { owner: "mail-team" } },
      references: [...(template.references ?? []), ...current.references],
    };
    const request = () =>
      routes.request(`/${skillShortId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proposal),
      });
    expect((await request()).status).toBe(200);
    expect(update).toHaveBeenCalledWith(skillId, subject, proposal);
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
    expect(aiSkills.create).toHaveBeenCalledWith({
      subject,
      name: "weekly-status",
      description: "Summarize recent work.",
      instructions: "List wins and blockers.",
      extraFrontmatter: {},
      references: [{ path: "references/style.md", content: "Be concise." }],
    });
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
    expect(aiSkills.getByShortId).toHaveBeenCalledWith(skillShortId, subject, "write");
    expect(aiSkills.update).toHaveBeenCalledWith(skillId, subject, update);
  });

  test("keeps access management and deletion behind admin permission", async () => {
    spyOn(aiSkills, "getByShortId").mockResolvedValue(null);
    const routes = __buildAiSkillsRoutesForTest({ limit: pass, authenticate });
    expect((await routes.request(`/${skillShortId}/access`)).status).toBe(404);
    expect((await routes.request(`/${skillShortId}`, { method: "DELETE" })).status).toBe(404);
    expect(aiSkills.getByShortId).toHaveBeenCalledWith(skillShortId, subject, "admin");
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
    expect(aiSkills.setEnabled).toHaveBeenCalledWith(skillId, subject, false);
  });

  test("lists readable skills for anonymous public grants without allowing creation", async () => {
    spyOn(aiSkills, "list").mockResolvedValue([]);
    const routes = __buildAiSkillsRoutesForTest({ limit: pass, authenticate: pass });
    expect((await routes.request("/")).status).toBe(200);
    expect(aiSkills.list).toHaveBeenCalledWith(null);
    expect(
      (
        await routes.request("/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "test", description: "Test.", instructions: "Test." }),
        })
      ).status,
    ).toBe(403);
  });
});
