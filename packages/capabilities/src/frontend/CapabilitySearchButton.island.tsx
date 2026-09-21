import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { SpotlightButton, type SpotlightButtonVariant, useLocale } from "@k2b/ui";
import { createEffect, onCleanup } from "solid-js";
import { capabilitySearchOptions, openCapabilitySearch } from "./capability-search";
import { capabilityUiMessages } from "./messages";

type Props = {
  variant?: SpotlightButtonVariant;
  registerCommand?: boolean;
};

export default function CapabilitySearchButton(props: Props) {
  const locale = useLocale();
  const t = () => capabilityUiMessages.resolve([locale()]).t;
  createEffect(() => {
    if (!props.registerCommand) return;
    onCleanup(
      registerContextAwareCommand({
        id: "capabilities.search",
        title: t().search,
        description: t().searchDescription,
        icon: "ti ti-search",
        shortcut: "mod+shift+k",
        action: { search: capabilitySearchOptions() },
      }),
    );
  });

  return (
    <SpotlightButton
      variant={props.variant ?? "chip"}
      label={t().search}
      ariaLabel={t().search}
      title={t().search}
      onClick={openCapabilitySearch}
    />
  );
}
