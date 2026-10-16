import { afterAll, afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiChatTaskView, AiProject, AiSkillSummary } from "@k2b/cloud/ai";
import { createConfig } from "@k2b/ssr";

const root = mkdtempSync(join(tmpdir(), "assistant-slash-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { assistantCopyFor } = await import("./ui-copy");
const { assistantApi } = await import("../api/client");
const {
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
  spyOn(assistantApi, "listChatTasks").mockResolvedValue([]);
});
afterEach(() => {
  mock.restore();
  setSystemTime();
});
const assistantComposerCommands = (
  input: Omit<Parameters<typeof searchCommands>[0], "session" | "sessionLoader" | "models" | "chooseModel" | "isRunning">,
) =>
  searchCommands({
    session: 1,
    sessionLoader: createAssistantCommandSession(),
    models: [],
    chooseModel() {},
    isRunning: () => false,
    ...input,
  });
const assistantBuiltInCommands = (input: Omit<Parameters<typeof builtInCommands>[0], "models" | "searchChat">) =>
  builtInCommands({ models: [{ id: "model", label: "Current" }], searchChat() {}, ...input });
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

test("sections and bilingual scope words agree, with each locale's narrowing word first", async () => {
  const { resolveChatCommandScope, chatCommandListModel } = await import("../../../ui/src/chat/command-search");
  for (const locale of ["en", "de"]) {
    const copy = assistantCopyFor(locale);
    const scopes = assistantCommandScopes(copy, locale);
    expect(assistantCommandSections(copy).map((section) => section.id)).toEqual(["skills", "files", "apps", "chat", "tasks"]);
    expect(assistantCommandSections(copy).map((section) => Boolean(section.searched))).toEqual([true, true, true, false, true]);
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
      locale === "de" ? ["skill", "datei", "projekt", "app", "modell", "routine"] : ["skill", "file", "project", "app", "model", "routine"],
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

test("model scope shares forgiving matching and runs the injected setter", async () => {
  const loader = createAssistantCommandSession();
  const chosen: string[] = [];
  let running = false;
  const input = {
    session: 1,
    sessionLoader: loader,
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

test.each(["model", "project", "skill", "file", "app"])("%s scope does not call or await session discovery", async (scope) => {
  const { artifactClient } = await import("../artifacts/client");
  spyOn(artifactClient, "list").mockResolvedValue({ items: [], page: 1, hasNext: false });
  spyOn(assistantApi, "listChatFiles").mockResolvedValue([]);
  const loader = createAssistantCommandSession();
  const load = spyOn(loader, "load").mockReturnValue(new Promise(() => {}));
  try {
    const rows = await searchCommands({
      session: 1,
      sessionLoader: loader,
      query: "",
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
