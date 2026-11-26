import { Nav } from "@k2b/ui/v2";
import { type AccountsNavActiveKey, accountsNavItems, type NavItem } from "./accounts-nav";
import { createAccountsSearch } from "./accounts-search";
import { useAccountsMessages } from "./messages";

type Props = {
  active: AccountsNavActiveKey;
  pendingRequests: number;
  /** Whether the administration's entries show; everyone else sees only their own. Administrators by default. */
  isAdmin?: boolean;
};

const entry = (item: NavItem) => ({
  label: item.label,
  // v2 names Tabler icons without the `ti ti-` classes v1 takes
  icon: item.icon.replace(/^ti ti-/, ""),
  href: item.href,
  current: item.active,
  count: item.badge,
});

/** Accounts' sections in a v2 sidebar: search, everyone's entries, then the administration's for administrators. */
export default function AccountsNav(props: Props) {
  const messages = useAccountsMessages();
  const search = createAccountsSearch();
  const items = accountsNavItems(messages, props);
  return (
    <Nav
      title={messages().accounts}
      icon="users-group"
      groups={[
        { items: [{ label: messages().searchAccounts, icon: "search", onClick: search }, ...items.general().map(entry)] },
        ...(props.isAdmin === false ? [] : [{ label: messages().admin, items: items.admin().map(entry) }]),
      ]}
    />
  );
}
