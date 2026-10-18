import { describe, expect, test } from "bun:test";
import { HELP_START_TILE_LIMIT, HELP_VIEW_LIMIT, type HelpStartTopic, helpShortcutGroups, helpStart } from "./layout-help-start";
import { platformMessages } from "./platform-messages";
import { SHELL_SHORTCUT_ORDER, shellShortcuts } from "./shell-shortcuts";

const ids = (topics: { id: string }[]) => topics.map((topic) => topic.id);

describe("helpStart", () => {
  test("sorts only tasks into eight tiles and keeps the overflow reachable", () => {
    const topics: HelpStartTopic[] = [
      { id: "reference", title: "Reference", kind: "reference", order: 0 },
      { id: "z", title: "Zulu" },
      ...Array.from({ length: 9 }, (_, i) => ({ id: `task-${i}`, title: `Task ${i}`, kind: "task" as const, order: 10 - i })),
      { id: "a", title: "Alpha", order: 100 },
    ];
    const original = [...topics];
    const start = helpStart(topics);
    expect(HELP_START_TILE_LIMIT).toBe(8);
    expect(ids(start.tiles)).toEqual([8, 7, 6, 5, 4, 3, 2, 1].map((i) => `task-${i}`));
    expect(ids(start.moreTasks)).toEqual(["task-0", "a", "z"]);
    expect(topics).toEqual(original);
  });

  test("lists non-task groups in fixed order, sorted by order then title, without empty groups", () => {
    const topics: HelpStartTopic[] = [
      { id: "fix", title: "Fix", kind: "troubleshoot" },
      { id: "z", title: "Zulu", kind: "start" },
      { id: "lookup", title: "Lookup", kind: "reference" },
      { id: "a", title: "Alpha", kind: "start" },
      { id: "first", title: "First", kind: "start", order: 1 },
    ];
    expect(helpStart(topics).groups.map((group) => [group.kind, ids(group.topics)])).toEqual([
      ["start", ["first", "a", "z"]],
      ["reference", ["lookup"]],
      ["troubleshoot", ["fix"]],
    ]);
    expect(helpStart(topics.slice(0, 1)).groups.map((group) => group.kind)).toEqual(["troubleshoot"]);
    expect(helpStart([])).toEqual({ view: [], tiles: [], moreTasks: [], groups: [] });
  });

  test("keeps known view ids in declared order, deduplicates and caps at three without removing articles elsewhere", () => {
    const topics: HelpStartTopic[] = ["a", "b", "c", "d"].map((id) => ({ id, title: id }));
    const start = helpStart(topics, ["unknown", "c", "c", "a", "missing", "d", "b"]);
    expect(HELP_VIEW_LIMIT).toBe(3);
    expect(ids(start.view)).toEqual(["c", "a", "d"]);
    expect(ids(start.tiles)).toEqual(["a", "b", "c", "d"]);
    const reference = { id: "ref", title: "Reference", kind: "reference" as const };
    const grouped = helpStart([reference], ["ref"]);
    expect(grouped.view).toEqual([reference]);
    expect(grouped.groups[0]?.topics).toEqual([reference]);
  });
});

test("shortcut groups put stable shell rows first, respect selection scope and drop commands without shortcuts", () => {
  const commands = [
    { id: "app.none", title: "No shortcut" },
    { id: "cloud.shell.focus", title: "Focus", shortcut: "mod+\\" },
    { id: "app.open", title: "Open", shortcut: "o", scope: "page" as const },
    { id: "cloud.selection", title: "Selection", shortcut: "s", scope: "selection" as const },
    { id: "cloud.help", title: "Help", shortcut: "shift+/" },
    { id: "cloud.search", title: "Search", shortcut: "mod+k" },
    { id: "cloud.other", title: "Other", shortcut: "x" },
    { id: "app.edit", title: "Edit", shortcut: "e" },
    { id: "app.delete", title: "Delete", shortcut: "del", scope: "selection" as const },
    { id: "app.empty", title: "Empty", shortcut: "" },
  ];
  expect(helpShortcutGroups(commands).map((group) => [group.scope, ids(group.shortcuts)])).toEqual([
    ["everywhere", ["cloud.search", "cloud.help", "cloud.shell.focus", "cloud.other"]],
    ["app", ["app.open", "app.edit"]],
    ["selection", ["cloud.selection", "app.delete"]],
  ]);
  expect(helpShortcutGroups(commands.slice(2, 3)).map((group) => group.scope)).toEqual(["app"]);
  expect(helpShortcutGroups([])).toEqual([]);
});

test("shell shortcuts share localized labels and stable ids without actions", () => {
  for (const locale of ["en", "de"]) {
    const { t } = platformMessages.resolve([locale]);
    const shortcuts = shellShortcuts(t, { panel: true });
    expect(shortcuts.map((command) => command.id)).toEqual([...SHELL_SHORTCUT_ORDER]);
    expect(shortcuts.map((command) => command.shortcut)).toEqual(["mod+k", "shift+/", "mod+j"]);
    expect(shortcuts.map((command) => command.title)).toEqual([t.openGlobalSearch, t.openShortcutHelp, t.togglePanel]);
    for (const command of shortcuts) expect(command).not.toHaveProperty("action");
    // Pages without a panel slot list no panel shortcut.
    expect(shellShortcuts(t).map((command) => command.id)).toEqual(["cloud.search", "cloud.help"]);
  }
});
