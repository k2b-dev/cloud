import { afterEach, expect, mock, test } from "bun:test";
import type { ChatCommandDraft } from "@k2b/ui";
import type { CloudComposerCommand } from "./composer-catalog";

const events: string[] = [];
const openCommand = mock(async (_id: string, _input: unknown, _options: { returnTo?: string }) => {
  events.push("open");
});
mock.module("./commands", () => ({ openCommand }));
const { openComposerCommand, cloudCommandMenu } = await import("./composer-open");
afterEach(() => {
  openCommand.mockReset();
  events.length = 0;
});
const command: CloudComposerCommand = {
  id: "spaces.task.compose",
  appId: "spaces",
  appName: "Spaces",
  appIcon: "ti ti-layout-kanban",
  title: "Neue Aufgabe",
  description: "Eine Aufgabe öffnen.",
  icon: "ti ti-checkbox",
  keywords: ["task", "Aufgabe"],
  input: {},
};
const options = () => ({
  locale: "de",
  before: async () => {
    events.push("save");
  },
  returnTo: () => {
    events.push("returnTo");
    return "/app/assistant?conversation=chat01";
  },
});

test("saves before reading the return path and opening the Command", async () => {
  expect(await openComposerCommand(command, options())).toBeUndefined();
  expect(events).toEqual(["save", "returnTo", "open"]);
  expect(openCommand).toHaveBeenCalledWith(command.id, {}, { returnTo: "/app/assistant?conversation=chat01" });
});

test("propagates the exact save rejection without resolving or opening", async () => {
  const reason = new Error("Conflict");
  const result = openComposerCommand(command, {
    ...options(),
    before: async () => {
      throw reason;
    },
  });
  expect(await result.catch((error: unknown) => error)).toBe(reason);
  expect(events).toEqual([]);
  expect(openCommand).not.toHaveBeenCalled();
});

test("an unavailable app returns a localized row failure", async () => {
  openCommand.mockRejectedValueOnce(new Error("Offline"));
  expect(await openComposerCommand(command, options())).toEqual({
    failed: "Spaces ist gerade nicht erreichbar. Erneut wählen versucht es nochmal.",
  });
});

test("rejects external, malformed, or overlong return paths after saving", async () => {
  for (const path of ["https://elsewhere.example/", "//elsewhere.example/", "/\\evil", "/app/has space", `/${"x".repeat(2001)}`]) {
    await expect(openComposerCommand(command, { ...options(), returnTo: () => path })).rejects.toThrow("Invalid Command return path");
  }
  expect(openCommand).not.toHaveBeenCalled();
});

test("menu rows carry localized presentation and forward the token-free draft", async () => {
  const before = mock(async (_draft: ChatCommandDraft) => {});
  const menu = cloudCommandMenu({ ...options(), commands: [command], state: "ready", section: "apps", before });
  expect(menu.pending).toBe(false);
  expect(menu.commands[0]).toMatchObject({
    id: "cloud-command:spaces.task.compose",
    name: command.id,
    label: "Neue Aufgabe",
    description: "Spaces · Eine Aufgabe öffnen.",
    icon: "ti ti-checkbox",
    app: "Spaces",
    section: "apps",
    keywords: ["Neue Aufgabe", "task", "Aufgabe", "Spaces", "Eine Aufgabe öffnen."],
  });
  const draft = { value: "Plan ", mentions: [] };
  await menu.commands[0]!.open!(draft);
  expect(before).toHaveBeenCalledWith(draft);
});

test("loading reserves the final section and failure offers a persistent explicit retry", () => {
  expect(cloudCommandMenu({ ...options(), commands: [command], state: "loading", section: "apps" })).toEqual({
    commands: [],
    pending: true,
  });
  expect(cloudCommandMenu({ ...options(), commands: [], state: "failed", section: "apps" })).toEqual({
    commands: [
      {
        id: "cloud-commands-retry",
        name: "cloud-commands-retry",
        label: "Befehle aus Apps konnten nicht geladen werden",
        description: "Erneut versuchen",
        icon: "ti ti-alert-circle",
        searchAgain: true,
        persistent: true,
        section: "apps",
      },
    ],
    pending: false,
  });
});
