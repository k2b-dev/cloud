import {
  AppWorkspace,
  isSpotlightShortcut,
  SPOTLIGHT_SHORTCUT_TITLE,
  SpotlightButton,
  type SpotlightButtonVariant,
  useLocale,
} from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { createContactsSearch, spotlightMessages } from "./contact-spotlight";
export { spotlightMessages } from "./contact-spotlight";
type Props = { variant?: SpotlightButtonVariant; registerShortcut?: boolean };
export default function ContactsSpotlightButton(props: Props) {
  const locale = useLocale();
  const t = () => spotlightMessages.resolve([locale()]).t;
  const openSearch = createContactsSearch();
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
    return (
      <AppWorkspace.SidebarIconAction
        icon="ti ti-search"
        label={t().searchContactsWithShortcut({ shortcut: SPOTLIGHT_SHORTCUT_TITLE })}
        onClick={() => void openSearch()}
      />
    );
  }

  return (
    <SpotlightButton
      variant={props.variant}
      label={t().searchContactsButton}
      onClick={openSearch}
      title={t().searchContactsWithShortcut({ shortcut: SPOTLIGHT_SHORTCUT_TITLE })}
      ariaLabel={t().searchContacts}
    />
  );
}
