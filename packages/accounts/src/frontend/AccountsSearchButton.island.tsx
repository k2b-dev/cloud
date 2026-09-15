import { isSpotlightShortcut, SPOTLIGHT_SHORTCUT_TITLE, SpotlightButton, type SpotlightButtonVariant } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { useAccountsMessages } from "./messages";
import { createAccountsSearch } from "./accounts-search";

type Props = { isAdmin: boolean; variant?: SpotlightButtonVariant; registerShortcut?: boolean };
export default function AccountsSearchButton(props: Props) {
  const messages = useAccountsMessages();
  const openSearch = createAccountsSearch(props);
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
      variant={props.variant}
      label={messages().searchAccountsLabel}
      icon="ti ti-search"
      onClick={openSearch}
      title={`${messages().searchAccounts} (${SPOTLIGHT_SHORTCUT_TITLE})`}
      ariaLabel={messages().searchAccounts}
    />
  );
}
