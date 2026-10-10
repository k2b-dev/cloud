import type { DashboardWidgetSize, WidgetBlock, WidgetResponse } from "@k2b/cloud/contracts";
import { hasRole } from "@k2b/cloud/contracts";
import { type AuthContext, auth, getLocale, getUserBackedActor, getWidgetRequest } from "@k2b/cloud/server";
import { accountsAppService } from "@k2b/cloud/services";
import { i18n } from "@k2b/stdlib";
import { type Context, Hono } from "hono";

const widgetMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      allClear: "All clear",
      allClearDescription: "No pending requests and no credentials are about to expire",
      pendingRequest: "Pending request",
      pendingRequests: "Pending requests",
      needsReview: "needs review",
      open: "Open",
      expiring: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: "1 account expires within 30 days", other: `${count} accounts expire within 30 days` }),
      expiryBreakdown: ({ ipa, local, guests }: { ipa: number; local: number; guests: number }) =>
        `${ipa} FreeIPA · ${local} local · ${guests} guest`,
      accounts: "Accounts",
      groups: "Groups",
      queue: "Queue",
      adminQueue: "Admin queue",
    },
    de: {
      allClear: "Alles erledigt",
      allClearDescription: "Keine offenen Anfragen und keine Zugangsdaten, die bald ablaufen",
      pendingRequest: "Offene Anfrage",
      pendingRequests: "Offene Anfragen",
      needsReview: "zu prüfen",
      open: "Offen",
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

type AdminQueueSummary = Awaited<ReturnType<typeof accountsAppService.dashboard.get>>;

/**
 * The admin queue in one widget size. Small shows what needs action first: the pending requests, else the accounts
 * that expire soon, else the all-clear. Medium adds the totals; large shows both findings with their details.
 */
export const adminQueueWidgetBody = (summary: AdminQueueSummary, size: DashboardWidgetSize, locale: string): WidgetResponse => {
  const { t } = widgetMessages.resolve([locale]);
  const expiring = summary.ipaExpiring30d + summary.localUserExpiring30d + summary.localGuestExpiring30d;
  const large = size === "large";
  const blocks: WidgetBlock[] = [];

  if (summary.openRequests === 0 && expiring === 0) {
    blocks.push({
      kind: "hero",
      icon: "ti ti-circle-check",
      tone: "emerald",
      title: t.allClear,
      subtitle: large ? t.allClearDescription : undefined,
    });
  }
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
  if (expiring > 0 && (large || summary.openRequests === 0)) {
    blocks.push({
      kind: "status",
      tone: "warn",
      grow: !large,
      title: t.expiring({ count: expiring }),
      message: large
        ? t.expiryBreakdown({ ipa: summary.ipaExpiring30d, local: summary.localUserExpiring30d, guests: summary.localGuestExpiring30d })
        : undefined,
      icon: "ti ti-calendar-due",
    });
  }
  if (size !== "small") {
    blocks.push({
      kind: "pills",
      pills: [
        { label: t.accounts, value: summary.ipaAccountsTotal + summary.localAccountsTotal },
        { label: t.groups, value: summary.groupsTotal },
        ...(summary.openRequests > 0 ? [{ label: t.queue, value: summary.openRequests, tone: "amber" as const }] : []),
      ],
    });
  }

  return { title: t.adminQueue, icon: "ti ti-users-group", href: "/app/accounts", blocks };
};

/** Admin queue widget — pending account requests and accounts expiring soon; `403` for everyone but admins. */
export const adminQueueWidgetHandler = async (c: Context<AuthContext>) => {
  const user = getUserBackedActor(c);
  if (!user || !hasRole(user, "admin")) return c.body(null, 403);
  return c.json(adminQueueWidgetBody(await accountsAppService.dashboard.get(), getWidgetRequest(c).size, getLocale(c)));
};

const app = new Hono<AuthContext>().use(auth.requireRole("*")).get("/admin-queue", adminQueueWidgetHandler);

export default app;
