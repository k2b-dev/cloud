import type { platformMessages } from "./platform-messages";

export const SHELL_SHORTCUT_ORDER = ["cloud.search", "cloud.help", "cloud.panel"] as const;
/** The shell's always-present shortcuts, without their actions; ShellRuntime adds the actions, Help renders them before the browser reports commands. */
export const shellShortcuts = (t: ReturnType<typeof platformMessages.resolve>["t"], options: { panel?: boolean } = {}) => [
  { id: "cloud.search", title: t.openGlobalSearch, description: t.globalSearchDescription, icon: "ti ti-search", shortcut: "mod+k" },
  { id: "cloud.help", title: t.openShortcutHelp, description: t.shortcutHelpDescription, icon: "ti ti-help-circle", shortcut: "shift+/" },
  ...(options.panel
    ? [
        {
          id: "cloud.panel",
          title: t.togglePanel,
          description: t.togglePanelDescription,
          icon: "ti ti-layout-sidebar-right",
          shortcut: "mod+j",
        },
      ]
    : []),
];
