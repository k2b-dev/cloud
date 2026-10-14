import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CloudAiLoadSkillInputSchema, createCloudAiLoadSkillTool, createCloudAiSearchSkillsTool, loadSelectedAiSkills } from "./skill-tool";
import { aiSkills } from "./skills";

afterEach(() => mock.restore());

test("explicit Skills respect tool scope, deduplicate and fail clearly after revocation", async () => {
  const subject = { type: "user" as const, userId: "11111111-1111-4111-8111-111111111111" };
  const load = spyOn(aiSkills, "loadForTurn").mockResolvedValue({
    name: "invoice",
    description: "Invoice",
    revision: 2,
    instructions: "Read rules.",
    files: [],
    loadedAt: "2026-09-16",
  });
  await expect(loadSelectedAiSkills(["Sk2345"], "turn", subject, false)).rejects.toThrow("tool scope");
  expect(load).not.toHaveBeenCalled();
  expect(await loadSelectedAiSkills(["Sk2345", "Sk2345"], "turn", subject, true)).toEqual([
    { name: "invoice", revision: 2, instructions: "Read rules.", files: [] },
  ]);
  expect(load).toHaveBeenCalledTimes(1);
  load.mockResolvedValue(null);
  await expect(loadSelectedAiSkills(["Sk2345"], "next-turn", subject, true)).rejects.toThrow("revoked");
});

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

  test("continuation reloads with the new turn and rechecks revoked access", async () => {
    const subject = { type: "user" as const, userId: "11111111-1111-4111-8111-111111111111" };
    const load = spyOn(aiSkills, "loadForTurn")
      .mockResolvedValueOnce({
        name: "cloud-grids",
        description: "Queries",
        revision: 2,
        instructions: "Use GQL",
        files: [],
        loadedAt: "2026-09-09T20:00:00Z",
      })
      .mockResolvedValueOnce(null);
    const tool = createCloudAiLoadSkillTool(subject);
    if (tool.location !== "server") throw new Error("Expected server tool");
    await tool.run({ name: "cloud-grids" }, { turnId: "turn-1" } as never);
    await expect(tool.run({ name: "cloud-grids" }, { turnId: "turn-2" } as never)).rejects.toThrow("unavailable or access was revoked");
    expect(load).toHaveBeenNthCalledWith(2, "turn-2", "cloud-grids", subject);
  });
});

describe("search_skills", () => {
  test("finds Cloud matches beyond names shadowed by manual-only local Skills", async () => {
    const subject = { type: "user" as const, userId: "user" };
    const skills = Array.from({ length: 21 }, (_, index) => ({
      source: null,
      id: `invoice-${index}`,
      shortId: `In${index.toString().padStart(4, "0")}`,
      name: `invoice-${index}`,
      description: "Invoice workflow.",
      permission: "read" as const,
      enabled: true,
      manualOnly: false,
      revision: 1,
      referenceCount: 0,
      createdAt: "2026-10-11",
      updatedAt: "2026-10-11",
    }));
    const search = spyOn(aiSkills, "search").mockImplementation(async (_subject, _query, limit = 30) => ({
      skills: skills.slice(0, limit),
      more: skills.length > limit,
    }));
    const tool = createCloudAiSearchSkillsTool(
      subject,
      skills.slice(0, 20).map(({ name, description }) => ({ name, description, source: "local", manualOnly: true })),
    );
    if (tool.location !== "server") throw new Error("Expected server tool");
    expect(await tool.run({ query: "invoice", limit: 10 }, {} as never)).toEqual({
      skills: [{ name: "invoice-20", description: "Invoice workflow." }],
      more: false,
    });
    expect(search).toHaveBeenCalledWith(subject, "invoice", 30, { modelInvocableOnly: true });
  });

  test("rechecks access and returns only enabled matching Skills", async () => {
    const subject = { type: "user" as const, userId: "11111111-1111-4111-8111-111111111111" };
    spyOn(aiSkills, "search").mockResolvedValue({
      skills: [{ name: "cloud-mail", description: "Email and inbox workflows.", enabled: true }] as never,
      more: false,
    });
    const tool = createCloudAiSearchSkillsTool(subject);
    if (tool.location !== "server") throw new Error("Expected server tool");

    expect(
      await tool.run({ query: "email", limit: 10 }, {
        actor: { kind: "user", user: { id: subject.userId } },
        signal: new AbortController().signal,
      } as never),
    ).toEqual({ skills: [{ name: "cloud-mail", description: "Email and inbox workflows." }], more: false });
    expect(aiSkills.search).toHaveBeenCalledWith(subject, "email", 10, { modelInvocableOnly: true });
  });
});

test.each([false, true])("search_skills respects local precedence with manualOnly=%s", async (manualOnly) => {
  const subject = { type: "user" as const, userId: "user" };
  spyOn(aiSkills, "search").mockResolvedValue({
    skills: [
      {
        source: null,
        id: "invoice",
        shortId: "In2345",
        name: "invoice",
        description: "Cloud invoices.",
        permission: "read",
        enabled: true,
        manualOnly: false,
        revision: 1,
        referenceCount: 0,
        createdAt: "2026-10-11",
        updatedAt: "2026-10-11",
      },
    ],
    more: false,
  });
  const ctx = {
    actor: {
      kind: "user" as const,
      user: {
        id: subject.userId,
        uid: "test",
        roles: [],
        provider: "local" as const,
        profile: "user" as const,
        givenname: "Test",
        sn: "User",
        displayName: "Test User",
        mail: null,
        avatarHash: null,
        ipa: null,
        accountExpires: null,
        lastLoginLocal: null,
        memberofGroup: [],
        memberofGroupIds: [],
        manages: [],
        managesGroupIds: [],
      },
    },
    signal: new AbortController().signal,
    requestApproval: async () => {
      throw new Error("Unexpected approval");
    },
    requestClientTool: async () => {
      throw new Error("Unexpected client tool");
    },
  };
  const tool = createCloudAiSearchSkillsTool(subject, [
    { name: "invoice", description: "Local invoice workflow.", source: "local", ...(manualOnly ? { manualOnly: true } : {}) },
    { name: "notes", description: "Meeting minutes.", source: "local" },
  ]);
  if (tool.location !== "server") throw new Error("Expected server tool");
  expect(await tool.run({ query: "invoice", limit: 10 }, ctx)).toEqual({
    skills: manualOnly ? [] : [{ name: "invoice", description: "Local invoice workflow.", source: "local" }],
    more: false,
  });
  // The local name shadows Cloud even when only the Cloud description matches.
  expect(await tool.run({ query: "invoices", limit: 10 }, ctx)).toEqual({ skills: [], more: false });
  const localOnly = createCloudAiSearchSkillsTool(null, [{ name: "notes", description: "Meeting minutes.", source: "local" }]);
  if (localOnly.location !== "server") throw new Error("Expected server tool");
  expect(await localOnly.run({ query: "meeting", limit: 1 }, ctx)).toEqual({
    skills: [{ name: "notes", description: "Meeting minutes.", source: "local" }],
    more: false,
  });
});
