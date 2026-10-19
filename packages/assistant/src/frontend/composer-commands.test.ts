import { afterAll, afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiChatTaskView, AiProject, AiSkillSummary } from "@k2b/cloud/ai";
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
  createAssistantTaskRunKeys,
  MAX_PENDING_RUN_KEYS,
  overviewSkills,
} = await import("./composer-commands");

beforeEach(() => {
  setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
  spyOn(assistantApi, "listSkills").mockResolvedValue([]);
  spyOn(assistantApi, "findSkillsByName").mockResolvedValue([]);
  spyOn(assistantApi, "listChatTasks").mockResolvedValue([]);
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
    runKeys: createAssistantTaskRunKeys(),
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
  await commands[0]!.action?.(context);
  expect(assigned).toEqual([project.id]);
  expect((await assistantComposerCommands({ ...input, projectId: project.id }))[0]?.reason).toBe("This chat already belongs to “Invoices”");
  expect((await assistantComposerCommands({ ...input, projectId: "unlisted-project" }))[0]?.reason).toBe(
    "This chat already belongs to a project",
  );
  expect((await assistantComposerCommands({ ...input, running: true }))[0]?.reason).toBe("Available when the response is done");
});

test.each(["project", "projekt"])("legacy /%s lists projects without searching other categories", async (query) => {
  const { artifactClient } = await import("../artifacts/client");
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
  const apps = spyOn(artifactClient, "list").mockResolvedValue({ items: [], page: 1, hasNext: false });
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
  expect(apps).not.toHaveBeenCalled();
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
    expect(assistantCommandSections(copy).map((section) => section.id)).toEqual(["insert", "skills", "files", "chat", "tasks", "apps"]);
    expect(assistantCommandSections(copy).map((section) => Boolean(section.searched))).toEqual([false, true, true, false, true, false]);
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
      locale === "de" ? ["skill", "datei", "projekt", "modell", "routine"] : ["skill", "file", "project", "model", "routine"],
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
const taskFixture = (i: number): AiChatTaskView => ({
  id: `task-${i}`,
  chatId: "chat",
  chatTitle: "Chat",
  title: `Task ${i}`,
  name: `Task ${i}`,
  reason: null,
  prompt: `Task ${i}: details\nMore`,
  grants: [],
  schedule: { kind: "cron", cron: "0 7 * * *" },
  timezone: "UTC",
  state: "active",
  lastError: null,
  createdAt: `2026-10-0${i + 1}T12:00:00.000Z`,
  updatedAt: "2026-10-10T12:00:00.000Z",
});

test("overview Skills picks the first four enabled entries without mutating the catalog", () => {
  const skills = Array.from({ length: 7 }, (_, i) => ({ ...skillFixture(i), enabled: i !== 1 }));
  expect(overviewSkills(skills).map((skill) => skill.id)).toEqual(["skill-0", "skill-2", "skill-3", "skill-4"]);
  expect(skills).toHaveLength(7);
});

test("session loader reuses promises, merges states newest first, and aborts only superseded sessions", async () => {
  const listSkills = spyOn(assistantApi, "listSkills").mockResolvedValue([skillFixture(0)]);
  const findSkills = spyOn(assistantApi, "findSkillsByName").mockResolvedValue([skillFixture(1)]);
  const listTasks = spyOn(assistantApi, "listChatTasks").mockImplementation(async ({ state }) => [
    { ...taskFixture(state === "active" ? 0 : state === "paused" ? 2 : 1), state: state! },
  ]);
  const loader = createAssistantCommandSession();
  try {
    const first = loader.load(10);
    expect(loader.load(10)).toBe(first);
    expect((await first).tasks?.map((task) => task.id)).toEqual(["task-2", "task-1", "task-0"]);
    expect(listSkills).toHaveBeenCalledTimes(1);
    expect(listSkills.mock.calls[0]).toHaveLength(1);
    expect(findSkills).toHaveBeenCalledTimes(1);
    expect(findSkills).toHaveBeenCalledWith("scheduled-tasks", listSkills.mock.calls[0]![0]);
    expect((await first).scheduledTaskSkills).toEqual([skillFixture(1)]);
    expect(listTasks.mock.calls.map(([input]) => ({ state: input.state, limit: input.limit, chatId: input.chatId }))).toEqual([
      { state: "active", limit: 100, chatId: undefined },
      { state: "paused", limit: 100, chatId: undefined },
      { state: "needs_attention", limit: 100, chatId: undefined },
    ]);
    const signal = listSkills.mock.calls[0]![0]!;
    expect(signal.aborted).toBe(false);
    await loader.load(11);
    expect(signal.aborted).toBe(true);
    expect(listSkills).toHaveBeenCalledTimes(2);
    expect(findSkills).toHaveBeenCalledTimes(2);
  } finally {
    loader.dispose();
  }
});

const createRunKeyStorage = (initial: string | null = null) => {
  let value = initial;
  return {
    getItem: mock((_key: string) => value),
    setItem: mock((_key: string, next: string) => {
      value = next;
    }),
  };
};

test("task run keys load lazily and preserve uncertain starts across a page reload", () => {
  const storage = createRunKeyStorage();
  const first = createAssistantTaskRunKeys(storage);
  const reloaded = createAssistantTaskRunKeys(storage);
  expect(storage.getItem).not.toHaveBeenCalled();
  const key = first.runKey("task-1");
  expect(key).toMatch(/^[a-f0-9]{32}$/);
  expect(first.runKey("task-1")).toBe(key);
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  first.runUncertain("task-1");
  expect(reloaded.isUncertain("task-1")).toBe(true);
  expect(reloaded.runKey("task-1")).toBe(key);
  expect(storage.getItem).toHaveBeenCalledTimes(2);
  expect(storage.getItem).toHaveBeenCalledWith("k2b.assistant.taskRunKeys");
  reloaded.settleRun("task-1");
  expect(createAssistantTaskRunKeys(storage).runKey("task-1")).toBe(key);
  reloaded.settleRun("task-1", { force: true });
  const settled = createAssistantTaskRunKeys(storage);
  expect(settled.isUncertain("task-1")).toBe(false);
  expect(settled.runKey("task-1")).not.toBe(key);
  settled.settleRun("task-1");
  expect(storage.getItem("k2b.assistant.taskRunKeys")).toBe("[]");
});

test("a key restored after a reload during a pending start counts as uncertain", () => {
  const storage = createRunKeyStorage();
  const key = createAssistantTaskRunKeys(storage).runKey("task-1");
  // The page reloads before the answer arrives, so no outcome was recorded.
  const reloaded = createAssistantTaskRunKeys(storage);
  expect(reloaded.isUncertain("task-1")).toBe(true);
  // A later conflict cannot prove the first start failed.
  reloaded.settleRun("task-1");
  expect(reloaded.runKey("task-1")).toBe(key);
});

test.each(["invalid JSON", "null", "{}", "42"])("task run keys ignore corrupt storage: %s", (content) => {
  const storage = createRunKeyStorage(content);
  const runKeys = createAssistantTaskRunKeys(storage);
  const key = runKeys.runKey("task-1");
  expect(key).toMatch(/^[a-f0-9]{32}$/);
  expect(runKeys.isUncertain("task-1")).toBe(false);
  expect(createAssistantTaskRunKeys(storage).runKey("task-1")).toBe(key);
});

test("task run keys drop invalid entries while keeping valid stored entries", () => {
  const valid = { taskId: "valid", key: "a".repeat(32), uncertain: true };
  const invalid = [
    null,
    [],
    "wrong shape",
    {},
    { ...valid, taskId: 1 },
    { ...valid, taskId: "missing-key", key: undefined },
    { ...valid, taskId: "short-key", key: "a".repeat(31) },
    { ...valid, taskId: "long-key", key: "a".repeat(33) },
    { ...valid, taskId: "uppercase-key", key: "A".repeat(32) },
    { ...valid, taskId: "non-hex-key", key: "g".repeat(32) },
    { ...valid, taskId: "missing-uncertain", uncertain: undefined },
    { ...valid, taskId: "wrong-uncertain", uncertain: "true" },
  ];
  const storage = createRunKeyStorage(JSON.stringify([...invalid, valid]));
  const runKeys = createAssistantTaskRunKeys(storage);
  expect(runKeys.isUncertain(valid.taskId)).toBe(true);
  expect(runKeys.runKey(valid.taskId)).toBe(valid.key);
  for (const taskId of ["missing-key", "short-key", "long-key", "uppercase-key", "non-hex-key", "missing-uncertain", "wrong-uncertain"]) {
    expect(runKeys.isUncertain(taskId)).toBe(false);
    expect(runKeys.runKey(taskId)).not.toBe(valid.key);
  }
  const entries: unknown = JSON.parse(storage.getItem("k2b.assistant.taskRunKeys") ?? "null");
  expect(entries).toHaveLength(8);
});

test.each(["getItem", "setItem"] as const)("task run keys keep working in memory when storage.%s throws", (method) => {
  const storage = createRunKeyStorage();
  storage[method].mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  const runKeys = createAssistantTaskRunKeys(storage);
  const key = runKeys.runKey("task-1");
  runKeys.runUncertain("task-1");
  expect(runKeys.isUncertain("task-1")).toBe(true);
  runKeys.settleRun("task-1");
  expect(runKeys.runKey("task-1")).toBe(key);
  runKeys.settleRun("task-1", { force: true });
  expect(runKeys.isUncertain("task-1")).toBe(false);
  expect(runKeys.runKey("task-1")).not.toBe(key);
});

test("task run keys stay bounded and evict settled-unknown keys before uncertain ones", () => {
  const storage = createRunKeyStorage();
  const runKeys = createAssistantTaskRunKeys(storage);
  const uncertain = runKeys.runKey("task-0");
  runKeys.runUncertain("task-0");
  const pending = runKeys.runKey("task-1");
  for (let i = 2; i < MAX_PENDING_RUN_KEYS; i++) runKeys.runKey(`task-${i}`);
  runKeys.runKey(`task-${MAX_PENDING_RUN_KEYS}`);
  // The oldest key without an unknown outcome goes first; the uncertain one survives.
  expect(runKeys.runKey("task-0")).toBe(uncertain);
  expect(runKeys.isUncertain("task-0")).toBe(true);
  const entries: unknown = JSON.parse(storage.getItem("k2b.assistant.taskRunKeys") ?? "null");
  expect(entries).toHaveLength(MAX_PENDING_RUN_KEYS);
  const reloaded = createAssistantTaskRunKeys(storage);
  expect(reloaded.runKey("task-0")).toBe(uncertain);
  expect(reloaded.runKey("task-1")).not.toBe(pending);
});

test("task run keys also bound entries loaded from storage", () => {
  const entries = Array.from({ length: MAX_PENDING_RUN_KEYS + 2 }, (_, i) => ({
    taskId: `task-${i}`,
    key: i.toString(16).padStart(32, "0"),
    uncertain: true,
  }));
  const storage = createRunKeyStorage(JSON.stringify(entries));
  const runKeys = createAssistantTaskRunKeys(storage);
  expect(runKeys.isUncertain("task-0")).toBe(false);
  expect(runKeys.isUncertain("task-1")).toBe(false);
  expect(runKeys.isUncertain("task-2")).toBe(true);
  expect(runKeys.runKey(`task-${MAX_PENDING_RUN_KEYS + 1}`)).toBe(entries[MAX_PENDING_RUN_KEYS + 1]!.key);
});

test.each([{}, null, { state: "unknown" }, { state: 1 }, { state: null }])(
  "task starts default invalid response states to queued: %j",
  async (body) => {
    spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
    expect(await assistantApi.runChatTask("task-1", { idempotencyKey: "a".repeat(32) })).toBe("queued");
  },
);

test("task starts default an empty response body to queued", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  expect(await assistantApi.runChatTask("task-1", { idempotencyKey: "a".repeat(32) })).toBe("queued");
});

for (const retryOpening of [1, 2]) {
  for (const [statuses, reusesKey] of [
    [["offline"], true],
    [[500], true],
    [[200], false],
    [[404], false],
    [[409], false],
    [[429], true],
    [[408], true],
    [[400], false],
    [["offline", 429], true],
    [["offline", 408], true],
    [["offline", 409], true],
    [[500, 409], true],
    [[408, 409], false],
    [[429, 409], false],
    [["offline", 404], false],
    [["offline", 200], false],
  ] as const) {
    test(`task start after ${statuses.join(" then ")} uses the correct key in opening ${retryOpening}`, async () => {
      const task = taskFixture(0);
      spyOn(assistantApi, "listChatTasks").mockImplementation(async ({ state }) => (state === "active" ? [task] : []));
      let attempts = 0;
      const post = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async () => {
            const status = statuses[attempts++] ?? 200;
            if (status === "offline") throw new TypeError("Response lost");
            return Response.json({}, { status });
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      );
      const loader = createAssistantCommandSession();
      const input = {
        sessionLoader: loader,
        runKeys: createAssistantTaskRunKeys(),
        models: [],
        chooseModel() {},
        isRunning: () => false,
        query: "",
        scope: "task",
        signal: new AbortController().signal,
        locale: "en",
        projects: [],
        running: false,
        assignProject: async () => {},
      };
      const run = async (session: number) => {
        const rows = await searchCommands({ ...input, session });
        return rows.find((row) => row.id === `task:${task.id}`)!.action!(context);
      };
      const key = (attempt: number) => {
        const [url, init] = post.mock.calls[attempt]!;
        expect(url).toBe(`/api/ai/tasks/${task.id}/run`);
        expect(init?.method).toBe("POST");
        const value = new Headers(init?.headers).get("Idempotency-Key");
        expect(value).toMatch(/^[a-f0-9]{32}$/);
        return value;
      };
      try {
        let previousKey: string | null = null;
        for (const [attempt, status] of statuses.entries()) {
          if (status === 200) await run(attempt === 0 ? 1 : retryOpening);
          else await expect(run(attempt === 0 ? 1 : retryOpening)).rejects.toThrow();
          const currentKey = key(attempt);
          if (previousKey) expect(currentKey).toBe(previousKey);
          previousKey = currentKey;
        }
        await run(retryOpening);
        const retryKey = key(statuses.length);
        if (reusesKey) expect(retryKey).toBe(previousKey);
        else expect(retryKey).not.toBe(previousKey);
        // The successful retry settles the logical start, including a replayed occurrence.
        await run(retryOpening + 1);
        expect(key(statuses.length + 1)).not.toBe(retryKey);
      } finally {
        loader.dispose();
      }
    });
  }
}

test("task start reuses an uncertain key after disposing and remounting the composer session", async () => {
  const task = taskFixture(0);
  spyOn(assistantApi, "listChatTasks").mockImplementation(async ({ state }) => (state === "active" ? [task] : []));
  const post = spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Response lost")).mockResolvedValue(Response.json({}));
  const runKeys = createAssistantTaskRunKeys();
  const input = {
    runKeys,
    session: 1,
    models: [],
    chooseModel() {},
    isRunning: () => false,
    query: "",
    scope: "task",
    signal: new AbortController().signal,
    locale: "en",
    projects: [],
    running: false,
    assignProject: async () => {},
  };
  const run = async (sessionLoader: ReturnType<typeof createAssistantCommandSession>) => {
    const rows = await searchCommands({ ...input, sessionLoader });
    return rows.find((row) => row.id === `task:${task.id}`)!.action!(context);
  };
  const firstSession = createAssistantCommandSession();
  try {
    await expect(run(firstSession)).rejects.toThrow();
  } finally {
    firstSession.dispose();
  }
  const remountedSession = createAssistantCommandSession();
  try {
    await run(remountedSession);
    expect(post).toHaveBeenCalledTimes(2);
    const keys = post.mock.calls.map(([url, init]) => {
      expect(url).toBe(`/api/ai/tasks/${task.id}/run`);
      expect(init?.method).toBe("POST");
      return new Headers(init?.headers).get("Idempotency-Key");
    });
    expect(keys[0]).toMatch(/^[a-f0-9]{32}$/);
    expect(keys[1]).toBe(keys[0]);
  } finally {
    remountedSession.dispose();
  }
});

test("task matches append after thirty references; overview limits tasks independently", async () => {
  const { artifactClient } = await import("../artifacts/client");
  spyOn(artifactClient, "list").mockResolvedValue({ items: [], page: 1, hasNext: false });
  spyOn(assistantApi, "listSkills").mockResolvedValue(Array.from({ length: 40 }, (_, i) => skillFixture(i)));
  spyOn(assistantApi, "listChatTasks").mockImplementation(async ({ state }) =>
    state === "active" ? Array.from({ length: 7 }, (_, i) => taskFixture(i)) : [],
  );
  const loader = createAssistantCommandSession();
  const input = {
    session: 1,
    sessionLoader: loader,
    runKeys: createAssistantTaskRunKeys(),
    models: [],
    chooseModel() {},
    isRunning: () => false,
    query: "",
    signal: new AbortController().signal,
    locale: "de",
    projects: [],
    running: false,
    assignProject: async () => {},
  };
  try {
    const overview = await searchCommands(input);
    expect(overview.filter((row) => row.section === "skills").map((row) => row.id)).toEqual([
      "skill:skill-0",
      "skill:skill-1",
      "skill:skill-2",
      "skill:skill-3",
      "skills-all",
    ]);
    expect(overview.filter((row) => row.id?.startsWith("task:"))).toHaveLength(5);
    const search = await searchCommands({ ...input, query: "Task" });
    expect(search.filter((row) => row.section === "skills")).toHaveLength(30);
    expect(search.filter((row) => row.id?.startsWith("task:"))).toHaveLength(7);
    expect(search.at(-1)?.id).toBe("task:task-0");
    const narrowed = await searchCommands({ ...input, scope: "task", query: "6" });
    expect(narrowed.map((row) => row.id)).toEqual(["task:task-6"]);
  } finally {
    loader.dispose();
  }
});

test.each(["en", "de"])("All Skills lists every enabled Skill from the opening's full catalog (%s)", async (locale) => {
  const { artifactClient } = await import("../artifacts/client");
  spyOn(artifactClient, "list").mockResolvedValue({ items: [], page: 1, hasNext: false });
  const skills = Array.from({ length: 41 }, (_, i) => ({ ...skillFixture(i), enabled: i !== 1 }));
  const listSkills = spyOn(assistantApi, "listSkills").mockResolvedValue(skills);
  const loader = createAssistantCommandSession();
  const input = {
    session: 1,
    sessionLoader: loader,
    runKeys: createAssistantTaskRunKeys(),
    models: [],
    chooseModel() {},
    isRunning: () => false,
    query: "",
    signal: new AbortController().signal,
    locale,
    projects: [],
    running: false,
    assignProject: async () => {},
  };
  try {
    const overview = await searchCommands(input);
    expect(overview.find((row) => row.id === "skills-all")).toMatchObject({
      label: assistantCopyFor(locale).commandAllSkills({ count: 40 }),
      scope: "skill",
    });
    const rows = await searchCommands({ ...input, scope: "skill" });
    expect(rows).toHaveLength(40);
    expect(rows.map((row) => row.id)).toEqual(skills.filter((skill) => skill.enabled).map((skill) => `skill:${skill.id}`));
    expect(listSkills).toHaveBeenCalledTimes(1);
    // Only the full-list request is made: a second argument would send a q parameter.
    expect(listSkills.mock.calls[0]).toHaveLength(1);
  } finally {
    loader.dispose();
  }
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

test("Skills retry preserves task rows", async () => {
  spyOn(assistantApi, "listSkills").mockRejectedValue(new Error("Skills offline"));
  spyOn(assistantApi, "findSkillsByName").mockResolvedValue([
    { ...skillFixture(0), name: "scheduled-tasks", source: { appId: "assistant", appName: "Assistant" } },
  ]);
  spyOn(assistantApi, "listChatTasks").mockImplementation(async ({ state }) => (state === "active" ? [taskFixture(0)] : []));
  const rows = await assistantComposerCommands({
    query: "",
    signal: new AbortController().signal,
    locale: "en",
    projects: [],
    running: false,
    assignProject: async () => {},
  });
  const copy = assistantCopyFor("en");
  expect(rows.filter((row) => row.section === "skills")).toEqual([
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
  expect(rows.some((row) => row.section === "apps")).toBe(false);
  expect(rows.filter((row) => row.section === "tasks").map((row) => row.id)).toEqual(["task-new", "task:task-0"]);
  expect(rows.find((row) => row.id === "task-new")?.mention).toBeDefined();
});

test("model scope shares forgiving matching and runs the injected setter", async () => {
  const loader = createAssistantCommandSession();
  const chosen: string[] = [];
  let running = false;
  const input = {
    session: 1,
    sessionLoader: loader,
    runKeys: createAssistantTaskRunKeys(),
    models: [
      { id: "a", label: "Übersetzer" },
      { id: "b", label: "Beta" },
    ],
    selectedModelId: "a",
    chooseModel: (id: string) => {
      chosen.push(id);
    },
    isRunning: () => running,
    query: "ubersetzer",
    scope: "model",
    signal: new AbortController().signal,
    locale: "de",
    projects: [],
    running: false,
    assignProject: async () => {},
  };
  try {
    const rows = await searchCommands(input);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.selected).toBe(true);
    expect(await rows[0]!.action!(context)).toEqual({ done: "Modell für diesen Chat: Übersetzer" });
    expect(chosen).toEqual(["a"]);
    running = true;
    expect(() => rows[0]!.action!(context)).toThrow(assistantCopyFor("de").commandNeedsIdle);
    expect(chosen).toEqual(["a"]);
    running = false;
    expect(await rows[0]!.action!(context)).toEqual({ done: "Modell für diesen Chat: Übersetzer" });
    expect(chosen).toEqual(["a", "a"]);
    expect((await searchCommands({ ...input, running: true }))[0]?.reason).toBe("Geht, sobald die Antwort fertig ist");
  } finally {
    loader.dispose();
  }
});

test.each(["model", "project", "skill", "file"])("%s scope does not await session discovery for search", async (scope) => {
  const { artifactClient } = await import("../artifacts/client");
  spyOn(artifactClient, "list").mockResolvedValue({ items: [], page: 1, hasNext: false });
  spyOn(assistantApi, "listChatFiles").mockResolvedValue([]);
  const loader = createAssistantCommandSession();
  const load = spyOn(loader, "load").mockReturnValue(new Promise(() => {}));
  try {
    const rows = await searchCommands({
      session: 1,
      sessionLoader: loader,
      runKeys: createAssistantTaskRunKeys(),
      query: scope === "skill" ? "invoice" : "",
      scope,
      signal: new AbortController().signal,
      locale: "en",
      conversationId: "chat",
      projects: [project],
      models: [{ id: "a", label: "Alpha" }],
      chooseModel() {},
      isRunning: () => false,
      running: false,
      assignProject: async () => {},
    });
    expect(rows.map((row) => row.id)).toEqual(scope === "model" ? ["model:a"] : scope === "project" ? [`project:${project.id}`] : []);
    expect(load).not.toHaveBeenCalled();
    expect(assistantApi.findSkillsByName).not.toHaveBeenCalled();
    expect(assistantApi.listChatTasks).not.toHaveBeenCalled();
  } finally {
    loader.dispose();
  }
});

test("schedule helpers retain dialog wording and provide localized inline schedules", async () => {
  const { dates } = await import("@k2b/stdlib");
  const { assistantTaskTitle, formatAssistantTaskSchedule, formatAssistantTaskScheduleInline } = await import("./scheduled-task-format");
  setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
  try {
    const task = taskFixture(0);
    expect(assistantTaskTitle(task)).toBe("Task 0");
    for (const [cron, de, en, dialogDe] of [
      ["0 7 * * *", "täglich 07:00", "daily 07:00", "Täglich 07:00"],
      ["0 8 * * 1", "montags 08:00", "Mondays 08:00", "Immer montags 08:00"],
      ["0 8 * * 1-5", "Montag bis Freitag 08:00", "Monday to Friday 08:00", "Immer montag–freitag 08:00"],
      ["*/5 * * * *", "wiederkehrend", "recurring", "Wiederkehrend"],
    ] as const) {
      const scheduled = { ...task, schedule: { kind: "cron" as const, cron: cron! } };
      expect(formatAssistantTaskScheduleInline(scheduled, "de")).toBe(de);
      expect(formatAssistantTaskScheduleInline(scheduled, "en")).toBe(en);
      expect(formatAssistantTaskSchedule(scheduled, "de")).toBe(dialogDe);
    }
    const runAt = "2026-10-11T07:00:00.000Z";
    const once = { ...task, schedule: { kind: "once" as const, runAt } };
    for (const locale of ["en", "de"]) {
      expect(formatAssistantTaskScheduleInline(once, locale)).toBe(
        `${locale === "de" ? "am" : "on"} ${dates.formatDateTime(runAt, { locale, timeZone: "UTC" })}`,
      );
      expect(formatAssistantTaskSchedule(once, locale)).toBe(locale === "de" ? "Einmalig" : "One-time");
    }
  } finally {
    setSystemTime();
  }
});

test("the empty Skill scope shows the full list while task discovery is still pending", async () => {
  const skill = { ...skillFixture(0), enabled: true };
  spyOn(assistantApi, "listSkills").mockResolvedValue([skill]);
  spyOn(assistantApi, "listChatTasks").mockImplementation(() => new Promise(() => {}));
  const rows = await assistantComposerCommands({
    query: "",
    scope: "skill",
    signal: new AbortController().signal,
    locale: "en",
    projects: [],
    running: false,
    assignProject: async () => {},
  });
  expect(rows.map((row) => row.label)).toEqual([skill.name]);
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
    tags: [],
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
  expect(running.scopes.find((scope) => scope.words.includes("app"))?.title).toBe("Studio-Apps aus Assistent");
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
        ref: { type: "assistant.app", id: "App1" },
        title: "Plan",
        appId: "assistant",
        appName: "Assistant",
        appIcon: "ti ti-sparkles",
        href: "/assistant/apps/App1",
        readable: true,
      };
      let partCount = 14;
      const tracked: Promise<unknown>[] = [];
      const rows = assistantInsertCommands({
        copy: assistantCopyFor("de"),
        locale: "de",
        tags: [],
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
