import { adminNavigation } from "@k2b/cloud/ssr";
import { outgoingMailMessages } from "./messages";

import { OUTGOING_MAIL_HREF, OUTGOING_MAIL_SECTIONS, type OutgoingMailSection } from "./paths";

export { OUTGOING_MAIL_HREF, OUTGOING_MAIL_SECTIONS, type OutgoingMailSection };

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
