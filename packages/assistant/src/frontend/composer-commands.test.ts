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
const { assistantBuiltInCommands, assistantComposerCommands } = await import("./composer-commands");

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

test("Project slash selection assigns once and disappears for an assigned chat", async () => {
  const assigned: string[] = [];
  const input = {
    query: "project inv",
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
  expect(await assistantComposerCommands({ ...input, projectId: project.id })).toEqual([]);
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
    query: "skill invioces",
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
    query: "file report",
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
    query: "project inv",
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
      locale === "de" ? ["Chat kompaktieren", "Chat abzweigen", "Neuer Chat"] : ["Compact chat", "Fork chat", "New chat"],
    );
    expect(commands.map((command) => command.id)).toEqual(["compact", "fork", "new"]);
    expect(commands.map((command) => command.name)).toEqual(["compact", "fork", "new"]);
    expect(commands.map((command) => command.keywords)).toEqual([
      ["compact", "kompaktieren", "kontext", "zusammenfassen", "platz"],
      ["fork", "abzweigen", "kopie", "verzweigen", "branch"],
      ["new", "neu", "chat", "leer"],
    ]);
    // Matching itself is tested at the shared composer seam; these words support both /kompakt and /compact.
    for (const query of ["kompakt", "compact"]) expect(commands[0]!.keywords!.some((word) => word.includes(query))).toBe(true);
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
      [{ projectComposer: true, running: true }, [copy.commandNeedsChat, copy.commandNeedsChat]],
      [{ hasMessages: false, hasAssistantMessage: false, running: true }, [copy.commandNeedsMessages, copy.commandNeedsAnswer]],
      [{ hasAssistantMessage: false }, [undefined, copy.commandNeedsAnswer]],
      [{ running: true }, [copy.commandNeedsIdle, copy.commandNeedsIdle]],
      [{}, [undefined, undefined]],
    ] as const) {
      const commands = assistantBuiltInCommands({ ...input, ...state });
      expect(commands.map((command) => command.reason)).toEqual([...reasons, undefined]);
    }
    const commands = assistantBuiltInCommands(input);
    expect(await commands[0]!.action!({ setValue() {}, submit() {}, focus() {} })).toEqual({ done: copy.compactDone });
    expect(await commands[1]!.action!({ setValue() {}, submit() {}, focus() {} })).toEqual({ done: copy.forkDone });
    expect(copy.compactFailed({ reason: "Oops" })).toBe(
      locale === "de"
        ? "Kompaktieren hat nicht geklappt: Oops. Dein Entwurf ist unverändert."
        : "Compacting did not work: Oops. Your draft is unchanged.",
    );
  }
});
