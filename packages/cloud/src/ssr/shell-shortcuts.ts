import type { platformMessages } from "./platform-messages";

export const SHELL_SHORTCUT_ORDER = ["cloud.search", "cloud.help"] as const;
/** The shell's always-present shortcuts, without their actions; ShellRuntime adds the actions, Help renders them before the browser reports commands. */
export const shellShortcuts = (t: ReturnType<typeof platformMessages.resolve>["t"]) => [
  { id: "cloud.search", title: t.openGlobalSearch, description: t.globalSearchDescription, icon: "ti ti-search", shortcut: "mod+k" },
  { id: "cloud.help", title: t.openShortcutHelp, description: t.shortcutHelpDescription, icon: "ti ti-help-circle", shortcut: "shift+/" },
];
