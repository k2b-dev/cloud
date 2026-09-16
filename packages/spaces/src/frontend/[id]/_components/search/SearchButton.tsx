import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { type HotkeyMap, hotkeys } from "@k2b/stdlib/solid";
import { AppWorkspace, SPOTLIGHT_SHORTCUT, SPOTLIGHT_SHORTCUT_TITLE, SpotlightButton, type SpotlightButtonVariant } from "@k2b/ui";
import { useSpaceMessages } from "../../messages";

type Props = {
  spaceId: string;
  spaceName: string;
  variant?: SpotlightButtonVariant;
  registerShortcut?: boolean;
};

export function createSpaceSearch(props: Props) {
  return () =>
    openGlobalSearch({ scope: { ref: { type: "spaces.space", id: props.spaceId }, label: props.spaceName, icon: "ti ti-layout-kanban" } });
}

export default function SearchButton(props: Props) {
  const t = useSpaceMessages();
  const openSearch = createSpaceSearch(props);
  const runSearch = () => {
    if (!document.querySelector("dialog[open]")) void openSearch();
  };
  hotkeys.create(
    (): HotkeyMap =>
      props.registerShortcut
        ? {
            [SPOTLIGHT_SHORTCUT]: {
              label: t.searchItemsCommand,
              desc: t.searchItemsCommandDescription,
              run: runSearch,
            },
            "/": {
              label: t.searchItemsCommand,
              desc: t.searchItemsCommandDescription,
              run: runSearch,
            },
          }
        : {},
  );

  if (props.variant === "icon") {
    return (
      <AppWorkspace.SidebarIconAction
        icon="ti ti-search"
        label={t.searchItemsWithShortcut({ shortcut: `${SPOTLIGHT_SHORTCUT_TITLE} · /` })}
        onClick={() => void openSearch()}
      />
    );
  }

  return (
    <SpotlightButton
      variant={props.variant}
      label={t.searchItemsLabel}
      onClick={openSearch}
      title={t.searchItemsWithShortcut({ shortcut: `${SPOTLIGHT_SHORTCUT_TITLE} · /` })}
      ariaLabel={t.searchItems}
    />
  );
}
