import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createCloudAiLoadSkillTool } from "./skill-tool";
import { aiSkills } from "./skills";

afterEach(() => mock.restore());

describe("load_skill", () => {
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
      await tool.run(
        { name: "weekly-status" },
        {
          actor: { kind: "user", user: { id: subject.userId } },
          conversationId: "conversation-1",
          turnId: "22222222-2222-4222-8222-222222222222",
          signal: new AbortController().signal,
        } as never,
      ),
    ).toEqual({
      name: "weekly-status",
      description: "Summarize recent work.",
      revision: 4,
      instructions: "List wins and blockers.",
      mount: "/skills/weekly-status",
      files: ["/skills/weekly-status/SKILL.md", "/skills/weekly-status/references/style.md"],
    });
    expect(aiSkills.loadForTurn).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      "weekly-status",
      subject,
    );
  });

  test("does not expose a skill after its permission check fails", async () => {
    const subject = { type: "user" as const, userId: "11111111-1111-4111-8111-111111111111" };
    spyOn(aiSkills, "loadForTurn").mockResolvedValue(null);
    const tool = createCloudAiLoadSkillTool(subject);
    if (tool.location !== "server") throw new Error("Expected server tool");
    await expect(
      tool.run(
        { name: "weekly-status" },
        { actor: { kind: "user", user: { id: subject.userId } }, turnId: "turn-1", signal: new AbortController().signal } as never,
      ),
    ).rejects.toThrow("unavailable or access was revoked");
  });
});
