import { accountCategoryLabel } from "@k2b/cloud/contracts";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import {
  accountsAppService,
  audit,
  coreSettings,
  notifications,
  readAccountCategoryPolicy,
  serviceAccountCredentials,
  webauthn,
} from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { ButtonLink, NoticeCard, Placeholder } from "@k2b/ui";
import { ssr } from "../../config";
import AccountHub, { AccountPageHeader, AccountProfileActions } from "./AccountHub";
import { type AccountMessages, accountMessages } from "./messages";

const accountExpiryCopy = (expiresAt: string, t: AccountMessages): string => {
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return t.accountExpired;
  if (days === 0) return t.accountExpiresToday;
  return t.accountExpiresIn({ count: days });
};

const formatAddress = (address: {
  street: string | null;
  postalCode: string | null;
  city: string | null;
  state: string | null;
}): string | null => {
  const parts = [address.street, [address.postalCode, address.city].filter(Boolean).join(" "), address.state].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
};

export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
  const categoryPolicy = await readAccountCategoryPolicy();
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
    notifications.user.preferences.list(user.id, locale),
  ]);
  const customizedNotifications = notificationPreferences.definitions.filter((preference) => preference.customized).length;
  const action = c.req.query("action");
  const address = formatAddress(user.ipa?.address ?? { street: null, postalCode: null, city: null, state: null });

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.account }]}>
      <AccountHub
        loginLabel={categoryPolicy.login.label}
        user={user}
        active="profile"
        avatar={
          <AccountProfileActions user={user} appName={appName} freeIpaEnabled={freeIpaEnabled} actions={["avatar"]} trigger="avatar" />
        }
      >
        <div class="flex flex-col gap-2">
          <AccountPageHeader title={t.profile} description={t.profilePageDescription} />

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

          <section class="paper p-5 sm:p-6">
            <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <h3 class="text-sm font-semibold text-primary">{t.profileTitle}</h3>
                <p class="mt-1 text-xs text-dimmed">{t.profileDescription}</p>
              </div>
              <AccountProfileActions user={user} appName={appName} freeIpaEnabled={freeIpaEnabled} actions={["profile", "details"]} />
            </div>
            <div class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
              <div>
                <p class="section-label mb-1">{t.displayName}</p>
                <p class="text-sm font-medium text-primary">{user.displayName || user.uid}</p>
              </div>
              <div>
                <p class="section-label mb-1">{t.username}</p>
                <p class="text-sm text-secondary">{user.uid}</p>
              </div>
              <div>
                <p class="section-label mb-1">{t.email}</p>
                <p class="break-words text-sm text-secondary">{user.mail ?? t.notSet}</p>
              </div>
              <div>
                <p class="section-label mb-1">{t.phone}</p>
                <p class="text-sm text-secondary">{user.ipa?.phone ?? t.notSet}</p>
              </div>
              {user.ipa?.mobile && user.ipa.mobile !== user.ipa.phone && (
                <div>
                  <p class="section-label mb-1">{t.mobile}</p>
                  <p class="text-sm text-secondary">{user.ipa.mobile}</p>
                </div>
              )}
              {user.ipa?.employeeType && (
                <div>
                  <p class="section-label mb-1">{t.employeeType}</p>
                  <p class="text-sm text-secondary">{user.ipa.employeeType}</p>
                </div>
              )}
              <div class="sm:col-span-2">
                <p class="section-label mb-1">{t.address}</p>
                <p class="text-sm text-secondary">{address ?? t.notSet}</p>
              </div>
            </div>
          </section>

          <section class="paper p-5 sm:p-6">
            <div class="mb-5">
              <h3 class="text-sm font-semibold text-primary">{t.accountFacts}</h3>
              <p class="mt-1 text-xs text-dimmed">{t.accountFactsDescription}</p>
            </div>
            <div class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
              <div>
                <p class="section-label mb-1">{t.accountType}</p>
                <p class="text-sm text-secondary">{accountCategoryLabel(user, categoryPolicy.login.label)}</p>
              </div>
              <div>
                <p class="section-label mb-1">{t.accountExpiry}</p>
                <p class="text-sm text-secondary">{user.accountExpires ? dates.formatDate(user.accountExpires, { locale }) : t.noExpiry}</p>
              </div>
              <div>
                <p class="section-label mb-1">{t.passwordExpiry}</p>
                <p class="text-sm text-secondary">
                  {user.ipa?.passwordExpires ? dates.formatDate(user.ipa.passwordExpires, { locale }) : t.notApplicable}
                </p>
              </div>
              <div>
                <p class="section-label mb-1">{t.sshKeys}</p>
                <p class="text-sm text-secondary">{t.configuredKeys({ count: user.ipa?.sshPublicKeys.length ?? 0 })}</p>
              </div>
            </div>
          </section>

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
