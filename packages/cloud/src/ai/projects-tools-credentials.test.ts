import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createCloudAiReadProjectKnowledgeTool } from "./project-tool";
import { aiProjects } from "./projects";
import type { AiResourceContext } from "./projects-authorization";
import { createCloudAiLoadSkillTool, createCloudAiSearchSkillsTool, loadSelectedAiSkills } from "./skill-tool";
import { aiSkills } from "./skills";

afterEach(() => mock.restore());
for (const kind of ["standalone", "agent"] as const) {
  test(`${kind} Project/Skill tools retain the original credential and recheck revoked access`, async () => {
    const context: AiResourceContext = {
      actor: {
        kind: "service_account",
        delegatedUser: null,
        scopes: ["read"],
        serviceAccount: {
          id: "machine",
          name: "Tool machine",
          kind,
          status: "active",
          delegatedUserId: null,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdBy: null,
          createdAt: "1970-01-01T00:00:00.000Z",
        },
      },
      accessSubject: { type: "service_account", serviceAccountId: "machine" },
    };
    const execution = {
      actor: context.actor,
      turnId: "turn",
      signal: new AbortController().signal,
      requestApproval: async () => false,
      requestClientTool: async () => {
        throw new Error("Unexpected client tool");
      },
    };
    const read = spyOn(aiProjects, "get").mockResolvedValue(null);
    const projectTool = createCloudAiReadProjectKnowledgeTool("project", context);
    if (projectTool.location !== "server") throw new Error("Expected server tool");
    await expect(projectTool.run({ id: "Kn2345" }, execution)).rejects.toThrow();
    expect(read).toHaveBeenCalledWith("project", context, "read");
    const search = spyOn(aiSkills, "search").mockResolvedValue({ skills: [], more: false });
    const searchTool = createCloudAiSearchSkillsTool(context);
    if (searchTool.location !== "server") throw new Error("Expected server tool");
    expect(await searchTool.run({ query: "rules", limit: 10 }, execution)).toEqual({ skills: [], more: false });
    expect(search).toHaveBeenCalledWith(context, "rules", 10, { modelInvocableOnly: true, authority: null });
    const load = spyOn(aiSkills, "loadForTurn").mockResolvedValue(null);
    await expect(loadSelectedAiSkills(["Sk2345"], "turn", context, true)).rejects.toThrow("revoked");
    const loadTool = createCloudAiLoadSkillTool(context);
    if (loadTool.location !== "server") throw new Error("Expected server tool");
    await expect(loadTool.run({ id: "Sk2345" }, execution)).rejects.toThrow("revoked");
    expect(load).toHaveBeenCalledWith("turn", { id: "Sk2345" }, context, null);
  });
}
