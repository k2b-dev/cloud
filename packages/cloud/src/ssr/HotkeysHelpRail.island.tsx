import { hotkeys } from "@k2b/stdlib/solid";
import { IconButton, useLocale } from "@k2b/ui";
import type { GlobalSearchHelpApp } from "./GlobalSearchHelpDialog";
import { openLayoutHelpDialog } from "./LayoutHelp";
import { platformMessages } from "./platform-messages";

type HotkeysHelpTriggerProps = {
  variant: "header" | "rail";
  class?: string;
  registerHotkey?: boolean;
  searchHelpApps?: GlobalSearchHelpApp[];
  accent?: string;
};

/** Opens end-user help from either the desktop rail or the compact header. */
export default function HotkeysHelpRail(props: HotkeysHelpTriggerProps) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const searchHelpApps = props.searchHelpApps ?? [];

  const openHelp = () => {
    openLayoutHelpDialog(searchHelpApps, props.accent);
  };

  if (props.registerHotkey) {
    hotkeys.create(() => ({
      "shift+/": {
        label: t().openShortcutHelp,
        desc: t().shortcutHelpDescription,
        run: openHelp,
      },
    }));
  }

  if (props.variant === "rail")
    return (
      <button
        type="button"
        class={`rail-item text-blue-500 hover:bg-blue-500/10 hover:text-blue-600 dark:text-blue-400 dark:hover:bg-blue-500/15 dark:hover:text-blue-300 ${props.class ?? ""}`}
        onClick={openHelp}
        aria-label={t().openHelp}
        title={t().helpShortcut}
      >
        <i class="ti ti-help-circle text-base" />
      </button>
    );

  return (
    <IconButton class={props.class} onClick={openHelp} label={t().openHelp} title={t().helpShortcut}>
      <i class="ti ti-help-circle text-base" />
    </IconButton>
  );
}
