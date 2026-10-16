import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiProject } from "@k2b/cloud/ai";
import { createConfig } from "@k2b/ssr";

const root = mkdtempSync(join(tmpdir(), "assistant-slash-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { assistantCopyFor } = await import("./ui-copy");
const { assistantApi } = await import("../api/client");
const { assistantBuiltInCommands, assistantComposerCommands, assistantCommandScopes, assistantCommandSections } = await import(
  "./composer-commands"
);

afterEach(() => mock.restore());

const project: AiProject = {
  id: "project-1",
  shortId: "Ab1234",
  name: "Invoices",
  description: "Accounts",
  icon: "ti ti-folders",
  instructions: "",
  defaultModelProfileId: null,
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
  await commands[0]!.action?.({ setValue() {}, submit() {}, focus() {} });
  expect(assigned).toEqual([project.id]);
  expect((await assistantComposerCommands({ ...input, projectId: project.id }))[0]?.reason).toBe("This chat already belongs to “Invoices”");
  expect((await assistantComposerCommands({ ...input, projectId: "unlisted-project" }))[0]?.reason).toBe(
    "This chat already belongs to a project",
  );
  expect((await assistantComposerCommands({ ...input, running: true }))[0]?.reason).toBe("Available when the response is done");
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
        ? ["Projekt zuordnen", "Chat kompaktieren", "Chat abzweigen", "Neuer Chat"]
        : ["Assign to project", "Compact chat", "Fork chat", "New chat"],
    );
    expect(commands.map((command) => command.id)).toEqual(["project", "compact", "fork", "new"]);
    expect(commands.map((command) => command.name)).toEqual(["project", "compact", "fork", "new"]);
    expect(commands.map((command) => command.keywords)).toEqual([
      ["project", "projekt", "zuordnen", "assign"],
      ["compact", "kompaktieren", "kontext", "zusammenfassen", "platz"],
      ["fork", "abzweigen", "kopie", "verzweigen", "branch"],
      ["new", "neu", "chat", "leer"],
    ]);
    // Matching itself is tested at the shared composer seam; these words support both /kompakt and /compact.
    for (const query of ["kompakt", "compact"]) expect(commands[1]!.keywords!.some((word) => word.includes(query))).toBe(true);
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
      expect(commands.slice(1).map((command) => command.reason)).toEqual([...reasons, undefined]);
    }
    const commands = assistantBuiltInCommands(input);
    expect(await commands[1]!.action!({ setValue() {}, submit() {}, focus() {} })).toEqual({ done: copy.compactDone });
    expect(await commands[2]!.action!({ setValue() {}, submit() {}, focus() {} })).toEqual({ done: copy.forkDone });
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

test("sections and bilingual scope words agree, with each locale's narrowing word first", async () => {
  const { resolveChatCommandScope, chatCommandListModel } = await import("../../../ui/src/chat/command-search");
  for (const locale of ["en", "de"]) {
    const copy = assistantCopyFor(locale);
    const scopes = assistantCommandScopes(copy, locale);
    expect(assistantCommandSections(copy).map((section) => section.id)).toEqual(["skills", "files", "apps", "chat"]);
    expect(assistantCommandSections(copy).map((section) => Boolean(section.searched))).toEqual([true, true, true, false]);
    for (const [word, id] of [
      ["project", "project"],
      ["projekt", "project"],
      ["file", "file"],
      ["dateien", "file"],
      ["app", "app"],
      ["studio", "app"],
      ["skills", "skill"],
    ])
      expect(resolveChatCommandScope(word!, scopes)?.id).toBe(id);
    expect(scopes.map((scope) => scope.words[0])).toEqual(
      locale === "de" ? ["skill", "datei", "projekt", "app"] : ["skill", "file", "project", "app"],
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
      searching: false,
    });
    expect(result.rows[0]?.command).toMatchObject({ id: "project", scope: "project" });
    expect(result.rows[0]?.command.action).toBeUndefined();
  }
});

test("files stay out of overview and return through file scope or a search; app scope and legacy one-word prefixes work", async () => {
  const { artifactClient } = await import("../artifacts/client");
  const listSkills = spyOn(assistantApi, "listSkills").mockResolvedValue([]);
  const apps = spyOn(artifactClient, "list").mockResolvedValue({
    items: [
      {
        id: "app-1",
        title: "Invoices",
        description: "Match",
        kind: "app",
        icon: "",
        revision: 1,
        permission: "read",
        updatedAt: "",
        publishedRevision: 1,
        forkedFromId: null,
        forkedFromRevision: null,
      },
    ],
    page: 1,
    hasNext: false,
  });
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
  expect((await assistantComposerCommands({ ...input, scope: "app" }))[0]?.section).toBe("apps");
  expect((await assistantComposerCommands({ ...input, query: "app" }))[0]?.section).toBe("apps");
  expect(apps).toHaveBeenCalled();
  await assistantComposerCommands({ ...input, query: "skill" });
  expect(listSkills).toHaveBeenLastCalledWith(input.signal, "");
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
  expect(commands[0]).toMatchObject({
    id: "project",
    section: "chat",
    hiddenUntilSearch: true,
    reason: "Gehört schon zu Projekt „Invoices“",
  });
  const { chatCommandListModel } = await import("../../../ui/src/chat/command-search");
  const input = { commands, searchResults: [], searchResultsFresh: true, searching: false };
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
    expect(commands.slice(1, 3).map((row) => row.hiddenUntilSearch)).toEqual([true, true]);
    const running = assistantBuiltInCommands({ ...input, ...context, running: true });
    expect(running.slice(1, 3).map((row) => row.hiddenUntilSearch)).toEqual([false, false]);
    expect(running.slice(1, 3).map((row) => row.reason)).toEqual([input.copy.commandNeedsIdle, input.copy.commandNeedsIdle]);
  }
  const beforeAnswer = assistantBuiltInCommands({ ...input, hasAssistantMessage: false });
  expect(beforeAnswer.slice(1, 3).map((row) => row.hiddenUntilSearch)).toEqual([false, true]);
  expect(beforeAnswer.every((row) => row.section === "chat")).toBe(true);
});
