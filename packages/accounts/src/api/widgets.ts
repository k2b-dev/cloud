import { i18n } from "@k2b/stdlib";
import type { WidgetBlock, WidgetResponse } from "@valentinkolb/cloud/contracts";
import { hasRole } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, getLocale, getUserBackedActor } from "@valentinkolb/cloud/server";
import { accountsAppService } from "@valentinkolb/cloud/services";
import { Hono } from "hono";

const widgetMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      allClear: "All clear",
      allClearDescription: "No pending requests and no credentials are about to expire",
      pendingRequest: "Pending request",
      pendingRequests: "Pending requests",
      needsReview: "needs review",
      open: "open",
      expiring: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: "1 account expires within 30 days", other: `${count} accounts expire within 30 days` }),
      expiryBreakdown: ({ ipa, local, guests }: { ipa: number; local: number; guests: number }) =>
        `${ipa} FreeIPA · ${local} local · ${guests} guest`,
      accounts: "accounts",
      groups: "groups",
      queue: "queue",
      adminQueue: "Admin queue",
    },
    de: {
      allClear: "Alles erledigt",
      allClearDescription: "Keine offenen Anfragen und keine Zugangsdaten, die bald ablaufen",
      pendingRequest: "Offene Anfrage",
      pendingRequests: "Offene Anfragen",
      needsReview: "zu prüfen",
      open: "offen",
      expiring: ({ count }) =>
        i18n.plural(count, "de", {
          one: "1 Konto läuft innerhalb von 30 Tagen ab",
          other: `${count} Konten laufen innerhalb von 30 Tagen ab`,
        }),
      expiryBreakdown: ({ ipa, local, guests }) => `${ipa} FreeIPA · ${local} lokal · ${guests} Gast`,
      accounts: "Konten",
      groups: "Gruppen",
      queue: "Aufgaben",
      adminQueue: "Administrationsaufgaben",
    },
  },
});

/**
 * Admin queue widget — pending account requests + accounts expiring soon.
 * Hidden (204) for non-admins; vanishes entirely if there's nothing to act on.
 */
const app = new Hono<AuthContext>().use(auth.requireRole("*")).get("/admin-queue", async (c) => {
  const { t } = widgetMessages.resolve([getLocale(c)]);
  const user = getUserBackedActor(c);
  // 403 = no access (modal shows under "not available at your access level").
  if (!user || !hasRole(user, "admin")) return c.body(null, 403);

  const summary = await accountsAppService.dashboard.get();
  const expiring = summary.ipaExpiring30d + summary.localUserExpiring30d + summary.localGuestExpiring30d;

  const blocks: WidgetBlock[] = [];

  if (summary.openRequests === 0 && expiring === 0) {
    // Empty state — admin sees a positive hero, plus the totals as context pills.
    blocks.push({
      kind: "hero",
      icon: "ti ti-circle-check",
      tone: "emerald",
      title: t.allClear,
      subtitle: t.allClearDescription,
    });
  } else {
    if (summary.openRequests > 0) {
      blocks.push({
        kind: "stat",
        grow: true,
        value: summary.openRequests,
        label: summary.openRequests === 1 ? t.pendingRequest : t.pendingRequests,
        sub: t.needsReview,
        valueClass: "text-amber-600 dark:text-amber-400",
        accent: { tone: "amber", icon: "ti ti-clock", text: t.open },
      });
    }
    if (expiring > 0) {
      blocks.push({
        kind: "status",
        tone: "warn",
        title: t.expiring({ count: expiring }),
        message: t.expiryBreakdown({
          ipa: summary.ipaExpiring30d,
          local: summary.localUserExpiring30d,
          guests: summary.localGuestExpiring30d,
        }),
        icon: "ti ti-calendar-due",
      });
    }
  }

  blocks.push({
    kind: "pills",
    pills: [
      { label: t.accounts, value: summary.ipaAccountsTotal + summary.localAccountsTotal },
      { label: t.groups, value: summary.groupsTotal },
      ...(summary.openRequests > 0 ? [{ label: t.queue, value: summary.openRequests, tone: "amber" as const }] : []),
    ],
  });

  const body: WidgetResponse = {
    title: t.adminQueue,
    icon: "ti ti-users-group",
    href: "/app/accounts",
    blocks,
  };
  return c.json(body);
});

export default app;
