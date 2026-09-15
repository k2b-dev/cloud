import { createCapabilitySearch } from "./capability-search";
import { isSpotlightShortcut, SPOTLIGHT_SHORTCUT_TITLE, SpotlightButton, type SpotlightButtonVariant, useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
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
  registerShortcut?: boolean;
};

export default function CapabilitySearchButton(props: Props) {
  const locale = useLocale();
  const t = () => capabilityUiMessages.resolve([locale()]).t;
  const openSearch = createCapabilitySearch(props);
  onMount(() => {
    if (!props.registerShortcut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSpotlightShortcut(event)) return;
      event.preventDefault();
      void openSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return (
    <SpotlightButton
      variant={props.variant ?? "chip"}
      label={t().search}
      ariaLabel={t().search}
      title={`${t().search} (${SPOTLIGHT_SHORTCUT_TITLE})`}
      onClick={openSearch}
    />
  );
}
