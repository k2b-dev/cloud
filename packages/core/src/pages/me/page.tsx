import { type AuthContext, getLocale, isAppSessionActor } from "@k2b/cloud/server";
import { accountsAppService, coreSettings, readAccountCategoryPolicy, serviceAccountCredentials, webauthn } from "@k2b/cloud/services";
import { screenPreferences } from "@k2b/cloud/services/screen-preferences";
import { sharedWorkstationIdleSeconds } from "@k2b/cloud/services/session/shared-workstation";
import { Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { keyboardPlatform } from "@k2b/ui";
import { ssr } from "../../config";
import { accountCategoryWords, accountRoles, accountUserView } from "./account-view";
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
  const [pendingRequest, apiKeys, passkeys, screen] = await Promise.all([
    user.provider === "local" ? accountsAppService.accountRequest.getPendingForUser({ userId: user.id }) : Promise.resolve(null),
    serviceAccountCredentials.listForDelegatedUser({ userId: user.id }),
    webauthn.listForUser({ userId: user.id }),
    screenPreferences.get(user.id),
  ]);
  // Only a browser session can mark its browser as a shared workstation; the mobile app's phone never is one.
  const sharedWorkstation = isAppSessionActor(c.get("actor"))
    ? undefined
    : { userId: user.id, minutes: Math.round((await sharedWorkstationIdleSeconds()) / 60) };
  const action = c.req.query("action");
  const expiryNotice = user.accountExpires ? accountExpiryNotice(user.accountExpires, t) : null;
  const address = formatAddress(user.ipa?.address ?? { street: null, postalCode: null, city: null, state: null });

  const formatted = (value: string | null | undefined, fallback: string) => (value ? dates.formatDate(value, { locale }) : fallback);
  const now = new Date();
  const lastUse = passkeys
    .map((passkey) => passkey.lastUsedAt)
    .filter((value) => value !== null)
    .sort()
    .at(-1);
  // the key that stops working first, among those still active
  const nextKeyExpiry = apiKeys
    .filter((key) => key.status === "active" && key.expiresAt !== null && Date.parse(key.expiresAt) > now.getTime())
    .map((key) => key.expiresAt as string)
    .sort()
    .at(0);

  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.account }]}>
      <ProfileScreen
        user={accountUserView(user, t, now)}
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
          // the name and the username stand in the head
          { label: t.email, value: user.mail ?? t.notSet },
          { label: t.phone, value: user.ipa?.phone ?? t.notSet },
          ...(user.ipa?.mobile && user.ipa.mobile !== user.ipa.phone ? [{ label: t.mobile, value: user.ipa.mobile }] : []),
          ...(user.ipa?.employeeType ? [{ label: t.employeeType, value: user.ipa.employeeType }] : []),
          { label: t.address, value: address ?? t.notSet },
        ]}
        accountFacts={[
          { label: t.accountType, value: accountCategoryWords(user, categoryPolicy.login.label, t) },
          ...(accountRoles(user, t).length > 0 ? [{ label: t.roles, value: accountRoles(user, t).join(", ") }] : []),
          ...(user.ipa?.passwordExpires ? [{ label: t.passwordExpiry, value: formatted(user.ipa.passwordExpires, t.notApplicable) }] : []),
          { label: t.sshKeys, value: t.configuredKeys({ count: user.ipa?.sshPublicKeys.length ?? 0 }) },
        ]}
        screen={{ timerSeconds: screen.privacyTimerSeconds, platform, sharedWorkstation }}
        figures={{
          validity: user.accountExpires
            ? {
                value: dates.formatDate(user.accountExpires, { locale }),
                meta: expiryNotice?.title ?? "",
                ...(expiryNotice && expiryNotice.tone !== "note" ? { status: expiryNotice.tone } : {}),
              }
            : { value: t.noExpiry, meta: accountCategoryWords(user, categoryPolicy.login.label, t) },
          passkeys:
            passkeys.length > 0
              ? {
                  value: String(passkeys.length),
                  meta: lastUse ? t.lastSignIn({ date: dates.formatDateTimeRelative(lastUse, { locale, base: now }) }) : t.neverUsed,
                }
              : { value: "0", meta: t.noPasskeyYet, status: "warn" },
          groups: { value: String(user.memberofGroup.length), meta: t.managedCount({ count: user.manages.length }) },
          apiKeys: {
            value: String(apiKeys.length),
            meta: nextKeyExpiry
              ? t.nextKeyExpiry({ date: dates.formatDate(nextKeyExpiry, { locale }) })
              : apiKeys.length > 0
                ? t.keysWithoutExpiry
                : t.cliAndSsh,
          },
        }}
      />
    </Layout>
  );
});
