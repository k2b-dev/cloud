import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { createCapabilitySearch } from "./capability-search";
import { SpotlightButton, type SpotlightButtonVariant, useLocale } from "@k2b/ui";
import { createEffect, onCleanup } from "solid-js";
import { capabilityUiMessages } from "./messages";

export type CapabilitySearchEntry = {
  href: string;
  label: string;
  description: string;
  icon: string;
};

type Props = {
  entries: CapabilitySearchEntry[];
  variant?: SpotlightButtonVariant;
  registerCommand?: boolean;
};

export default function CapabilitySearchButton(props: Props) {
  const locale = useLocale();
  const t = () => capabilityUiMessages.resolve([locale()]).t;
  const openSearch = createCapabilitySearch(props);
  createEffect(() => {
    if (!props.registerCommand) return;
    onCleanup(
      registerContextAwareCommand({
        id: "capabilities.search",
        title: t().search,
        description: t().search,
        icon: "ti ti-search",
        shortcut: "mod+shift+k",
        action: openSearch,
      }),
    );
  });

  return (
    <SpotlightButton variant={props.variant ?? "chip"} label={t().search} ariaLabel={t().search} title={t().search} onClick={openSearch} />
  );
}
