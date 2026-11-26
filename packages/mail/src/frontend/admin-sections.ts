import type { AdminNavigationSection } from "@k2b/cloud/ssr";
import { mailKeptAdminMessages } from "./kept-admin-messages";

export type MailAdminView = "mailboxes" | "security" | "kept";

/**
 * The views of Cloud administration › Mail: sections one level in under Mail in the admin bar, each its own page.
 */
export const mailAdminSections = (locale: string, current: MailAdminView): AdminNavigationSection[] => {
  const { t } = mailKeptAdminMessages.resolve([locale]);
  return [
    { label: t.tabMailboxes, icon: "inbox", href: "/admin/mail", current: current === "mailboxes" },
    { label: t.tabSecurity, icon: "shield-lock", href: "/admin/mail/security", current: current === "security" },
    { label: t.tabKept, icon: "lock", href: "/admin/mail/kept", current: current === "kept" },
  ];
};

/** The address of the kept list with its search and page; empty values stay out. */
export const keptListHref = (params: { q?: string; cursor?: string | null }): string => {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.cursor) query.set("cursor", params.cursor);
  const text = query.toString();
  return text ? `/admin/mail/kept?${text}` : "/admin/mail/kept";
};
