import { AppWorkspace } from "@k2b/ui";
import AccountsNavigation from "./AccountsNavigation.island";
import AccountsSearchButton from "./AccountsSearchButton.island";
import { useAccountsMessages } from "./messages";

export type AccountsNavActiveKey =
  | "dashboard"
  | "users"
  | "duplicate-emails"
  | "groups"
  | "requests"
  | "audit"
  | "service-accounts"
  | "notifications"
  | "deleted-accounts"
  | "reminders"
  | null;

type Props = {
  active: AccountsNavActiveKey;
  ancestor?: boolean;
  isAdmin: boolean;
  pendingRequests: number;
};

type NavItem = {
  href: string;
  icon: string;
  label: string;
  active: boolean;
  badge?: string;
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
  const generalItems = (): NavItem[] => [
    { href: "/app/accounts", icon: "ti ti-layout-dashboard", label: messages().dashboard, active: props.active === "dashboard" },
    { href: "/app/accounts/groups", icon: "ti ti-users-group", label: messages().groups, active: props.active === "groups" },
  ];

  const adminItems = (): NavItem[] => [
    {
      href: "/app/accounts/requests",
      icon: "ti ti-user-plus",
      label: messages().requests,
      active: props.active === "requests",
      badge: props.pendingRequests > 0 ? String(props.pendingRequests) : undefined,
    },
    { href: "/app/accounts/users", icon: "ti ti-users", label: messages().users, active: props.active === "users" },
    {
      href: "/app/accounts/duplicate-emails",
      icon: "ti ti-copy",
      label: messages().duplicateEmails,
      active: props.active === "duplicate-emails",
    },
    {
      href: "/app/accounts/service-accounts",
      icon: "ti ti-user-key",
      label: messages().serviceAccounts,
      active: props.active === "service-accounts",
    },
    {
      href: "/app/accounts/notifications",
      icon: "ti ti-mail-share",
      label: messages().notifications,
      active: props.active === "notifications",
    },
    { href: "/app/accounts/audit", icon: "ti ti-clipboard-list", label: messages().auditLog, active: props.active === "audit" },
    {
      href: "/app/accounts/deleted-accounts",
      icon: "ti ti-user-off",
      label: messages().deletedAccounts,
      active: props.active === "deleted-accounts",
    },
    {
      href: "/app/accounts/reminders",
      icon: "ti ti-mail-share",
      label: messages().reminderHistory,
      active: props.active === "reminders",
    },
  ];

  return (
    <>
      <AccountsNavigation
        items={[
          ...generalItems().map((item) => ({ ...item, id: item.href })),
          ...(props.isAdmin
            ? [{ id: "admin", label: messages().admin, children: adminItems().map((item) => ({ ...item, id: item.href })) }]
            : []),
        ]}
      />
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
