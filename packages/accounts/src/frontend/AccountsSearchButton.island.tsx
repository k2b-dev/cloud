import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { SpotlightButton, type SpotlightButtonVariant } from "@k2b/ui";
import { createEffect, onCleanup } from "solid-js";
import { useAccountsMessages } from "./messages";
import { createAccountsSearch } from "./accounts-search";

type Props = { isAdmin: boolean; variant?: SpotlightButtonVariant; registerCommand?: boolean };
export default function AccountsSearchButton(props: Props) {
  const messages = useAccountsMessages();
  const openSearch = createAccountsSearch(props);
  createEffect(() => {
    if (!props.registerCommand) return;
    onCleanup(
      registerContextAwareCommand({
        id: "accounts.search",
        title: messages().searchAccounts,
        description: messages().searchAccounts,
        icon: "ti ti-search",
        shortcut: "mod+shift+k",
        action: openSearch,
      }),
    );
  });

  return (
    <SpotlightButton
      variant={props.variant}
      label={messages().searchAccountsLabel}
      icon="ti ti-search"
      onClick={openSearch}
      title={messages().searchAccounts}
      ariaLabel={messages().searchAccounts}
    />
  );
}
