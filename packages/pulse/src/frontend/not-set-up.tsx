import { hasRole } from "@k2b/cloud/contracts";
import { type AuthContext, getLocale, userFromActor } from "@k2b/cloud/server";
import { i18n } from "@k2b/stdlib";
import type { MiddlewareHandler } from "hono";
import { ssr } from "../config";
import { pulseStoreConfigured } from "../store/service";

export const notSetUpMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Pulse is not set up yet",
      admin: "Pulse needs its data store first. Connect ClickHouse under Administration -> Pulse.",
      adminAction: "Open Administration -> Pulse",
      member: "Pulse needs its data store first. Please contact your Cloud admin.",
    },
    de: {
      title: "Pulse ist noch nicht eingerichtet",
      admin: "Pulse braucht zuerst seinen Datenspeicher. Verbinde ClickHouse unter Verwaltung → Pulse.",
      adminAction: "Verwaltung → Pulse öffnen",
      member: "Pulse braucht zuerst seinen Datenspeicher. Bitte wende dich an deinen Cloud-Admin.",
    },
  },
});

/** Authentication runs first so signed-out people keep the sign-in redirect. */
export const pulseNotSetUpGate = (): MiddlewareHandler<AuthContext> => async (c, next) => {
  if (await pulseStoreConfigured()) return next();
  const user = userFromActor(c.get("actor"));
  if (!user) return next();
  const { t } = notSetUpMessages.resolve([getLocale(c)]);
  const cloudAdmin = hasRole(user, "admin");
  return ssr.error(c, 503, {
    title: t.title,
    description: cloudAdmin ? t.admin : t.member,
    ...(cloudAdmin ? { action: { label: t.adminAction, href: "/admin/pulse", icon: "ti ti-settings" } } : {}),
  });
};
