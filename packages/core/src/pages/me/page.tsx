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
import { ButtonLink, NoticeCard, Placeholder, SettingsSection } from "@k2b/ui";
import { ssr } from "../../config";
import AccountHub, { AccountPage, AccountProfileActions } from "./AccountHub";
import { pwaAvailable } from "./app-availability";
import { type AccountMessages, accountMessages } from "./messages";

// The page shell starts warning about an expiry 14 days ahead; the notice here only turns
// urgent from the same point, so an account with a distant expiry reads as a fact.
const EXPIRY_WARNING_DAYS = 14;

const accountExpiryNotice = (expiresAt: string, t: AccountMessages) => {
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { title: t.accountExpired, tone: "danger" } as const;
  return {
    title: days === 0 ? t.accountExpiresToday : t.accountExpiresIn({ count: days }),
    tone: days <= EXPIRY_WARNING_DAYS ? "warning" : "info",
  } as const;
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
  // Mirrors when the profile actions offer Extend account, so the notice has no empty action row.
  const canExtend = user.provider !== "ipa" || freeIpaEnabled;
  const expiryNotice = user.accountExpires ? accountExpiryNotice(user.accountExpires, t) : null;
  const address = formatAddress(user.ipa?.address ?? { street: null, postalCode: null, city: null, state: null });

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.account }]}>
      <AccountHub
        appTab={pwaAvailable(c)}
        loginLabel={categoryPolicy.login.label}
        user={user}
        active="profile"
        avatar={
          <AccountProfileActions user={user} appName={appName} freeIpaEnabled={freeIpaEnabled} actions={["avatar"]} trigger="avatar" />
        }
      >
        <AccountPage title={t.profile} description={t.profilePageDescription}>
          {(action === "extend" || user.accountExpires || pendingRequest || (user.provider === "ipa" && user.profile === "guest")) && (
            <div class="flex flex-col gap-2">
              {action === "extend" && <NoticeCard tone="info">{t.extendHint}</NoticeCard>}

              {expiryNotice && user.accountExpires && (
                <NoticeCard tone={expiryNotice.tone} title={expiryNotice.title}>
                  <p>{t.extendBefore({ date: dates.formatDate(user.accountExpires, { locale }) })}</p>
                  {canExtend && (
                    <div class="mt-2">
                      <AccountProfileActions user={user} appName={appName} freeIpaEnabled={freeIpaEnabled} actions={["extend"]} />
                    </div>
                  )}
                </NoticeCard>
              )}

              {pendingRequest && (
                <NoticeCard tone="info" title={t.requestPending}>
                  <p>{t.requestSubmitted({ date: dates.formatDate(pendingRequest.createdAt.toISOString(), { locale }) })}</p>
                  <ButtonLink href="/me/access" variant="secondary" size="sm" class="mt-2">
                    {t.access}
                    <i class="ti ti-arrow-right" aria-hidden="true" />
                  </ButtonLink>
                </NoticeCard>
              )}

              {user.provider === "ipa" && user.profile === "guest" && <NoticeCard tone="info">{t.limitedAccess}</NoticeCard>}
            </div>
          )}

          <SettingsSection
            title={t.profileTitle}
            subtitle={t.profileDescription}
            actions={
              <AccountProfileActions user={user} appName={appName} freeIpaEnabled={freeIpaEnabled} actions={["profile", "details"]} />
            }
          >
            <dl class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
              <div>
                <dt class="section-label mb-1">{t.displayName}</dt>
                <dd class="text-sm font-medium text-primary">{user.displayName || user.uid}</dd>
              </div>
              <div>
                <dt class="section-label mb-1">{t.username}</dt>
                <dd class="text-sm text-secondary">{user.uid}</dd>
              </div>
              <div>
                <dt class="section-label mb-1">{t.email}</dt>
                <dd class="break-words text-sm text-secondary">{user.mail ?? t.notSet}</dd>
              </div>
              <div>
                <dt class="section-label mb-1">{t.phone}</dt>
                <dd class="text-sm text-secondary">{user.ipa?.phone ?? t.notSet}</dd>
              </div>
              {user.ipa?.mobile && user.ipa.mobile !== user.ipa.phone && (
                <div>
                  <dt class="section-label mb-1">{t.mobile}</dt>
                  <dd class="text-sm text-secondary">{user.ipa.mobile}</dd>
                </div>
              )}
              {user.ipa?.employeeType && (
                <div>
                  <dt class="section-label mb-1">{t.employeeType}</dt>
                  <dd class="text-sm text-secondary">{user.ipa.employeeType}</dd>
                </div>
              )}
              <div class="sm:col-span-2">
                <dt class="section-label mb-1">{t.address}</dt>
                <dd class="text-sm text-secondary">{address ?? t.notSet}</dd>
              </div>
            </dl>
          </SettingsSection>

          <SettingsSection title={t.accountFacts} subtitle={t.accountFactsDescription}>
            <dl class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
              <div>
                <dt class="section-label mb-1">{t.accountType}</dt>
                <dd class="text-sm text-secondary">{accountCategoryLabel(user, categoryPolicy.login.label)}</dd>
              </div>
              <div>
                <dt class="section-label mb-1">{t.accountExpiry}</dt>
                <dd class="text-sm text-secondary">
                  {user.accountExpires ? dates.formatDate(user.accountExpires, { locale }) : t.noExpiry}
                </dd>
              </div>
              <div>
                <dt class="section-label mb-1">{t.passwordExpiry}</dt>
                <dd class="text-sm text-secondary">
                  {user.ipa?.passwordExpires ? dates.formatDate(user.ipa.passwordExpires, { locale }) : t.notApplicable}
                </dd>
              </div>
              <div>
                <dt class="section-label mb-1">{t.sshKeys}</dt>
                <dd class="text-sm text-secondary">{t.configuredKeys({ count: user.ipa?.sshPublicKeys.length ?? 0 })}</dd>
              </div>
            </dl>
          </SettingsSection>

          <ul class="-mx-3 grid gap-1 sm:grid-cols-2">
            {(
              [
                {
                  href: "/me/security",
                  icon: "ti ti-shield-lock",
                  title: t.security,
                  summary: `${t.passkeyCount({ count: passkeys.length })} · ${
                    activityPage.items.length > 0 ? t.recentActivityAvailable : t.noRecentActivity
                  }`,
                },
                {
                  href: "/me/access",
                  icon: "ti ti-users-group",
                  title: t.accessAndGroups,
                  summary: t.membershipSummary({ direct: user.memberofGroup.length, managed: user.manages.length }),
                },
                {
                  href: "/me/notifications",
                  icon: "ti ti-bell",
                  title: t.notifications,
                  summary: customizedNotifications > 0 ? t.customizedPreferences({ count: customizedNotifications }) : t.usingAppDefaults,
                },
                {
                  href: "/me/developer",
                  icon: "ti ti-terminal-2",
                  title: t.developer,
                  summary: t.apiKeySummary({ count: apiKeys.length }),
                },
              ] satisfies { href: string; icon: string; title: string; summary: string }[]
            ).map((link) => (
              <li>
                <a
                  href={link.href}
                  class="flex items-start gap-3 rounded-[var(--ui-radius-surface)] p-3 no-underline transition-colors hover:bg-[var(--ui-hover)]"
                >
                  <i class={`${link.icon} mt-0.5 text-dimmed`} aria-hidden="true" />
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-semibold text-primary">{link.title}</span>
                    <span class="mt-1 block text-xs text-dimmed">{link.summary}</span>
                  </span>
                  <i class="ti ti-chevron-right mt-0.5 text-dimmed" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>

          <SettingsSection
            title={t.recentSecurityActivity}
            subtitle={t.recentSecurityActivityDescription}
            actions={
              <ButtonLink href="/me/security" variant="ghost" size="sm">
                {t.viewAll}
                <i class="ti ti-arrow-right" aria-hidden="true" />
              </ButtonLink>
            }
          >
            {activityPage.items.length > 0 ? (
              <ul class="flex flex-col gap-1 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-2">
                {activityPage.items.slice(0, 3).map((entry) => (
                  <li class="grid gap-1 rounded-[var(--ui-radius-control)] p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <div class="min-w-0">
                      <p class="truncate text-sm font-medium text-primary">{entry.label}</p>
                      <p class="mt-0.5 truncate text-xs text-dimmed">{entry.context || t.accountContext}</p>
                    </div>
                    <span class="text-xs text-dimmed">{dates.formatDateTimeRelative(entry.createdAt, { locale })}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Placeholder align="left" description={t.noRecentAccountActivity} />
            )}
          </SettingsSection>
        </AccountPage>
      </AccountHub>
    </Layout>
  );
});
