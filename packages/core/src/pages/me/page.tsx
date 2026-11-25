import { accountCategoryLabel } from "@k2b/cloud/contracts";
import { type AuthContext, getLocale, isAppSessionActor } from "@k2b/cloud/server";
import {
  accountsAppService,
  audit,
  coreSettings,
  notifications,
  readAccountCategoryPolicy,
  serviceAccountCredentials,
  webauthn,
} from "@k2b/cloud/services";
import { screenPreferences } from "@k2b/cloud/services/screen-preferences";
import { sharedWorkstationIdleSeconds } from "@k2b/cloud/services/session/shared-workstation";
import { Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { keyboardPlatform } from "@k2b/ui";
import { ssr } from "../../config";
import { accountUserView } from "./account-view";
import { pwaAvailable } from "./app-availability";
import { type AccountMessages, accountMessages } from "./messages";
import ProfileScreen from "./ProfileScreen.island";
import { profileActionsUser } from "./profile-actions-user";

// The page shell starts warning about an expiry 14 days ahead; the notice here only turns
// urgent from the same point, so an account with a distant expiry reads as a fact.
const EXPIRY_WARNING_DAYS = 14;

const accountExpiryNotice = (expiresAt: string, t: AccountMessages) => {
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { title: t.accountExpired, tone: "bad" } as const;
  return {
    title: days === 0 ? t.accountExpiresToday : t.accountExpiresIn({ count: days }),
    tone: days <= EXPIRY_WARNING_DAYS ? "warn" : "note",
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
  const platform = keyboardPlatform(c.req.header("User-Agent") ?? "");
  const [pendingRequest, apiKeys, passkeys, activityPage, notificationPreferences, screen] = await Promise.all([
    user.provider === "local" ? accountsAppService.accountRequest.getPendingForUser({ userId: user.id }) : Promise.resolve(null),
    serviceAccountCredentials.listForDelegatedUser({ userId: user.id }),
    webauthn.listForUser({ userId: user.id }),
    audit.listSelfServiceActivity({ userId: user.id, days: 30, pagination: { page: 1, perPage: 5 } }),
    notifications.user.preferences.list(user.id, locale),
    screenPreferences.get(user.id),
  ]);
  // Only a browser session can mark its browser as a shared workstation; the mobile app's phone never is one.
  const sharedWorkstation = isAppSessionActor(c.get("actor"))
    ? undefined
    : { userId: user.id, minutes: Math.round((await sharedWorkstationIdleSeconds()) / 60) };
  const customizedNotifications = notificationPreferences.definitions.filter((preference) => preference.customized).length;
  const action = c.req.query("action");
  const expiryNotice = user.accountExpires ? accountExpiryNotice(user.accountExpires, t) : null;
  const address = formatAddress(user.ipa?.address ?? { street: null, postalCode: null, city: null, state: null });

  const formatted = (value: string | null | undefined, fallback: string) => (value ? dates.formatDate(value, { locale }) : fallback);
  const now = new Date();

  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.account }]}>
      <ProfileScreen
        user={accountUserView(user, categoryPolicy.login.label, t, now)}
        appTab={pwaAvailable(c)}
        actionsUser={profileActionsUser(user)}
        appName={appName}
        freeIpaEnabled={freeIpaEnabled}
        extendHint={action === "extend"}
        expiry={
          expiryNotice && user.accountExpires
            ? {
                title: expiryNotice.title,
                tone: expiryNotice.tone,
                before: t.extendBefore({ date: dates.formatDate(user.accountExpires, { locale }) }),
              }
            : null
        }
        pendingRequest={
          pendingRequest ? t.requestSubmitted({ date: dates.formatDate(pendingRequest.createdAt.toISOString(), { locale }) }) : null
        }
        limitedAccess={user.provider === "ipa" && user.profile === "guest"}
        profileFacts={[
          { label: t.displayName, value: user.displayName || user.uid },
          { label: t.username, value: user.uid },
          { label: t.email, value: user.mail ?? t.notSet },
          { label: t.phone, value: user.ipa?.phone ?? t.notSet },
          ...(user.ipa?.mobile && user.ipa.mobile !== user.ipa.phone ? [{ label: t.mobile, value: user.ipa.mobile }] : []),
          ...(user.ipa?.employeeType ? [{ label: t.employeeType, value: user.ipa.employeeType }] : []),
          { label: t.address, value: address ?? t.notSet },
        ]}
        accountFacts={[
          { label: t.accountType, value: accountCategoryLabel(user, categoryPolicy.login.label) },
          { label: t.accountExpiry, value: formatted(user.accountExpires, t.noExpiry) },
          { label: t.passwordExpiry, value: formatted(user.ipa?.passwordExpires, t.notApplicable) },
          { label: t.sshKeys, value: t.configuredKeys({ count: user.ipa?.sshPublicKeys.length ?? 0 }) },
        ]}
        screen={{ timerSeconds: screen.privacyTimerSeconds, platform, sharedWorkstation }}
        summaries={{
          security: `${t.passkeyCount({ count: passkeys.length })} · ${activityPage.items.length > 0 ? t.recentActivityAvailable : t.noRecentActivity}`,
          access: t.membershipSummary({ direct: user.memberofGroup.length, managed: user.manages.length }),
          notifications: customizedNotifications > 0 ? t.customizedPreferences({ count: customizedNotifications }) : t.usingAppDefaults,
          developer: t.apiKeySummary({ count: apiKeys.length }),
        }}
        activity={activityPage.items.slice(0, 3).map((entry) => ({
          label: entry.label,
          context: entry.context || t.accountContext,
          // relative to the time of this answer, so the server and the first paint agree
          when: dates.formatDateTimeRelative(entry.createdAt, { locale, base: now }),
        }))}
      />
    </Layout>
  );
});
