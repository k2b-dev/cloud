import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { AppWorkspace, SpotlightButton, type SpotlightButtonVariant, useLocale } from "@k2b/ui";
import { createEffect, onCleanup } from "solid-js";
import { spaceCommandMessages } from "../../../../commands";
import { useSpaceMessages } from "../../messages";

type Props = {
  spaceId: string;
  spaceName: string;
  variant?: SpotlightButtonVariant;
  registerCommand?: boolean;
};

const spaceSearchOptions = (props: Props) => ({
  scope: { ref: { type: "spaces.space", id: props.spaceId }, label: props.spaceName, icon: "ti ti-layout-kanban" },
});
export function createSpaceSearch(props: Props) {
  return () => openGlobalSearch(spaceSearchOptions(props));
}

export default function SearchButton(props: Props) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const openSearch = createSpaceSearch(props);
  createEffect(() => {
    if (props.registerCommand)
      onCleanup(
        registerContextAwareCommand({
          id: "spaces.search",
          title: t.searchItemsCommand,
          description: spaceCommandMessages.resolve([locale()]).t.searchDescription({ name: props.spaceName }),
          icon: "ti ti-search",
          shortcut: "mod+shift+k",
          action: { search: spaceSearchOptions(props) },
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
