import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale, getTimeZone } from "@k2b/cloud/server";
import { accountsAppService as accountsService, audit, coreSettings } from "@k2b/cloud/services";
import { getDefaultGroupScope, groupDisplayName, isAdminUser } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { ssr } from "../config";
import AccountsNavigation from "./AccountsNavigation.island";
import { accountsNavigationItems } from "./accounts-nav";
import { auditMessages } from "./audit/messages";
import { auditRows } from "./audit/rows";
import { buildGroupDetailUrl, buildGroupsUrl } from "./lib/url-state";
import { accountsMessages } from "./messages";
import type { OverviewAdmin, OverviewGroup, OverviewLogLink } from "./overview/OverviewScreen";
import OverviewScreen from "./overview/OverviewScreen.island";

/** How many changes of the audit log the overview tells; "Alle Aktivitäten" leads to the rest. */
const ACTIVITY_SIZE = 8;
/** How many of the person's groups the overview shows; the list behind "All groups" has the rest. */
const MY_GROUPS = 6;

const LOG_LINKS: OverviewLogLink[] = [
  { href: "/admin/observability/logs?source=auth:ipa:sync", label: "syncLogs" },
  { href: "/admin/observability/logs?source=auth:ipa:backfill", label: "ipaBackfill" },
  { href: "/admin/observability/logs?source=auth:local-user:backfill", label: "localUserBackfill" },
  { href: "/admin/observability/logs?source=auth:guest:backfill", label: "guestBackfill" },
  { href: "/admin/observability/logs?source=auth:reminder:daily", label: "reminderRuns" },
  { href: "/app/accounts/activity?kind=deleted", label: "deletedAccounts" },
  { href: "/app/accounts/activity?kind=reminders", label: "reminderHistory" },
];

/**
 * The Accounts overview on v2, an administrator's page. Everyone else goes straight to the groups (decision 27.11.), before
 * any read, with the address's query kept.
 */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const timeZone = getTimeZone(c);
  const { t } = accountsMessages.resolve([locale]);
  const user = expectUserBackedActor(c);
  if (!isAdminUser(user)) {
    const query = new URL(c.req.url).search;
    return c.redirect(`/app/accounts/groups${query}`);
  }
  const freeIpaEnabled = Boolean(await coreSettings.get<boolean>("freeipa.enable"));
  const defaultGroupScope = getDefaultGroupScope(user);
  const [summary, activity, managedGroups, memberGroups] = await Promise.all([
    accountsService.dashboard.get(),
    // one statement, rows only: the newest changes of the audit log
    audit.latest({ limit: ACTIVITY_SIZE }).catch(() => null),
    accountsService.group.list({ pagination: { page: 1, perPage: MY_GROUPS }, scope: { userId: user.id, mode: "managed" } }),
    accountsService.group.list({ pagination: { page: 1, perPage: MY_GROUPS }, scope: { userId: user.id, mode: "member" } }),
  ]);

  const now = new Date();
  const auditWords = auditMessages.resolve([locale]).t;
  // the person's own groups: the managed ones first, then the others they belong to, a handful in all
  const listState = { search: "", page: 1, provider: "" as const, scope: "member" as const };
  const managedIds = new Set(managedGroups.items.map((group) => group.id));
  const myGroups: OverviewGroup[] = [...managedGroups.items, ...memberGroups.items.filter((group) => !managedIds.has(group.id))]
    .slice(0, MY_GROUPS)
    .map((group) => ({
      id: group.id,
      name: groupDisplayName(group.name, locale),
      description: group.description,
      provider: group.provider === "ipa" ? "ipa" : "local",
      managed: managedIds.has(group.id),
      href: buildGroupDetailUrl(group.id, listState, { defaultScope: defaultGroupScope }),
    }));
  const admin: OverviewAdmin = {
          accounts: {
            total: summary.ipaAccountsTotal + summary.localAccountsTotal,
            freeIpa: summary.ipaAccountsTotal,
            local: summary.localAccountsTotal,
          },
          openRequests: summary.openRequests,
          expiring: { freeIpa: summary.ipaExpiring30d, local: summary.localUserExpiring30d, guests: summary.localGuestExpiring30d },
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
          // worded as the audit log words them; an actor recorded by ID alone keeps its fallback name (no extra read)
          activity: activity
            ? auditRows(activity, { t, locale, timeZone, names: [], now, today: auditWords.today, yesterday: auditWords.yesterday })
            : null,
          logs: freeIpaEnabled ? LOG_LINKS : LOG_LINKS.filter((link) => !link.href.includes("auth:ipa:")),
  };

  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.accounts }]}>
      <AccountsNavigation
        items={accountsNavigationItems(t, { active: "dashboard", pendingRequests: summary.openRequests, isAdmin: true })}
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
          memberCount: memberGroups.total,
          allHref: buildGroupsUrl({ search: "", page: 1, provider: "", scope: "all" }, { defaultScope: defaultGroupScope }),
        }}
        myGroups={myGroups}
        admin={admin}
        pendingRequests={summary.openRequests}
      />
    </Layout>
  );
});
