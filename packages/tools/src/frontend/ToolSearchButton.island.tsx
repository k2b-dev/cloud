import {
  AppWorkspace,
  isSpotlightShortcut,
  SPOTLIGHT_SHORTCUT_TITLE,
  SpotlightButton,
  type SpotlightButtonVariant,
  useLocale,
} from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { createToolSearch, toolSearchMessages } from "./tool-search";
export { toolSearchMessages } from "./tool-search";
type Props = { variant?: SpotlightButtonVariant; registerShortcut?: boolean };
export default function ToolSearchButton(props: Props) {
  const locale = useLocale();
  const t = () => toolSearchMessages.resolve([locale()]).t;
  const openSearch = createToolSearch();
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

  if (props.variant === "icon") {
    return <AppWorkspace.SidebarIconAction icon="ti ti-search" label={t().searchTools} onClick={() => void openSearch()} />;
  }

  return (
    <SpotlightButton
      variant={props.variant}
      label={t().searchToolsLabel}
      onClick={openSearch}
      title={t().searchToolsWithShortcut({ shortcut: SPOTLIGHT_SHORTCUT_TITLE })}
      ariaLabel={t().searchTools}
    />
  );
}
