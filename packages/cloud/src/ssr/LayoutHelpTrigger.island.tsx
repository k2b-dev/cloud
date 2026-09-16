import { registerContextAwareCommand } from "../browser/commands";
import { createEffect, onCleanup } from "solid-js";
import { IconButton, Tooltip, useLocale } from "@k2b/ui";
import type { GlobalSearchHelpApp } from "./GlobalSearchHelpDialog";
import { openLayoutHelpDialog } from "./LayoutHelp";
import { platformMessages } from "./platform-messages";

type LayoutHelpTriggerProps = {
  variant: "header" | "rail";
  class?: string;
  registerCommand?: boolean;
  searchHelpApps?: GlobalSearchHelpApp[];
  accent?: string;
};

/** Opens end-user help from either the desktop rail or the compact header. */
export default function LayoutHelpTrigger(props: LayoutHelpTriggerProps) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const searchHelpApps = props.searchHelpApps ?? [];

  const openHelp = () => {
    openLayoutHelpDialog(searchHelpApps, props.accent);
  };

  if (props.registerCommand) {
    createEffect(() =>
      onCleanup(
        registerContextAwareCommand({
          id: "cloud.help",
          title: t().openShortcutHelp,
          description: t().shortcutHelpDescription,
          icon: "ti ti-help-circle",
          shortcut: "shift+/",
          action: openHelp,
        }),
      ),
    );
  }

  if (props.variant === "rail")
    return (
      <Tooltip.Trigger
        type="button"
        class={`rail-item text-blue-500 hover:bg-blue-500/10 hover:text-blue-600 dark:text-blue-400 dark:hover:bg-blue-500/15 dark:hover:text-blue-300 ${props.class ?? ""}`}
        onClick={openHelp}
        aria-label={t().openHelp}
        placement="right"
        delay={0}
        content={t().helpShortcut}
      >
        <i class="ti ti-help-circle text-base" />
      </Tooltip.Trigger>
    );

  return (
    <IconButton class={props.class} onClick={openHelp} label={t().openHelp} title={t().helpShortcut}>
      <i class="ti ti-help-circle text-base" />
    </IconButton>
  );
}
