import { afterAll, afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiProject, AiSkillSummary } from "@k2b/cloud/ai";
import type { CloudResourcePickerItem } from "@k2b/cloud/browser/resource-picker";
import { createConfig } from "@k2b/ssr";

const root = mkdtempSync(join(tmpdir(), "assistant-slash-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { assistantCopyFor } = await import("./ui-copy");
const { assistantApi } = await import("../api/client");
const {
  assistantInsertCommands,
  assistantResourceMention,
  assistantBuiltInCommands: builtInCommands,
  assistantComposerCommands: searchCommands,
  assistantCommandScopes,
  assistantCommandSections,
  createAssistantCommandSession,

  overviewSkills,
} = await import("./composer-commands");

beforeEach(() => {
  setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
  spyOn(assistantApi, "listSkills").mockResolvedValue([]);
  spyOn(assistantApi, "findSkillsByName").mockResolvedValue([]);
});
afterEach(() => {
  mock.restore();
  setSystemTime();
});
const assistantComposerCommands = (
  input: Omit<Parameters<typeof searchCommands>[0], "session" | "sessionLoader" | "runKeys" | "models" | "chooseModel" | "isRunning">,
) =>
  searchCommands({
    session: 1,
    sessionLoader: createAssistantCommandSession(),

    models: [],
    chooseModel() {},
    isRunning: () => false,
    ...input,
  });
const assistantBuiltInCommands = (input: Omit<Parameters<typeof builtInCommands>[0], "models" | "searchChat" | "recording">) =>
  builtInCommands({ models: [{ id: "model", label: "Current" }], searchChat() {}, recording: false, ...input });
const context = { setValue() {}, submit() {}, focus() {}, openModelSelection: async () => null };

const project: AiProject = {
  id: "project-1",
  shortId: "Ab1234",
  name: "Invoices",
  description: "Accounts",
  icon: "ti ti-folders",
  instructions: "",
  defaultModel: null,
  permission: "read",
  revision: 1,
  createdAt: "",
  updatedAt: "",
};

test("Project scope selection assigns once and explains an existing assignment", async () => {
  const assigned: string[] = [];
  const input = {
    query: "inv",
    scope: "project",
    signal: new AbortController().signal,
    locale: "en",
    projects: [project],
    running: false,
    assignProject: async (id: string) => {
      assigned.push(id);
    },
  };
  const commands = await assistantComposerCommands(input);
  expect(commands.map((command) => command.label)).toEqual(["Invoices"]);
  await commands[0]!.action?.(context);
  expect(assigned).toEqual([project.id]);
  expect((await assistantComposerCommands({ ...input, projectId: project.id }))[0]?.reason).toBe("This chat already belongs to “Invoices”");
  expect((await assistantComposerCommands({ ...input, projectId: "unlisted-project" }))[0]?.reason).toBe(
    "This chat already belongs to a project",
  );
  expect((await assistantComposerCommands({ ...input, running: true }))[0]?.reason).toBe("Available when the response is done");
});

test.each(["project", "projekt"])("legacy /%s lists projects without searching other categories", async (query) => {
  const listSkills = spyOn(assistantApi, "listSkills").mockResolvedValue([
    {
      id: "matching-skill",
      shortId: "Sk1234",
      name: query,
      description: query,
      permission: "read",
      enabled: true,
      revision: 1,
      source: null,
      manualOnly: false,
      referenceCount: 0,
      createdAt: "",
      updatedAt: "",
    },
  ]);
  const files = spyOn(assistantApi, "listChatFiles").mockResolvedValue([]);
  const assigned: string[] = [];
  const commands = await assistantComposerCommands({
    query,
    signal: new AbortController().signal,
    locale: query === "projekt" ? "de" : "en",
    conversationId: "chat-1",
    projects: [project],
    running: false,
    assignProject: async (id) => {
      assigned.push(id);
    },
  });
  expect(commands.map((command) => command.id)).toEqual([`project:${project.id}`]);
  expect(commands[0]?.label).toBe(project.name);
  expect(listSkills).not.toHaveBeenCalled();
  expect(files).not.toHaveBeenCalled();
  await commands[0]!.action?.(context);
  expect(assigned).toEqual([project.id]);
});

test("Skills are explicit stable references; disabled Skills are excluded", async () => {
  const skill = {
    id: "skill-1",
    shortId: "Sk1234",
    name: "invoices",
    description: "Match invoices",
    permission: "read" as const,
    enabled: true,
    revision: 1,
    source: null,
    manualOnly: false,
    referenceCount: 0,
    createdAt: "",
    updatedAt: "",
  };
  const list = spyOn(assistantApi, "listSkills").mockResolvedValue([skill, { ...skill, id: "disabled", enabled: false }]);
  const signal = new AbortController().signal;
  const commands = await assistantComposerCommands({
    query: "invioces",
    scope: "skill",
    signal,
    locale: "en",
    projects: [],
    running: false,
    assignProject: async () => {},
  });
  expect(list).toHaveBeenCalledWith(signal, "invioces");
  expect(commands).toHaveLength(1);
  expect(commands[0]?.action).toBeUndefined();
  expect(commands[0]?.mention?.data).toMatchObject({ kind: "resource", ref: { type: "core.ai.skill", id: "Sk1234" } });
});

test("same-named files and Projects keep distinct row ids, so the composer does not merge them", async () => {
  const file: Awaited<ReturnType<typeof assistantApi.listChatFiles>>[number] = {
    path: "/a/report.md",
    version: 1,
    size: 3,
    mediaType: "text/markdown",
    origin: "assistant",
    updatedAt: "",
  };
  spyOn(assistantApi, "listChatFiles").mockResolvedValue([file, { ...file, path: "/b/report.md" }]);
  const commands = await assistantComposerCommands({
    query: "report",
    scope: "file",
    signal: new AbortController().signal,
    locale: "de",
    conversationId: "chat-1",
    projects: [],
    running: false,
    assignProject: async () => {},
  });
  expect(commands.map((command) => command.name)).toEqual(["report.md", "report.md"]);
  expect(commands.map((command) => command.description)).toEqual(["Chat-Datei · /a/report.md", "Chat-Datei · /b/report.md"]);
  expect(new Set(commands.map((command) => command.id)).size).toBe(2);
  const projects = await assistantComposerCommands({
    query: "inv",
    scope: "project",
    signal: new AbortController().signal,
    locale: "en",
    projects: [project, { ...project, id: "project-2" }],
    running: false,
    assignProject: async () => {},
  });
  expect(projects.map((command) => command.id)).toEqual(["project:project-1", "project:project-2"]);
});

test("built-ins have plain localized labels, retain old names and multilingual search words", () => {
  for (const locale of ["de", "en"]) {
    const commands = assistantBuiltInCommands({
      copy: assistantCopyFor(locale),
      projectComposer: false,
      running: false,
      hasMessages: true,
      hasAssistantMessage: true,
      compact: async () => {},
      fork: async () => {},
      newChat: async () => {},
    });
    expect(commands.map((command) => command.label)).toEqual(
      locale === "de"
        ? ["Modell wählen", "Projekt zuordnen", "Chat kompaktieren", "Chat abzweigen", "In diesem Chat suchen", "Neuer Chat"]
        : ["Choose model", "Assign to project", "Compact chat", "Fork chat", "Search this chat", "New chat"],
    );
    expect(commands.map((command) => command.id)).toEqual(["model", "project", "compact", "fork", "search", "new"]);
    expect(commands.map((command) => command.name)).toEqual(["model", "project", "compact", "fork", "search", "new"]);
    expect(commands.map((command) => command.keywords)).toEqual([
      ["model", "modell", "ki", "ai", "llm"],
      ["project", "projekt", "zuordnen", "assign"],
      ["compact", "kompaktieren", "kontext", "zusammenfassen", "platz"],
      ["fork", "abzweigen", "kopie", "verzweigen", "branch"],
      ["search", "suchen", "finden", "find", "durchsuchen"],
      ["new", "neu", "chat", "leer"],
    ]);
    // Matching itself is tested at the shared composer seam; these words support both /kompakt and /compact.
    for (const query of ["kompakt", "compact"]) expect(commands[2]!.keywords!.some((word) => word.includes(query))).toBe(true);
  }
});

test("built-in reasons reflect prerequisites before a running response, and actions keep their outcomes", async () => {
  for (const locale of ["en", "de"]) {
    const copy = assistantCopyFor(locale);
    const input = {
      copy,
      projectComposer: false,
      running: false,
      hasMessages: true,
      hasAssistantMessage: true,
      compact: async () => ({ done: copy.compactDone }),
      fork: async () => ({ done: copy.forkDone }),
      newChat: async () => {},
    };
    for (const [state, reasons] of [
      [{ projectComposer: true, running: true }, [copy.commandNeedsIdle, copy.commandNeedsIdle]],
      [{ hasMessages: false, hasAssistantMessage: false, running: true }, [copy.commandNeedsIdle, copy.commandNeedsIdle]],
      [{ hasAssistantMessage: false }, [undefined, copy.commandNeedsAnswer]],
      [{ running: true }, [copy.commandNeedsIdle, copy.commandNeedsIdle]],
      [{}, [undefined, undefined]],
    ] as const) {
      const commands = assistantBuiltInCommands({ ...input, ...state });
      expect(commands.slice(2, 4).map((command) => command.reason)).toEqual([...reasons]);
    }
    const commands = assistantBuiltInCommands(input);
    expect(await commands[2]!.action!(context)).toEqual({ done: copy.compactDone });
    expect(await commands[3]!.action!(context)).toEqual({ done: copy.forkDone });
    expect([
      copy.compactFailed({ reason: "Oops" }),
      copy.forkFailed({ reason: "Oops" }),
      copy.newChatFailed({ reason: "Oops" }),
      copy.draftUnchanged,
      copy.forkDraftNotSaved({ reason: "Oops" }),
    ]).toEqual(
      locale === "de"
        ? [
            "Kompaktieren hat nicht geklappt: Oops.",
            "Abzweigen hat nicht geklappt: Oops.",
            "Neuen Chat starten hat nicht geklappt: Oops.",
            "Dein Entwurf ist unverändert.",
            "Abgezweigt, aber dein Entwurf wurde im neuen Chat nicht gespeichert: Oops.",
          ]
        : [
            "Compacting did not work: Oops.",
            "Forking did not work: Oops.",
            "Starting a new chat did not work: Oops.",
            "Your draft is unchanged.",
            "Forked, but your draft was not saved in the new chat: Oops.",
          ],
    );
  }
});

test("while recording, choose model narrows to the model list instead of opening the replaced control", () => {
  for (const locale of ["en", "de"]) {
    const copy = assistantCopyFor(locale);
    const input = {
      copy,
      projectComposer: false,
      running: false,
      recording: true,
      hasMessages: true,
      hasAssistantMessage: true,
      models: [{ id: "model", label: "Current" }],
      searchChat() {},
      compact: async () => {},
      fork: async () => {},
      newChat: async () => {},
    };
    const model = (state: Partial<typeof input>) => builtInCommands({ ...input, ...state }).find((row) => row.id === "model")!;
    expect(model({})).toMatchObject({ scope: "model", reason: undefined, action: undefined });
    expect(model({ running: true }).reason).toBe(copy.commandNeedsIdle);
    expect(model({ models: [] }).reason).toBe(copy.commandNoModel);
    expect(model({ recording: false }).action).toBeFunction();
  }
});

test("sections and bilingual scope words agree, with each locale's narrowing word first", async () => {
  const { resolveChatCommandScope, chatCommandListModel } = await import("../../../ui/src/chat/command-search");
  for (const locale of ["en", "de"]) {
    const copy = assistantCopyFor(locale);
    const scopes = assistantCommandScopes(copy, locale);
    expect(assistantCommandSections(copy).map((section) => section.id)).toEqual(["recent", "insert", "skills", "files", "chat", "apps"]);
    expect(assistantCommandSections(copy).map((section) => Boolean(section.searched))).toEqual([false, false, true, true, false, false]);
    // Recent sits on top: only in the overview, and only with the rows it had when the list opened.
    expect(assistantCommandSections(copy)[0]).toEqual({
      id: "recent",
      label: locale === "de" ? "Zuletzt" : "Recent",
      overviewOnly: true,
      fixedWhileOpen: true,
    });
    // App Commands load with the catalog; their section is last, so rows that arrive only fill the end.
    expect(assistantCommandSections(copy, true).at(-1)).toEqual({
      id: "apps",
      label: locale === "de" ? "In Apps öffnen" : "Open in apps",
      pending: true,
    });
    for (const [word, id] of [
      ["project", "project"],
      ["projekt", "project"],
      ["file", "file"],
      ["dateien", "file"],
      ["skills", "skill"],
    ])
      expect(resolveChatCommandScope(word!, scopes)?.id).toBe(id);
    expect(scopes.map((scope) => scope.words[0])).toEqual(
      locale === "de" ? ["skill", "datei", "projekt", "modell"] : ["skill", "file", "project", "model"],
    );
    const commands = assistantBuiltInCommands({
      copy,
      projectComposer: false,
      running: false,
      hasMessages: true,
      hasAssistantMessage: true,
      compact: async () => {},
      fork: async () => {},
      newChat: async () => {},
    });
    const result = chatCommandListModel({
      query: "project",
      scopes,
      sections: assistantCommandSections(copy),
      commands,
      searchResults: [],
      searchResultsFresh: true,
      searchSettled: true,
      searching: false,
    });
    expect(result.rows[0]?.command).toMatchObject({ id: "project", scope: "project" });
    expect(result.rows[0]?.command.action).toBeUndefined();
  }
});

test("files stay out of overview and return through file scope or a search; legacy one-word prefixes work", async () => {
  const listSkills = spyOn(assistantApi, "listSkills").mockResolvedValue([]);
  const listFiles = spyOn(assistantApi, "listChatFiles").mockResolvedValue([
    { path: "/report.md", version: 1, size: 3, mediaType: "text/markdown", origin: "assistant", updatedAt: "" },
  ]);
  const input = {
    query: "",
    signal: new AbortController().signal,
    locale: "en",
    conversationId: "chat",
    projects: [project],
    running: false,
    assignProject: async () => {},
  };
  const overview = await assistantComposerCommands(input);
  expect(overview.every((command) => command.section !== "files" && !command.id?.startsWith("project:"))).toBe(true);
  expect(listFiles).not.toHaveBeenCalled();
  for (const query of ["file", "datei"]) {
    const rows = await assistantComposerCommands({ ...input, query });
    expect(rows.map((row) => row.section)).toEqual(["files"]);
  }
  expect((await assistantComposerCommands({ ...input, scope: "file" }))[0]?.section).toBe("files");
  expect((await assistantComposerCommands({ ...input, query: "report" })).some((row) => row.section === "files")).toBe(true);
  await assistantComposerCommands({ ...input, query: "skill" });
  expect(listSkills).toHaveBeenLastCalledWith(expect.any(AbortSignal));
});

test("assigned chats hide project assignment until searched and project scope explains the assignment in German", async () => {
  const copy = assistantCopyFor("de");
  const commands = assistantBuiltInCommands({
    copy,
    projectComposer: false,
    projectName: project.name,
    running: false,
    hasMessages: true,
    hasAssistantMessage: true,
    compact: async () => {},
    fork: async () => {},
    newChat: async () => {},
  });
  expect(commands[1]).toMatchObject({
    id: "project",
    section: "chat",
    hiddenUntilSearch: true,
    reason: "Gehört schon zu Projekt „Invoices“",
  });
  const { chatCommandListModel } = await import("../../../ui/src/chat/command-search");
  const input = { commands, searchResults: [], searchResultsFresh: true, searchSettled: true, searching: false };
  expect(chatCommandListModel({ ...input, query: "" }).rows.some((row) => row.command.id === "project")).toBe(false);
  expect(chatCommandListModel({ ...input, query: "projekt" }).rows[0]?.command.reason).toBe("Gehört schon zu Projekt „Invoices“");
  const rows = await assistantComposerCommands({
    query: "",
    scope: "project",
    locale: "de",
    signal: new AbortController().signal,
    projectId: project.id,
    projects: [project],
    running: false,
    assignProject: async () => {
      throw new Error("Must not assign");
    },
  });
  expect(rows[0]?.reason).toBe("Dieser Chat gehört schon zu „Invoices“");
});

test("compact and fork hide in inapplicable contexts but remain visible with a running reason", () => {
  const input = {
    copy: assistantCopyFor("en"),
    projectComposer: false,
    running: false,
    hasMessages: true,
    hasAssistantMessage: true,
    compact: async () => {},
    fork: async () => {},
    newChat: async () => {},
  };
  for (const context of [{ projectComposer: true }, { hasMessages: false, hasAssistantMessage: false }]) {
    const commands = assistantBuiltInCommands({ ...input, ...context });
    expect(commands.slice(2, 4).map((row) => row.hiddenUntilSearch)).toEqual([true, true]);
    const running = assistantBuiltInCommands({ ...input, ...context, running: true });
    expect(running.slice(2, 4).map((row) => row.hiddenUntilSearch)).toEqual([false, false]);
    expect(running.slice(2, 4).map((row) => row.reason)).toEqual([input.copy.commandNeedsIdle, input.copy.commandNeedsIdle]);
  }
  const beforeAnswer = assistantBuiltInCommands({ ...input, hasAssistantMessage: false });
  expect(beforeAnswer.slice(2, 4).map((row) => row.hiddenUntilSearch)).toEqual([false, true]);
  expect(beforeAnswer.every((row) => row.section === "chat")).toBe(true);
});

const skillFixture = (i: number): AiSkillSummary => ({
  id: `skill-${i}`,
  shortId: `Skill${i}`,
  name: `Skill ${i}`,
  description: "",
  permission: "read",
  enabled: true,
  revision: 1,
  source: null,
  manualOnly: false,
  referenceCount: 0,
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-01T12:00:00.000Z",
});

test("overview Skills picks the first four enabled entries without mutating the catalog", () => {
  const skills = Array.from({ length: 7 }, (_, i) => ({ ...skillFixture(i), enabled: i !== 1 }));
  expect(overviewSkills(skills).map((skill) => skill.id)).toEqual(["skill-0", "skill-2", "skill-3", "skill-4"]);
  expect(skills).toHaveLength(7);
});

test.each(["en", "de"])("empty Skill scope offers retry when the full catalog fails (%s)", async (locale) => {
  const listSkills = spyOn(assistantApi, "listSkills").mockRejectedValue(new Error("Skills offline"));
  const rows = await assistantComposerCommands({
    query: "",
    scope: "skill",
    signal: new AbortController().signal,
    locale,
    projects: [],
    running: false,
    assignProject: async () => {},
  });
  const copy = assistantCopyFor(locale);
  expect(rows).toEqual([
    {
      id: "skills-retry",
      name: "skills-retry",
      section: "skills",
      label: copy.commandSkillsFailed,
      description: copy.commandTryAgain,
      icon: "ti ti-alert-circle",
      searchAgain: true,
    },
  ]);
  expect(listSkills).toHaveBeenCalledTimes(1);
  expect(listSkills.mock.calls[0]).toHaveLength(1);
});

test("a Cloud insert mention preserves its identity through send and draft hydration", async () => {
  const { aiComposerDraft, aiComposerSendInput } = await import("@k2b/cloud/ai/ui");
  const ref = { type: "notebooks.note", id: "Q3note" };
  const result = {
    mention: assistantResourceMention({
      ref,
      title: "Q3 plan",
      appId: "notebooks",
      appName: "Notebooks",
      appIcon: "ti ti-notebook",
      readable: true,
      href: "/notebooks/Q3note",
    }),
  };
  const sent = aiComposerSendInput({
    text: "Q3 plan",
    attachments: [],
    mentions: [{ start: 0, end: 7, attachment: result.mention }],
    intent: "send",
  });
  const draft = aiComposerDraft(sent.draftContent!);
  expect(draft.text).toBe("Q3 plan");
  expect(draft.mentions[0]!.attachment).toMatchObject({ id: result.mention.id, name: result.mention.name, data: { ref } });
  expect(result.mention.id).toBe("resource:notebooks.note:Q3note");
});

test("references in the text count toward the limit for inserting and attaching alike; files also wait for the response", () => {
  const input = {
    copy: assistantCopyFor("de"),
    locale: "de",
    tags: [
      {
        appId: "notebooks",
        appName: "Notebooks",
        appIcon: "ti ti-notebook",
        tag: "note",
        title: "Notizen",
        description: "",
        aliases: ["notes"],
      },
    ],
    partCount: () => 16,
    excludeRefs: () => [],
    fileSelectionDisabled: false,
  };
  const rows = assistantInsertCommands(input);
  expect(rows.commands[0]!.reason).toBe("Eine Nachricht kann höchstens 16 Elemente enthalten.");
  // The server counts attachments and inline references together (AiConversationDraftInputSchema).
  expect(rows.commands[1]!.reason).toBe(rows.commands[0]!.reason);
  expect(rows.commands[2]!.reason).toBe(rows.commands[0]!.reason);
  expect(rows.fallback({ query: "q3" })?.reason).toBe(rows.commands[0]!.reason);
  const running = assistantInsertCommands({ ...input, partCount: () => 0, fileSelectionDisabled: true });
  expect(running.commands[0]!.reason).toBeUndefined();
  expect(running.commands[1]!.reason).toBe(input.copy.commandNeedsIdle);
  expect(running.scopes.find((scope) => scope.words.includes("app"))).toBeUndefined();
});

for (const withTrack of [false, true]) {
  for (const rowKind of ["insert", "tag", "scoped fallback"] as const) {
    test.each([
      { count: 16, cancelled: false },
      { count: 15, cancelled: false },
      { count: 16, cancelled: true },
    ])(`${rowKind} rechecks a delayed picker result (track: ${withTrack}): %j`, async ({ count, cancelled }) => {
      const picker = await import("@k2b/cloud/browser/resource-picker");
      const picking = Promise.withResolvers<CloudResourcePickerItem | undefined>();
      spyOn(picker, "openCloudResourcePicker").mockReturnValueOnce(picking.promise);
      const item: CloudResourcePickerItem = {
        ref: { type: "notebooks.note", id: "Note1" },
        title: "Plan",
        appId: "assistant",
        appName: "Assistant",
        appIcon: "ti ti-sparkles",
        href: "/notebooks/notes/Note1",
        readable: true,
      };
      let partCount = 14;
      const tracked: Promise<unknown>[] = [];
      const rows = assistantInsertCommands({
        copy: assistantCopyFor("de"),
        locale: "de",
        tags: [
          {
            appId: "notebooks",
            appName: "Notebooks",
            appIcon: "ti ti-notebook",
            tag: "note",
            title: "Notizen",
            description: "",
            aliases: ["notes"],
          },
        ],
        partCount: () => partCount,
        excludeRefs: () => [],
        fileSelectionDisabled: false,
        track: withTrack
          ? (promise) => {
              tracked.push(promise);
              return promise;
            }
          : undefined,
      });
      const row =
        rowKind === "insert"
          ? rows.commands[0]!
          : rowKind === "tag"
            ? rows.commands[2]!
            : rows.fallback({ query: "plan", scope: rows.scopes[0]!.id })!;
      expect(row.reason).toBeUndefined();
      const result = row.action!(context);
      expect(tracked).toHaveLength(withTrack ? 1 : 0);
      if (withTrack) expect(result === tracked[0]).toBe(true);
      partCount = count;
      picking.resolve(cancelled ? undefined : item);
      if (cancelled) expect(await result).toBe("cancelled");
      else if (count === 16) await expect(result).rejects.toThrow("Eine Nachricht kann höchstens 16 Elemente enthalten.");
      else expect(await result).toEqual({ mention: assistantResourceMention(item) });
    });
  }
}
