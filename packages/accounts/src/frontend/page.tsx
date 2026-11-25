import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale, getTimeZone } from "@k2b/cloud/server";
import { accountsAppService as accountsService, coreSettings } from "@k2b/cloud/services";
import { getDefaultGroupScope, isAdminUser } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { ssr } from "../config";
import AccountsNavigation from "./AccountsNavigation.island";
import { accountsNavigationItems } from "./accounts-nav";
import { buildGroupsUrl } from "./lib/url-state";
import { accountsMessages } from "./messages";
import type { OverviewAdmin, OverviewLogLink } from "./overview/OverviewScreen";
import OverviewScreen from "./overview/OverviewScreen.island";

const LOG_LINKS: OverviewLogLink[] = [
  { href: "/admin/observability/logs?source=auth:ipa:sync", label: "syncLogs" },
  { href: "/admin/observability/logs?source=auth:ipa:backfill", label: "ipaBackfill" },
  { href: "/admin/observability/logs?source=auth:local-user:backfill", label: "localUserBackfill" },
  { href: "/admin/observability/logs?source=auth:guest:backfill", label: "guestBackfill" },
  { href: "/admin/observability/logs?source=auth:reminder:daily", label: "reminderRuns" },
  { href: "/app/accounts/activity?kind=deleted", label: "deletedAccounts" },
  { href: "/app/accounts/activity?kind=reminders", label: "reminderHistory" },
];

/** The Accounts overview on v2, for every signed-in person; the administration's part only for administrators. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const timeZone = getTimeZone(c);
  const { t } = accountsMessages.resolve([locale]);
  const user = expectUserBackedActor(c);
  const isAdmin = isAdminUser(user);
  const freeIpaEnabled = Boolean(await coreSettings.get<boolean>("freeipa.enable"));
  const defaultGroupScope = getDefaultGroupScope(user);
  const [summary, activity, managedGroups, memberGroups, allGroups] = await Promise.all([
    isAdmin ? accountsService.dashboard.get() : Promise.resolve(null),
    isAdmin ? accountsService.dashboard.activity() : Promise.resolve([]),
    accountsService.group.list({ pagination: { page: 1, perPage: 1 }, scope: { userId: user.id, mode: "managed" } }),
    accountsService.group.list({ pagination: { page: 1, perPage: 1 }, scope: { userId: user.id, mode: "member" } }),
    accountsService.group.list({ pagination: { page: 1, perPage: 1 }, scope: { mode: "all" } }),
  ]);

  const now = new Date();
  const groupsHref = (scope: "managed" | "member" | "all") =>
    buildGroupsUrl({ search: "", page: 1, provider: "", scope }, { defaultScope: defaultGroupScope });
  const admin: OverviewAdmin | null =
    isAdmin && summary
      ? {
          accounts: {
            total: summary.ipaAccountsTotal + summary.localAccountsTotal,
            freeIpa: summary.ipaAccountsTotal,
            local: summary.localAccountsTotal,
          },
          groups: { total: summary.groupsTotal, freeIpa: summary.ipaGroupsTotal, local: summary.localGroupsTotal },
          openRequests: summary.openRequests,
          expiring: summary.ipaExpiring30d + summary.localUserExpiring30d + summary.localGuestExpiring30d,
          lastSync: summary.lastSync ? dates.formatDateTimeRelative(summary.lastSync.createdAt, { locale, timeZone, base: now }) : null,
          health: [
            ...(freeIpaEnabled
              ? [
                  { run: "ipaSync" as const, runs: summary.recentSyncRuns, failed: summary.recentSyncRunsWithFailures },
                  { run: "ipaDemotion" as const, runs: summary.recentDemotionRuns, failed: summary.recentDemotionRunsWithFailures },
                ]
              : []),
            { run: "reminders" as const, runs: summary.recentReminderRuns, failed: summary.recentReminderRunsWithFailures },
          ],
          window: summary.runHealthWindow,
          activity: activity.map((entry) => ({
            id: String(entry.id),
            level: entry.level,
            source: entry.source,
            message: entry.message,
            time: dates.formatDateTime(entry.createdAt, { locale, timeZone }),
          })),
          logs: freeIpaEnabled ? LOG_LINKS : LOG_LINKS.filter((link) => !link.href.includes("auth:ipa:")),
        }
      : null;

  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.accounts }]}>
      <AccountsNavigation
        items={accountsNavigationItems(t, { active: "dashboard", pendingRequests: summary?.openRequests ?? 0, isAdmin })}
      />
      <OverviewScreen
        me={{
          name: user.displayName || user.uid,
          uid: user.uid,
          image: user.avatarHash
            ? `/api/accounts/users/${encodeURIComponent(user.id)}/avatar?rev=${encodeURIComponent(user.avatarHash)}`
            : undefined,
          profile: user.profile === "user" ? "user" : "guest",
          provider: user.provider === "ipa" ? "ipa" : "local",
          expires: user.accountExpires ? dates.formatDate(user.accountExpires, { locale, timeZone }) : null,
          expired: user.accountExpires ? new Date(user.accountExpires) < now : false,
        }}
        groups={{
          managed: { count: managedGroups.total, href: groupsHref("managed") },
          member: { count: memberGroups.total, href: groupsHref("member") },
          all: { count: allGroups.total, href: groupsHref("all") },
        }}
        isAdmin={isAdmin}
        admin={admin}
        pendingRequests={summary?.openRequests ?? 0}
      />
    </Layout>
  );
});
