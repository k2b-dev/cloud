import { expect, test } from "bun:test";
import { helpShortcutGroups } from "./layout-help-start";
import { platformMessages } from "./platform-messages";
import { shellShortcuts } from "./shell-shortcuts";

test("Help seeds panel after Search and Help only on pages with a slot", () => {
  for (const locale of ["en", "de"]) {
    const t = platformMessages.resolve([locale]).t;
    expect(shellShortcuts(t).map((command) => command.id)).toEqual(["cloud.search", "cloud.help"]);
    const shortcuts = shellShortcuts(t, { panel: true });
    expect(shortcuts[2]).toMatchObject({
      id: "cloud.panel",
      title: t.togglePanel,
      description: t.togglePanelDescription,
      shortcut: "mod+j",
    });
    expect(helpShortcutGroups([...shortcuts].reverse())[0]?.shortcuts.map((command) => command.id)).toEqual([
      "cloud.search",
      "cloud.help",
      "cloud.panel",
    ]);
  }
});
