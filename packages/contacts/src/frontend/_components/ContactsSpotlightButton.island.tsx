import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { AppWorkspace, SpotlightButton, type SpotlightButtonVariant, useLocale } from "@k2b/ui";
import { createEffect, onCleanup } from "solid-js";
import { contactsSearchOptions, createContactsSearch, spotlightMessages } from "./contact-spotlight";

export { spotlightMessages } from "./contact-spotlight";

type Props = { variant?: SpotlightButtonVariant; registerCommand?: boolean };
export default function ContactsSpotlightButton(props: Props) {
  const locale = useLocale();
  const t = () => spotlightMessages.resolve([locale()]).t;
  const openSearch = createContactsSearch();
  createEffect(() => {
    if (!props.registerCommand) return;
    onCleanup(
      registerContextAwareCommand({
        id: "contacts.search",
        title: t().searchContacts,
        description: t().searchDescription,
        icon: "ti ti-search",
        shortcut: "mod+shift+k",
        action: { search: contactsSearchOptions(locale()) },
      }),
    );
  });

  if (props.variant === "icon") {
    return <AppWorkspace.SidebarIconAction icon="ti ti-search" label={t().searchContacts} onClick={() => void openSearch()} />;
  }

  return (
    <SpotlightButton
      variant={props.variant}
      label={t().searchContactsButton}
      onClick={openSearch}
      title={t().searchContacts}
      ariaLabel={t().searchContacts}
    />
  );
}
