import { ViewTabs } from "@k2b/ui";
import { mailKeptAdminMessages } from "./kept-admin-messages";

export type MailAdminView = "mailboxes" | "security" | "kept";

/** The views of Cloud administration › Mail. Each one is its own page, so a tab is a link. */
export function MailAdminTabs(props: { locale: string; current: MailAdminView; keptCount?: number }) {
  const { t } = mailKeptAdminMessages.resolve([props.locale]);
  return (
    <ViewTabs
      label={t.tabsLabel}
      current={props.current}
      items={[
        { id: "mailboxes", label: t.tabMailboxes, href: "/admin/mail" },
        { id: "security", label: t.tabSecurity, href: "/admin/mail/security" },
        { id: "kept", label: t.tabKept, href: "/admin/mail/kept", count: props.keptCount },
      ]}
    />
  );
}
