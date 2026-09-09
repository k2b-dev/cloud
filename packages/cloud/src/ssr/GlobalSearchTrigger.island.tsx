import { hotkeys } from "@k2b/stdlib/solid";
import { IconButton, Tooltip, useLocale } from "@k2b/ui";
import { openGlobalSearchDialog } from "./GlobalSearchDialog";
import type { GlobalSearchHelpApp } from "./GlobalSearchHelpDialog";
import { platformMessages } from "./platform-messages";

type GlobalSearchTriggerProps = {
  variant: "header" | "rail";
  class?: string;
  registerHotkey?: boolean;
  searchHelpApps?: GlobalSearchHelpApp[];
};

/** Opens the spotlight-style global search dialog from nav/header trigger points. */
export default function GlobalSearchTrigger(props: GlobalSearchTriggerProps) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const searchHelpApps = props.searchHelpApps ?? [];

  if (props.registerHotkey) {
    hotkeys.create(() => ({
      "mod+k": {
        label: t().openGlobalSearch,
        desc: t().globalSearchDescription,
        run: () => openGlobalSearchDialog(searchHelpApps),
      },
    }));
  }

  if (props.variant === "rail")
    return (
      <Tooltip.Trigger
        type="button"
        class={`rail-item text-blue-500 hover:bg-blue-500/10 hover:text-blue-600 dark:text-blue-400 dark:hover:bg-blue-500/15 dark:hover:text-blue-300 ${props.class ?? ""}`}
        onClick={() => openGlobalSearchDialog(searchHelpApps)}
        aria-label={t().openGlobalSearch}
        placement="right"
        delay={0}
        content={t().searchShortcut}
      >
        <i class="ti ti-search text-base" />
      </Tooltip.Trigger>
    );

  return (
    <IconButton
      class={props.class}
      onClick={() => openGlobalSearchDialog(searchHelpApps)}
      label={t().openGlobalSearch}
      title={t().searchShortcut}
    >
      <i class="ti ti-search text-base" />
    </IconButton>
  );
}
