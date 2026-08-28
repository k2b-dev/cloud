import { dates } from "@k2b/stdlib";
import { ButtonLink, NoticeCard, Placeholder } from "@k2b/ui";
import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { accountsAppService, audit, coreSettings, notifications, serviceAccountCredentials, webauthn } from "@valentinkolb/cloud/services";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import AccountHub, { AccountPageHeader, AccountProfileActions } from "./AccountHub";
import { type AccountMessages, accountMessages } from "./messages";
import SignOutButton from "./SignOutButton.island";

const accountExpiryCopy = (expiresAt: string, t: AccountMessages): string => {
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return t.accountExpired;
  if (days === 0) return t.accountExpiresToday;
  return t.accountExpiresIn({ count: days });
};

export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
  const locale = getLocale(c);
  const { t } = accountMessages.resolve([locale]);
  const [rawAppName, freeIpaEnabledRaw] = await Promise.all([
    coreSettings.get<string>("app.name"),
    coreSettings.get<boolean>("freeipa.enable"),
  ]);
  const appName = rawAppName || "Cloud";
  const freeIpaEnabled = Boolean(freeIpaEnabledRaw);
  const [pendingRequest, apiKeys, passkeys, activityPage, notificationPreferences] = await Promise.all([
    user.provider === "local" ? accountsAppService.accountRequest.getPendingForUser({ userId: user.id }) : Promise.resolve(null),
    serviceAccountCredentials.listForDelegatedUser({ userId: user.id }),
    webauthn.listForUser({ userId: user.id }),
    audit.listSelfServiceActivity({ userId: user.id, days: 30, pagination: { page: 1, perPage: 5 } }),
    notifications.user.preferences.list(user.id),
  ]);
  const customizedNotifications = notificationPreferences.definitions.filter((preference) => preference.customized).length;
  const action = c.req.query("action");

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.account }]}>
      <AccountHub
        user={user}
        active="overview"
        actions={
          <>
            <AccountProfileActions user={user} appName={appName} freeIpaEnabled={freeIpaEnabled} />
            <SignOutButton />
          </>
        }
      >
        <div class="flex flex-col gap-2">
          <AccountPageHeader title={t.overviewTitle} description={t.overviewDescription} />

          {action === "extend" && (
            <NoticeCard tone="info" icon={false}>
              {t.extendHint}
            </NoticeCard>
          )}

          {user.accountExpires && (
            <section class="paper flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <i class="ti ti-calendar-exclamation" />
              </span>
              <div class="min-w-0 flex-1">
                <h3 class="text-sm font-semibold text-primary">{accountExpiryCopy(user.accountExpires, t)}</h3>
                <p class="mt-1 text-xs text-dimmed">{t.extendBefore({ date: dates.formatDate(user.accountExpires, { locale }) })}</p>
              </div>
              <AccountProfileActions user={user} appName={appName} freeIpaEnabled={freeIpaEnabled} actions={["extend"]} />
            </section>
          )}

          {pendingRequest && (
            <a
              href="/me/access"
              class="paper flex items-center gap-3 p-4 no-underline transition-colors hover:bg-[var(--ui-surface-subtle)]"
            >
              <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-blue-500/10 text-blue-600 dark:text-blue-400">
                <i class="ti ti-clock" />
              </span>
              <div class="min-w-0 flex-1">
                <h3 class="text-sm font-semibold text-primary">{t.requestPending}</h3>
                <p class="mt-1 text-xs text-dimmed">
                  {t.requestSubmitted({ date: dates.formatDate(pendingRequest.createdAt.toISOString(), { locale }) })}
                </p>
              </div>
              <i class="ti ti-chevron-right text-dimmed" />
            </a>
          )}

          {user.provider === "ipa" && user.profile === "guest" && (
            <NoticeCard tone="info" icon={false}>
              {t.limitedAccess}
            </NoticeCard>
          )}

          <section class="grid gap-2 sm:grid-cols-2">
            <a href="/me/security" class="paper group p-4 no-underline transition-colors hover:bg-[var(--ui-surface-subtle)]">
              <div class="flex items-start gap-3">
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-secondary">
                  <i class="ti ti-shield-lock" />
                </span>
                <div class="min-w-0 flex-1">
                  <h3 class="text-sm font-semibold text-primary group-hover:text-secondary">{t.security}</h3>
                  <p class="mt-1 text-xs text-dimmed">
                    {t.passkeyCount({ count: passkeys.length })} ·{" "}
                    {activityPage.items.length > 0 ? t.recentActivityAvailable : t.noRecentActivity}
                  </p>
                </div>
                <i class="ti ti-chevron-right text-dimmed" />
              </div>
            </a>

            <a href="/me/access" class="paper group p-4 no-underline transition-colors hover:bg-[var(--ui-surface-subtle)]">
              <div class="flex items-start gap-3">
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-secondary">
                  <i class="ti ti-users-group" />
                </span>
                <div class="min-w-0 flex-1">
                  <h3 class="text-sm font-semibold text-primary group-hover:text-secondary">{t.accessAndGroups}</h3>
                  <p class="mt-1 text-xs text-dimmed">
                    {t.membershipSummary({ direct: user.memberofGroup.length, managed: user.manages.length })}
                  </p>
                </div>
                <i class="ti ti-chevron-right text-dimmed" />
              </div>
            </a>

            <a href="/me/notifications" class="paper group p-4 no-underline transition-colors hover:bg-[var(--ui-surface-subtle)]">
              <div class="flex items-start gap-3">
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-secondary">
                  <i class="ti ti-bell" />
                </span>
                <div class="min-w-0 flex-1">
                  <h3 class="text-sm font-semibold text-primary group-hover:text-secondary">{t.notifications}</h3>
                  <p class="mt-1 text-xs text-dimmed">
                    {customizedNotifications > 0 ? t.customizedPreferences({ count: customizedNotifications }) : t.usingAppDefaults}
                  </p>
                </div>
                <i class="ti ti-chevron-right text-dimmed" />
              </div>
            </a>

            <a href="/me/developer" class="paper group p-4 no-underline transition-colors hover:bg-[var(--ui-surface-subtle)]">
              <div class="flex items-start gap-3">
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-secondary">
                  <i class="ti ti-terminal-2" />
                </span>
                <div class="min-w-0 flex-1">
                  <h3 class="text-sm font-semibold text-primary group-hover:text-secondary">{t.developer}</h3>
                  <p class="mt-1 text-xs text-dimmed">{t.apiKeySummary({ count: apiKeys.length })}</p>
                </div>
                <i class="ti ti-chevron-right text-dimmed" />
              </div>
            </a>
          </section>

          <section class="paper p-5">
            <div class="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 class="text-sm font-semibold text-primary">{t.recentSecurityActivity}</h3>
                <p class="mt-1 text-xs text-dimmed">{t.recentSecurityActivityDescription}</p>
              </div>
              <ButtonLink href="/me/security" variant="ghost" size="sm" class="shrink-0">
                {t.viewAll}
                <i class="ti ti-arrow-right" />
              </ButtonLink>
            </div>
            {activityPage.items.length > 0 ? (
              <div class="flex flex-col gap-1 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-2">
                {activityPage.items.slice(0, 3).map((entry) => (
                  <div class="grid gap-1 rounded-[var(--ui-radius-control)] p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <div class="min-w-0">
                      <p class="truncate text-sm font-medium text-primary">{entry.label}</p>
                      <p class="mt-0.5 truncate text-xs text-dimmed">{entry.context || t.accountContext}</p>
                    </div>
                    <span class="text-xs text-dimmed">{dates.formatDateTimeRelative(entry.createdAt, { locale })}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Placeholder align="left" description={t.noRecentAccountActivity} />
            )}
          </section>
        </div>
      </AccountHub>
    </Layout>
  );
});
