import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { SpotlightButton, type SpotlightButtonVariant, useLocale } from "@k2b/ui";
import { createEffect, onCleanup } from "solid-js";
import { useAccountsMessages } from "./messages";
import { createAccountsSearch, accountsSearchOptions } from "./accounts-search";

import { accountsSearchMessages } from "../search-messages";

type Props = { isAdmin: boolean; variant?: SpotlightButtonVariant; registerCommand?: boolean };
export default function AccountsSearchButton(props: Props) {
  const locale = useLocale();
  const messages = useAccountsMessages();
  const openSearch = createAccountsSearch();
  createEffect(() => {
    if (!props.registerCommand) return;
    onCleanup(
      registerContextAwareCommand({
        id: "accounts.search",
        title: messages().searchAccounts,
        description: props.isAdmin
          ? accountsSearchMessages.resolve([locale()]).t.description
          : accountsSearchMessages.resolve([locale()]).t.groups,
        icon: "ti ti-search",
        shortcut: "mod+shift+k",
        action: { search: accountsSearchOptions(locale()) },
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
