import { adminNavigation } from "@k2b/cloud/ssr";
import { outgoingMailMessages } from "./messages";

export const OUTGOING_MAIL_SECTIONS = ["profiles", "apps", "log", "templates"] as const;
/** The sections of Outgoing mail: sender profiles, which app may send and read, the send log, and the email templates. */
export type OutgoingMailSection = (typeof OUTGOING_MAIL_SECTIONS)[number];

export const OUTGOING_MAIL_HREF: Record<OutgoingMailSection, string> = {
  profiles: "/admin/outgoing-mail",
  apps: "/admin/outgoing-mail/apps",
  log: "/admin/outgoing-mail/log",
  templates: "/admin/outgoing-mail/templates",
};

const ICON: Record<OutgoingMailSection, string> = { profiles: "mail-cog", apps: "apps", log: "list-search", templates: "template" };

export const outgoingMailText = (locale: string) => outgoingMailMessages.resolve([locale]).t;

/** The section names, from the area's catalog. */
export const sectionLabel = (t: ReturnType<typeof outgoingMailText>, section: OutgoingMailSection) =>
  ({ profiles: t.profiles, apps: t.apps, log: t.sendLog, templates: t.templates })[section];

/** The admin bar with the sections of Outgoing mail one level in under its entry, the open one current. */
export const outgoingMailNav = (c: Parameters<typeof adminNavigation>[0], locale: string, current: OutgoingMailSection) => {
  const t = outgoingMailText(locale);
  return adminNavigation(
    c,
    OUTGOING_MAIL_SECTIONS.map((section) => ({
      label: sectionLabel(t, section),
      icon: ICON[section],
      href: OUTGOING_MAIL_HREF[section],
      current: section === current,
    })),
  );
};

/**
 * Addresses from before the sections: send log filters on the area's start lead to the send log, and the email
 * templates of the former settings page lead to their section; both keep their parameters.
 */
export const legacyOutgoingMailHref = (url: string): string | null => {
  const parsed = new URL(url);
  if (parsed.pathname === "/admin/outgoing-mail" && ["app", "status", "recipient"].some((name) => parsed.searchParams.has(name)))
    return `${OUTGOING_MAIL_HREF.log}${parsed.search}`;
  return null;
};
