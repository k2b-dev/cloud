import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { AppWorkspace, SpotlightButton, type SpotlightButtonVariant, useLocale } from "@k2b/ui";
import { createEffect, onCleanup } from "solid-js";
import { createToolSearch, toolSearchMessages } from "./tool-search";

export { toolSearchMessages } from "./tool-search";

type Props = { variant?: SpotlightButtonVariant; registerCommand?: boolean };
export default function ToolSearchButton(props: Props) {
  const locale = useLocale();
  const t = () => toolSearchMessages.resolve([locale()]).t;
  const openSearch = createToolSearch();
  createEffect(() => {
    if (!props.registerCommand) return;
    onCleanup(
      registerContextAwareCommand({
        id: "tools.search",
        title: t().searchTools,
        description: t().searchTools,
        icon: "ti ti-search",
        shortcut: "mod+shift+k",
        action: openSearch,
      }),
    );
  });

  if (props.variant === "icon") {
    return <AppWorkspace.SidebarIconAction icon="ti ti-search" label={t().searchTools} onClick={() => void openSearch()} />;
  }

  return (
    <SpotlightButton
      variant={props.variant}
      label={t().searchToolsLabel}
      onClick={openSearch}
      title={t().searchTools}
      ariaLabel={t().searchTools}
    />
  );
}
