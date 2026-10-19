import { describe, expect, test } from "bun:test";
import {
  HELP_SHORTCUT_DESCRIPTION_MAX_LENGTH,
  HELP_SHORTCUT_ID_MAX_LENGTH,
  HELP_SHORTCUT_KEYS_MAX_LENGTH,
  HELP_SHORTCUT_TITLE_MAX_LENGTH,
  HELP_START_SHORTCUT_LIMIT,
  HELP_START_TILE_LIMIT,
  HELP_VIEW_LIMIT,
  type HelpStartTopic,
  helpShortcutGroups,
  helpStart,
} from "./layout-help-start";
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

test("shortcut rows are capped across groups in everywhere, app, selection order", () => {
  expect(HELP_START_SHORTCUT_LIMIT).toBe(3 * HELP_START_TILE_LIMIT);
  const commands = Array.from({ length: HELP_START_SHORTCUT_LIMIT }, (_, i) => ({ id: `app.${i}`, title: `Row ${i}`, shortcut: "e" }));
  const shell = { id: "cloud.search", title: "Search", shortcut: "mod+k" };
  const selected = { id: "app.selected", title: "Edit selected", shortcut: "s", scope: "selection" as const };
  const groups = helpShortcutGroups([selected, ...commands, shell]);
  expect(groups.map(({ scope }) => scope)).toEqual(["everywhere", "app"]);
  expect(groups.flatMap(({ shortcuts }) => shortcuts)).toEqual([shell, ...commands.slice(0, HELP_START_SHORTCUT_LIMIT - 1)]);
  const withSelection = helpShortcutGroups([selected, ...commands.slice(0, HELP_START_SHORTCUT_LIMIT - 2), shell]);
  expect(withSelection.map(({ scope }) => scope)).toEqual(["everywhere", "app", "selection"]);
  expect(withSelection.flatMap(({ shortcuts }) => shortcuts)).toHaveLength(HELP_START_SHORTCUT_LIMIT);
  const everywhere = commands.map((command) => ({ ...command, id: `cloud.${command.id}` }));
  expect(helpShortcutGroups([selected, ...everywhere, shell]).flatMap((group) => group.shortcuts)).toEqual([
    shell,
    ...everywhere.slice(0, HELP_START_SHORTCUT_LIMIT - 1),
  ]);
});

test("shortcut bounds drop invalid rows before the cap and accept exact length boundaries", () => {
  const command = { id: "app.edit", title: "Edit", description: "", shortcut: "e" };
  const longest = { ...command, shortcut: "ctrl+alt+shift+meta+mod+TVAudioDescriptionMixDown" };
  expect(longest.shortcut).toHaveLength(HELP_SHORTCUT_KEYS_MAX_LENGTH);
  expect(helpShortcutGroups([longest]).flatMap((g) => g.shortcuts)).toEqual([longest]);
  const limits = [
    ["id", HELP_SHORTCUT_ID_MAX_LENGTH],
    ["title", HELP_SHORTCUT_TITLE_MAX_LENGTH],
    ["description", HELP_SHORTCUT_DESCRIPTION_MAX_LENGTH],
    ["shortcut", HELP_SHORTCUT_KEYS_MAX_LENGTH],
  ] as const;
  for (const [key, limit] of limits) {
    const exact = { ...command, [key]: "x".repeat(limit) };
    expect(helpShortcutGroups([exact]).flatMap((g) => g.shortcuts)).toEqual([exact]);
    expect(helpShortcutGroups([{ ...exact, [key]: "x".repeat(limit + 1) }])).toEqual([]);
  }
  for (const key of ["id", "title", "shortcut"]) expect(helpShortcutGroups([{ ...command, [key]: "" }])).toEqual([]);
  expect(helpShortcutGroups([command]).flatMap((g) => g.shortcuts)).toEqual([command]);
  const oversized = Array.from({ length: HELP_START_SHORTCUT_LIMIT }, () => ({
    ...command,
    title: "t".repeat(HELP_SHORTCUT_TITLE_MAX_LENGTH + 1),
  }));
  expect(helpShortcutGroups([...oversized, command]).flatMap((g) => g.shortcuts)).toEqual([command]);
});
