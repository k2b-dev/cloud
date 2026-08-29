import { navigateTo } from "@k2b/ssr/nav";
import { isSpotlightShortcut, openSpotlightSearch, SPOTLIGHT_SHORTCUT_TITLE, SpotlightButton, type SpotlightButtonVariant } from "@k2b/ui";
import { apiClient as coreClient } from "@valentinkolb/cloud/clients/core";
import type { EntityKind, EntityListItem } from "@valentinkolb/cloud/contracts";
import { onCleanup, onMount } from "solid-js";
import { useAccountsMessages } from "./messages";

type Props = {
  isAdmin: boolean;
  variant?: SpotlightButtonVariant;
  registerShortcut?: boolean;
};

const PAGE_SIZE = 20;

const entityLabel = (item: EntityListItem): string => {
  switch (item.kind) {
    case "user":
      return item.user.displayName || item.user.mail || item.user.uid;
    case "group":
      return item.group.name;
    case "service_account":
      return item.serviceAccount.name;
  }
};

const entityDescription = (item: EntityListItem, messages: ReturnType<ReturnType<typeof useAccountsMessages>>): string => {
  switch (item.kind) {
    case "user":
      return [item.user.uid, item.user.mail, item.user.provider, item.user.profile].filter(Boolean).join(" - ");
    case "group":
      return [item.group.description || messages.group, item.group.provider].join(" - ");
    case "service_account":
      return [
        item.serviceAccount.kind === "user_delegated" ? messages.userBoundServiceAccount : messages.resourceBoundServiceAccount,
        item.serviceAccount.status,
      ].join(" - ");
  }
};

const entityIcon = (item: EntityListItem): string => {
  switch (item.kind) {
    case "user":
      return "ti ti-user";
    case "group":
      return "ti ti-users-group";
    case "service_account":
      return "ti ti-user-key";
  }
};

const entityHref = (item: EntityListItem): string => {
  switch (item.kind) {
    case "user":
      return `/app/accounts/users/${item.user.id}`;
    case "group":
      return `/app/accounts/groups/${item.group.id}`;
    case "service_account":
      return `/app/accounts/service-accounts?search=${encodeURIComponent(item.serviceAccount.name)}`;
  }
};

const searchKinds = (isAdmin: boolean): EntityKind[] => (isAdmin ? ["user", "group", "service_account"] : ["group"]);

export default function AccountsSearchButton(props: Props) {
  const messages = useAccountsMessages();
  const openSearch = async () => {
    const m = messages();
    const kinds = searchKinds(props.isAdmin);
    const selected = await openSpotlightSearch<EntityListItem>({
      title: m.searchAccounts,
      icon: "ti ti-users-group",
      placeholder: props.isAdmin ? m.searchAllPlaceholder : m.searchGroupsPlaceholder,
      minQueryLength: 1,
      noResultsText: m.noAccountsFound,
      resolve: async ({ query, abortSignal }) => {
        const trimmed = query.trim();
        if (!trimmed) return [];

        const response = await coreClient.accounts.entities.$get(
          {
            query: {
              search: trimmed,
              kinds: kinds.join(","),
              per_page: String(PAGE_SIZE),
            },
          },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) return [];

        const payload = await response.json();
        return payload.items.map((item) => ({
          value: item,
          label: entityLabel(item),
          desc: entityDescription(item, m),
          icon: entityIcon(item),
        }));
      },
    });

    if (selected?.value) navigateTo(entityHref(selected.value));
  };

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
