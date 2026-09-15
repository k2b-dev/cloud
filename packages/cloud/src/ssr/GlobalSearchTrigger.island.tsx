import { hotkeys } from "@k2b/stdlib/solid";
import { IconButton, Tooltip, useLocale } from "@k2b/ui";
import type { NavigationSearchItem } from "../browser/navigation-search";
import { openGlobalSearchDialog } from "./GlobalSearchDialog";
import { platformMessages } from "./platform-messages";

type GlobalSearchTriggerProps = {
  variant: "header" | "rail";
  class?: string;
  registerHotkey?: boolean;
  searchLinks?: NavigationSearchItem[];
};

/** Opens the spotlight-style global search dialog from nav/header trigger points. */
export default function GlobalSearchTrigger(props: GlobalSearchTriggerProps) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;

  if (props.registerHotkey) {
    hotkeys.create(() => ({
      "mod+k": {
        label: t().openGlobalSearch,
        desc: t().globalSearchDescription,
        run: () => openGlobalSearchDialog(props.searchLinks),
      },
    }));
  }

  if (props.variant === "rail")
    return (
      <Tooltip.Trigger
        type="button"
        class={`rail-item text-blue-500 hover:bg-blue-500/10 hover:text-blue-600 dark:text-blue-400 dark:hover:bg-blue-500/15 dark:hover:text-blue-300 ${props.class ?? ""}`}
        onClick={() => openGlobalSearchDialog(props.searchLinks)}
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
      onClick={() => openGlobalSearchDialog(props.searchLinks)}
      label={t().openGlobalSearch}
      title={t().searchShortcut}
    >
      <i class="ti ti-search text-base" />
    </IconButton>
  );
}
