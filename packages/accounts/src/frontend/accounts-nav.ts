import type { AccountsMessages } from "./messages";

export type AccountsNavActiveKey =
  | "dashboard"
  | "users"
  | "duplicate-emails"
  | "groups"
  | "requests"
  | "audit"
  | "api-keys"
  | "agents"
  | "notifications"
  | "deleted-accounts"
  | "reminders"
  | null;

type NavProps = { active: AccountsNavActiveKey; pendingRequests: number };

export type NavItem = {
  href: string;
  icon: string;
  label: string;
  active: boolean;
  badge?: string;
};

/** The entries of Accounts' navigation: everyone's, and the administration's. One list for every shell that shows them. */
export const accountsNavItems = (
  messages: () => AccountsMessages,
  props: NavProps,
): { general: () => NavItem[]; admin: () => NavItem[] } => ({
  general: () => [
    { href: "/app/accounts", icon: "ti ti-layout-dashboard", label: messages().dashboard, active: props.active === "dashboard" },
    { href: "/app/accounts/groups", icon: "ti ti-users-group", label: messages().groups, active: props.active === "groups" },
  ],
  admin: () => [
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
    { href: "/app/accounts/agents", icon: "ti ti-robot", label: messages().agents, active: props.active === "agents" },
    {
      href: "/app/accounts/api-keys",
      icon: "ti ti-user-key",
      label: messages().serviceAccounts,
      active: props.active === "api-keys",
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
  ],
});

/** The same entries for the phone's app menu (`AccountsNavigation`); the administration's only for administrators. */
export const accountsNavigationItems = (messages: AccountsMessages, props: NavProps & { isAdmin: boolean }) => {
  const items = accountsNavItems(() => messages, props);
  return [
    ...items.general().map((item) => ({ ...item, id: item.href })),
    ...(props.isAdmin ? [{ id: "admin", label: messages.admin, children: items.admin().map((item) => ({ ...item, id: item.href })) }] : []),
  ];
};
