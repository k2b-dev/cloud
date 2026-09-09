import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CloudAiLoadSkillInputSchema, createCloudAiLoadSkillTool, createCloudAiSearchSkillsTool } from "./skill-tool";
import { aiSkills } from "./skills";

afterEach(() => mock.restore());

describe("load_skill", () => {
  test("accepts exactly one stable selector", () => {
    expect(CloudAiLoadSkillInputSchema.safeParse({ id: "Sk2345" }).success).toBeTrue();
    expect(CloudAiLoadSkillInputSchema.safeParse({}).success).toBeFalse();
    expect(CloudAiLoadSkillInputSchema.safeParse({ id: "Sk2345", name: "weekly-status" }).success).toBeFalse();
  });
  test("passes attached IDs directly to the authorized pinned load without a rename race", async () => {
    const subject = { type: "user" as const, userId: "11111111-1111-4111-8111-111111111111" };
    const read = spyOn(aiSkills, "getByShortId");
    const load = spyOn(aiSkills, "loadForTurn").mockResolvedValue(null);
    const tool = createCloudAiLoadSkillTool(subject);
    if (tool.location !== "server") throw new Error("Expected server tool");
    const ctx = { turnId: "turn-1" } as never;
    await expect(tool.run({ id: "Sk2345" }, ctx)).rejects.toThrow("unavailable");
    expect(read).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledWith("turn-1", { id: "Sk2345" }, subject);
  });
  test("pins the selected revision and returns its standard file mount", async () => {
    const subject = { type: "user" as const, userId: "11111111-1111-4111-8111-111111111111" };
    spyOn(aiSkills, "loadForTurn").mockResolvedValue({
      name: "weekly-status",
      description: "Summarize recent work.",
      revision: 4,
      instructions: "List wins and blockers.",
      files: [
        { path: "/skills/weekly-status/SKILL.md", content: "skill" },
        { path: "/skills/weekly-status/references/style.md", content: "style" },
      ],
      loadedAt: "2026-08-20T12:00:00.000Z",
    });
    const tool = createCloudAiLoadSkillTool(subject);
    if (tool.location !== "server") throw new Error("Expected server tool");

    expect(
      await tool.run({ name: "weekly-status" }, {
        actor: { kind: "user", user: { id: subject.userId } },
        conversationId: "conversation-1",
        turnId: "22222222-2222-4222-8222-222222222222",
        signal: new AbortController().signal,
      } as never),
    ).toEqual({
      name: "weekly-status",
      description: "Summarize recent work.",
      revision: 4,
      instructions: "List wins and blockers.",
      mount: "/skills/weekly-status",
      files: ["/skills/weekly-status/SKILL.md", "/skills/weekly-status/references/style.md"],
    });
    expect(aiSkills.loadForTurn).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", "weekly-status", subject);
  });

  test("does not expose a skill after its permission check fails", async () => {
    const subject = { type: "user" as const, userId: "11111111-1111-4111-8111-111111111111" };
    spyOn(aiSkills, "loadForTurn").mockResolvedValue(null);
    const tool = createCloudAiLoadSkillTool(subject);
    if (tool.location !== "server") throw new Error("Expected server tool");
    await expect(
      tool.run({ name: "weekly-status" }, {
        actor: { kind: "user", user: { id: subject.userId } },
        turnId: "turn-1",
        signal: new AbortController().signal,
      } as never),
    ).rejects.toThrow("unavailable or access was revoked");
  });
});

describe("search_skills", () => {
  test("rechecks access and returns only enabled matching Skills", async () => {
    const subject = { type: "user" as const, userId: "11111111-1111-4111-8111-111111111111" };
    spyOn(aiSkills, "list").mockResolvedValue([
      { name: "cloud-mail", description: "Email and inbox workflows.", enabled: true },
      { name: "private-mail", description: "Another email workflow.", enabled: false },
      { name: "cloud-spaces", description: "Tasks and events.", enabled: true },
    ] as never);
    const tool = createCloudAiSearchSkillsTool(subject);
    if (tool.location !== "server") throw new Error("Expected server tool");

    expect(
      await tool.run({ query: "email", limit: 10 }, {
        actor: { kind: "user", user: { id: subject.userId } },
        signal: new AbortController().signal,
      } as never),
    ).toEqual({ skills: [{ name: "cloud-mail", description: "Email and inbox workflows." }], more: false });
    expect(aiSkills.list).toHaveBeenCalledWith(subject);
  });
});
