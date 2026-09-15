import { createNavigation, type NavigationItem } from "@k2b/ui";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { createAccountsSearch } from "./accounts-search";
import { useAccountsMessages } from "./messages";

export default function AccountsNavigation(props: { items: readonly NavigationItem[]; isAdmin: boolean }) {
  const messages = useAccountsMessages();
  const search = createAccountsSearch(props);
  const navigation = createNavigation({
    items: () => [{ id: "search", label: messages().searchAccounts, icon: "ti ti-search", action: "search" }, ...props.items],
    onAction: (action) => {
      if (action === "search") return search();
    },
  });
  return <WorkspaceNavigationProvider navigation={navigation} label={messages().accounts} />;
}
