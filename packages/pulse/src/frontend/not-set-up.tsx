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
      visitor: "This display is not available yet.",
    },
    de: {
      title: "Pulse ist noch nicht eingerichtet",
      admin: "Pulse braucht zuerst seinen Datenspeicher. Verbinde ClickHouse unter Verwaltung → Pulse.",
      adminAction: "Verwaltung → Pulse öffnen",
      member: "Pulse braucht zuerst seinen Datenspeicher. Bitte wende dich an deinen Cloud-Admin.",
      visitor: "Diese Anzeige ist noch nicht verfügbar.",
    },
  },
});

/**
 * Until a Cloud admin connects the data store, every Pulse page answers 503 with the same state. Signed-out
 * visitors of signed-in pages still reach the normal sign-in redirect first; the public display page stays
 * outside the Cloud shell and names no admin path.
 */
export const pulseNotSetUpGate =
  (options: { publicDisplay?: boolean } = {}): MiddlewareHandler<AuthContext> =>
  async (c, next) => {
    if (await pulseStoreConfigured()) return next();
    const user = userFromActor(c.get("actor"));
    if (!user && !options.publicDisplay) return next();
    const { t } = notSetUpMessages.resolve([getLocale(c)]);
    if (!user || options.publicDisplay) return ssr.error(c, 503, { title: t.title, description: t.visitor, layout: "minimal" });
    const cloudAdmin = hasRole(user, "admin");
    return ssr.error(c, 503, {
      title: t.title,
      description: cloudAdmin ? t.admin : t.member,
      ...(cloudAdmin ? { action: { label: t.adminAction, href: "/admin/pulse", icon: "ti ti-settings" } } : {}),
    });
  };
