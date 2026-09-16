import { hotkeys } from "@k2b/stdlib/solid";
import { IconButton, Tooltip, useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import type { NavigationSearchItem } from "../browser/navigation-search";
import { openGlobalSearch } from "../browser/search";
import { registerGlobalSearchHost } from "../browser/search-bridge";
import { createGlobalSearchHost } from "./GlobalSearchDialog";
import { platformMessages } from "./platform-messages";

type GlobalSearchTriggerProps = {
  variant: "header" | "rail" | "host";
  class?: string;
  registerHotkey?: boolean;
  searchLinks?: NavigationSearchItem[];
  searchResources?: boolean;
};

/** Opens the spotlight-style global search dialog from nav/header trigger points. */
export default function GlobalSearchTrigger(props: GlobalSearchTriggerProps) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;

  if (props.registerHotkey) {
    const host = createGlobalSearchHost(() => props.searchLinks ?? [], props.searchResources);
    onMount(() => {
      onCleanup(registerGlobalSearchHost(host.open, host.dispose));
    });
    hotkeys.create(() => ({
      "mod+k": {
        label: t().openGlobalSearch,
        desc: t().globalSearchDescription,
        run: () => openGlobalSearch(),
      },
    }));
  }

  if (props.variant === "host") return null;

  if (props.variant === "rail")
    return (
      <Tooltip.Trigger
        type="button"
        class={`rail-item text-blue-500 hover:bg-blue-500/10 hover:text-blue-600 dark:text-blue-400 dark:hover:bg-blue-500/15 dark:hover:text-blue-300 ${props.class ?? ""}`}
        onClick={() => openGlobalSearch()}
        aria-label={t().openGlobalSearch}
        placement="right"
        delay={0}
        content={t().searchShortcut}
      >
        <i class="ti ti-search text-base" />
      </Tooltip.Trigger>
    );

  return (
    <IconButton class={props.class} onClick={() => openGlobalSearch()} label={t().openGlobalSearch} title={t().searchShortcut}>
      <i class="ti ti-search text-base" />
    </IconButton>
  );
}
