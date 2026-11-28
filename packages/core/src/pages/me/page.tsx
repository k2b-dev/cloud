import { type AuthContext, getLocale, isAppSessionActor } from "@k2b/cloud/server";
import { accountsAppService, coreSettings, readAccountCategoryPolicy, serviceAccountCredentials, webauthn } from "@k2b/cloud/services";
import { screenPreferences } from "@k2b/cloud/services/screen-preferences";
import { sharedWorkstationIdleSeconds } from "@k2b/cloud/services/session/shared-workstation";
import { canManageAnyGroups, groupDisplayName } from "@k2b/cloud/shared";
import { getRuntimeContext, hasDedicatedRuntimeRoute, Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { keyboardPlatform } from "@k2b/ui";
import { ssr } from "../../config";
import { accountCategoryWords, accountRoles, accountUserView } from "./account-view";
import { type AccountMessages, accountMessages } from "./messages";
import ProfileScreen from "./ProfileScreen.island";
import { profileActionsUser } from "./profile-actions-user";

/** The groups the first view of the profile shows; "All groups" shows the rest. */
const GROUPS_FIRST = 6;

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
  const locale = getLocale(c);
  const { t } = accountMessages.resolve([locale]);
  // "All groups" adds the ones the person belongs to through another group
  const allGroups = c.req.query("groups") === "all";
  // Only a browser session can mark its browser as a shared workstation; the mobile app's phone never is one.
  const browserSession = !isAppSessionActor(c.get("actor"));
  // Every read of the first view is independent of the others: one round.
  const [
    categoryPolicy,
    rawAppName,
    freeIpaEnabledRaw,
    requestsEnabled,
    pendingRequest,
    apiKeys,
    passkeys,
    screen,
    directGroups,
    everyGroup,
    idleSeconds,
  ] = await Promise.all([
    readAccountCategoryPolicy(),
    coreSettings.get<string>("app.name"),
    coreSettings.get<boolean>("freeipa.enable"),
    user.provider === "local" ? accountsAppService.accountRequest.isEnabled() : Promise.resolve(false),
    user.provider === "local" ? accountsAppService.accountRequest.getPendingForUser({ userId: user.id }) : Promise.resolve(null),
    serviceAccountCredentials.listForDelegatedUser({ userId: user.id }),
    webauthn.listForUser({ userId: user.id }),
    screenPreferences.get(user.id),
    accountsAppService.user.group.list({ userId: user.id, recursive: false }).then((list) => list.items),
    allGroups ? accountsAppService.user.group.list({ userId: user.id, recursive: true }).then((list) => list.items) : Promise.resolve(null),
    browserSession ? sharedWorkstationIdleSeconds() : Promise.resolve(null),
  ]);
  const appName = rawAppName || "Cloud";
  const freeIpaEnabled = Boolean(freeIpaEnabledRaw);
  const platform = keyboardPlatform(c.req.header("User-Agent") ?? "");
  const sharedWorkstation = idleSeconds === null ? undefined : { userId: user.id, minutes: Math.round(idleSeconds / 60) };
  // A local account may ask for a FreeIPA account while the installation takes requests, and may always withdraw one.
  const freeIpaOffered =
    user.provider === "local" && ((requestsEnabled && freeIpaEnabled && categoryPolicy.freeipa.enabled) || pendingRequest !== null);
  const managed = canManageAnyGroups(user) ? user.manages : [];
  // Each group stands once, in the place of its strongest part: managed before member before inherited. The first view
  // shows the first six; "All groups" (always offered, as only it shows the inherited ones) shows every one.
  const parted = [
    ...managed.map((name) => ({ name, part: "managed" as const })),
    ...directGroups.filter((name) => !managed.includes(name)).map((name) => ({ name, part: "member" as const })),
    ...(everyGroup ?? [])
      .filter((name) => !managed.includes(name) && !directGroups.includes(name))
      .map((name) => ({ name, part: "inherited" as const })),
  ];
  const groups = (allGroups ? parted : parted.slice(0, GROUPS_FIRST)).map((group) => ({
    ...group,
    label: groupDisplayName(group.name, locale),
  }));
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
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.profile }]}>
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
        groups={{
          items: groups,
          all: allGroups,
          accountsUi: hasDedicatedRuntimeRoute(getRuntimeContext(c).apps, "/app/accounts/groups", "core"),
        }}
        freeIpa={
          freeIpaOffered
            ? { pendingSince: pendingRequest ? dates.formatDate(pendingRequest.createdAt.toISOString(), { locale }) : null }
            : null
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
          groups: { value: String(directGroups.length), meta: t.managedCount({ count: managed.length }) },
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
