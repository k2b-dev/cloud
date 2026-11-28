// The addresses of Outgoing mail's sections; client-safe, the screens link with them.

export const OUTGOING_MAIL_SECTIONS = ["profiles", "apps", "log", "templates"] as const;
/** The sections of Outgoing mail: sender profiles, which app may send and read, the send log, and the email templates. */
export type OutgoingMailSection = (typeof OUTGOING_MAIL_SECTIONS)[number];

export const OUTGOING_MAIL_HREF: Record<OutgoingMailSection, string> = {
  profiles: "/admin/outgoing-mail",
  apps: "/admin/outgoing-mail/apps",
  log: "/admin/outgoing-mail/log",
  templates: "/admin/outgoing-mail/templates",
};
