import { dates } from "@k2b/stdlib";
import { ButtonLink, DescriptionList, LinkCard, LogEntriesTable, Paper, ProgressBar, StatCell, StatusBadge, Tag } from "@k2b/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor, getLocale } from "@valentinkolb/cloud/server";
import { accountsAppService as accountsService, coreSettings } from "@valentinkolb/cloud/services";
import { getDefaultGroupScope, isAdminUser } from "@valentinkolb/cloud/shared";
import { Layout } from "@valentinkolb/cloud/ssr";
import AccountAvatar from "@/frontend/AccountAvatar";
import { ssr } from "../config";
import AccountsWorkspace from "./AccountsWorkspace";

import { buildGroupsUrl } from "./lib/url-state";
import { accountsMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  const quickLinkItems = [
    { href: "/admin/observability/logs?source=auth:ipa:sync", label: t.syncLogs },
    { href: "/admin/observability/logs?source=auth:ipa:backfill", label: t.ipaBackfill },
    { href: "/admin/observability/logs?source=auth:local-user:backfill", label: t.localUserBackfill },
    { href: "/admin/observability/logs?source=auth:guest:backfill", label: t.guestBackfill },
    { href: "/admin/observability/logs?source=auth:reminder:daily", label: t.reminderRuns },
    { href: "/app/accounts/deleted-accounts", label: t.deletedAccounts },
    { href: "/app/accounts/reminders", label: t.reminderHistory },
  ];
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

  const accountExpires = user.accountExpires ? dates.formatDate(user.accountExpires, { locale }) : null;
  const loginMethod = user.provider === "ipa" ? t.freeIpaPassword : t.magicLink;
  const isExpiredAccount = user.accountExpires ? new Date(user.accountExpires) < new Date() : false;
  const totalAccounts = summary ? summary.ipaAccountsTotal + summary.localAccountsTotal : 0;
  const expiringTotal = summary ? summary.ipaExpiring30d + summary.localUserExpiring30d + summary.localGuestExpiring30d : 0;
  const quickLinks = freeIpaEnabled ? quickLinkItems : quickLinkItems.filter((link) => !link.href.includes("auth:ipa:"));
  const healthRows: Array<[string, number, number]> = freeIpaEnabled
    ? [
        [t.ipaSync, summary?.recentSyncRuns ?? 0, summary?.recentSyncRunsWithFailures ?? 0],
        [t.ipaDemotion, summary?.recentDemotionRuns ?? 0, summary?.recentDemotionRunsWithFailures ?? 0],
        [t.reminders, summary?.recentReminderRuns ?? 0, summary?.recentReminderRunsWithFailures ?? 0],
      ]
    : [[t.reminders, summary?.recentReminderRuns ?? 0, summary?.recentReminderRunsWithFailures ?? 0]];

  return () => (
    <Layout c={c} fullWidth title={[{ title: t.start, href: "/" }, { title: t.accounts }]}>
      <AccountsWorkspace
        active="dashboard"
        isAdmin={isAdmin}
        pendingRequests={summary?.openRequests ?? 0}
        scrollPreserveKey="accounts-dashboard"
      >
        <div class="flex flex-col gap-4">
          {/* Identity */}
          <Paper class="p-5">
            <div class="flex items-center gap-4">
              <AccountAvatar
                name={user.displayName || user.uid}
                userId={user.id}
                avatarHash={user.avatarHash}
                size="md"
                class="h-11 w-11"
              />
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <h1 class="text-sm font-semibold text-primary">{user.displayName || user.uid}</h1>
                  <Tag>{user.profile === "user" ? t.fullAccount : t.guestAccount}</Tag>
                  <Tag>{user.provider === "ipa" ? "FreeIPA" : t.local}</Tag>
                  {isExpiredAccount && <StatusBadge tone="error" label={t.expired} />}
                </div>
                <span class="text-xs text-dimmed">{user.uid}</span>
              </div>
              <ButtonLink href="/me" size="sm" variant="subtle" class="shrink-0">
                <i class="ti ti-user" />
                <span>{t.profilePage}</span>
              </ButtonLink>
            </div>
            <DescriptionList
              class="mt-4"
              columns={2}
              items={[
                { term: t.access, description: user.profile === "user" ? t.fullAccount : t.guestAccount },
                { term: t.managedBy, description: user.provider === "ipa" ? "FreeIPA" : t.local },
                { term: t.login, description: loginMethod },
                { term: t.expires, description: accountExpires ?? t.never },
              ]}
            />
          </Paper>

          {/* Groups */}
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <LinkCard
              href={buildGroupsUrl({ search: "", page: 1, provider: "", scope: "managed" }, { defaultScope: defaultGroupScope })}
              title={t.managedByMe}
              description={t.groupCount({ count: managedGroups.total })}
              icon="ti ti-shield"
              color="violet"
            />
            <LinkCard
              href={buildGroupsUrl({ search: "", page: 1, provider: "", scope: "member" }, { defaultScope: defaultGroupScope })}
              title={t.myGroups}
              description={t.groupCount({ count: memberGroups.total })}
              icon="ti ti-users-group"
              color="blue"
            />
            <LinkCard
              href={buildGroupsUrl({ search: "", page: 1, provider: "", scope: "all" }, { defaultScope: defaultGroupScope })}
              title={t.allGroups}
              description={t.groupCount({ count: allGroups.total })}
              icon="ti ti-layout-grid"
              color="zinc"
            />
          </div>

          {/* Admin */}
          {isAdmin && summary ? (
            <>
              <div class="pt-2">
                <h2 class="text-sm font-semibold text-primary">{t.administration}</h2>
                <p class="mt-1 text-xs text-dimmed">{t.administrationDescription}</p>
              </div>

              <Paper class="px-4 py-3">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div class="min-w-0">
                    <p class="text-xs font-medium text-primary">{t.auditNotice}</p>
                    <p class="mt-0.5 text-xs text-dimmed">{t.auditNoticeDescription}</p>
                  </div>
                  <ButtonLink href="/app/accounts/audit" size="sm" variant="subtle" class="shrink-0">
                    <i class="ti ti-clipboard-list" />
                    {t.auditLog}
                  </ButtonLink>
                </div>
              </Paper>

              {/* Run health and account metrics share one visual tier without decorative divider lines. */}
              <div class="grid grid-cols-1 gap-2 lg:grid-cols-[1.2fr_1.8fr]">
                {/* Run Health — hero side */}
                <Paper class="flex flex-col gap-3 px-5 py-5">
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-xs text-dimmed">{t.runHealth}</span>
                    <StatusBadge
                      tone={summary.lastSync ? "ok" : "neutral"}
                      label={
                        summary.lastSync
                          ? t.synced({ value: dates.formatDateTimeRelative(summary.lastSync.createdAt, { locale }) })
                          : t.noSyncYet
                      }
                    />
                  </div>
                  <div class="flex flex-col gap-2 flex-1 justify-center">
                    {healthRows.map(([label, runs, failedRuns]) => {
                      const rate = runs > 0 ? Math.round(((runs - failedRuns) / runs) * 100) : 100;
                      const hasFails = failedRuns > 0;
                      return (
                        <div class="flex items-center gap-3">
                          <span class="text-xs text-secondary w-28 shrink-0 truncate">{label}</span>
                          <ProgressBar
                            value={rate}
                            showValue
                            size="xs"
                            tone={hasFails ? "danger" : "info"}
                            class="flex-1 min-w-0"
                            label={t.runHealthLabel({ label })}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <span class="text-xs text-dimmed">{t.basedOnRuns({ count: summary.runHealthWindow })}</span>
                </Paper>
                <div class="grid grid-cols-2 gap-2">
                  <Paper class="overflow-hidden">
                    <StatCell
                      label={t.accounts}
                      value={totalAccounts}
                      sub={t.sourceCounts({ freeIpa: summary.ipaAccountsTotal, local: summary.localAccountsTotal })}
                      accent={{ tone: "blue", icon: "ti ti-users" }}
                    />
                  </Paper>
                  <Paper class="overflow-hidden">
                    <StatCell
                      label={t.groups}
                      value={summary.groupsTotal}
                      sub={t.sourceCounts({ freeIpa: summary.ipaGroupsTotal, local: summary.localGroupsTotal })}
                    />
                  </Paper>
                  <Paper class="overflow-hidden">
                    <StatCell
                      label={t.requests}
                      value={summary.openRequests}
                      href={summary.openRequests > 0 ? "/app/accounts/requests" : undefined}
                      sub={summary.openRequests > 0 ? t.pendingReview : t.nonePending}
                      accent={
                        summary.openRequests > 0
                          ? {
                              tone: "amber",
                              icon: "ti ti-clock",
                              text: t.open,
                            }
                          : undefined
                      }
                    />
                  </Paper>
                  <Paper class="overflow-hidden">
                    <StatCell
                      label={t.expiring30d}
                      value={expiringTotal}
                      sub={expiringTotal > 0 ? t.accountCount({ count: expiringTotal }) : t.noneSoon}
                      accent={expiringTotal > 0 ? { tone: "amber", icon: "ti ti-calendar-due" } : undefined}
                    />
                  </Paper>
                </div>
              </div>

              {/* Operations */}
              <div class="flex flex-col gap-2">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-xs text-dimmed">{t.operations}</span>
                  <a href="/admin/settings?tab=user" class="text-xs text-dimmed transition-colors hover:text-primary">
                    {t.settings}
                  </a>
                </div>
                <ButtonLink href="/admin/settings?tab=account-operations" variant="secondary">
                  {t.operations}
                </ButtonLink>
              </div>

              {/* Activity */}
              <div class="flex flex-col gap-2">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-xs text-dimmed">{t.recentActivity}</span>
                  <div class="flex items-center gap-1 flex-wrap">
                    {quickLinks.map((link) => (
                      <ButtonLink href={link.href} variant="subtle" size="sm">
                        {link.label}
                      </ButtonLink>
                    ))}
                  </div>
                </div>
                <LogEntriesTable entries={activity} emptyMessage={t.noLifecycleActivity} />
              </div>
            </>
          ) : null}
        </div>
      </AccountsWorkspace>
    </Layout>
  );
});
