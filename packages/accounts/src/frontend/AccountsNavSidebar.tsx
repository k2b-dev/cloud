import { AppWorkspace } from "@k2b/ui";
import AccountsNavigation from "./AccountsNavigation.island";
import AccountsSearchButton from "./AccountsSearchButton.island";
import { type AccountsNavActiveKey, accountsNavItems, accountsNavigationItems, type NavItem } from "./accounts-nav";
import { useAccountsMessages } from "./messages";

export type { AccountsNavActiveKey } from "./accounts-nav";

type Props = {
  active: AccountsNavActiveKey;
  ancestor?: boolean;
  isAdmin: boolean;
  pendingRequests: number;
};

const renderItem = (item: NavItem, ancestor: boolean) => (
  <AppWorkspace.SidebarItem
    href={item.href}
    icon={item.icon}
    active={item.active && (ancestor ? "ancestor" : true)}
    navigation="document"
    meta={item.badge ? <span class="text-xs text-dimmed">{item.badge}</span> : undefined}
  >
    {item.label}
  </AppWorkspace.SidebarItem>
);

export default function AccountsNavSidebar(props: Props) {
  const messages = useAccountsMessages();
  const { general: generalItems, admin: adminItems } = accountsNavItems(messages, props);

  return (
    <>
      <AccountsNavigation items={accountsNavigationItems(messages(), props)} />
      <AppWorkspace.Sidebar>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarBody scrollPreserveKey="accounts-sidebar">
            <AppWorkspace.SidebarSection>
              <AccountsSearchButton isAdmin={props.isAdmin} variant="sidebar" registerCommand />
              {generalItems().map((item) => renderItem(item, Boolean(props.ancestor)))}
            </AppWorkspace.SidebarSection>
            {props.isAdmin ? (
              <AppWorkspace.SidebarSection title={messages().admin}>
                {adminItems().map((item) => renderItem(item, Boolean(props.ancestor)))}
              </AppWorkspace.SidebarSection>
            ) : null}
          </AppWorkspace.SidebarBody>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
    </>
  );
}
