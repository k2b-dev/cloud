import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { createEffect, onCleanup } from "solid-js";
import { AppWorkspace, SpotlightButton, type SpotlightButtonVariant } from "@k2b/ui";
import { useSpaceMessages } from "../../messages";

type Props = {
  spaceId: string;
  spaceName: string;
  variant?: SpotlightButtonVariant;
  registerCommand?: boolean;
};

export function createSpaceSearch(props: Props) {
  return () =>
    openGlobalSearch({ scope: { ref: { type: "spaces.space", id: props.spaceId }, label: props.spaceName, icon: "ti ti-layout-kanban" } });
}

export default function SearchButton(props: Props) {
  const t = useSpaceMessages();
  const openSearch = createSpaceSearch(props);
  createEffect(() => {
    if (props.registerCommand)
      onCleanup(
        registerContextAwareCommand({
          id: "spaces.search",
          title: t.searchItemsCommand,
          description: props.spaceName,
          icon: "ti ti-search",
          shortcut: "mod+shift+k",
          action: openSearch,
        }),
      );
  });

  if (props.variant === "icon") {
    return <AppWorkspace.SidebarIconAction icon="ti ti-search" label={t.searchItems} onClick={() => void openSearch()} />;
  }

  return (
    <SpotlightButton
      variant={props.variant}
      label={t.searchItemsLabel}
      onClick={openSearch}
      title={t.searchItems}
      ariaLabel={t.searchItems}
    />
  );
}
