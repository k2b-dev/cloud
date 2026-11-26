import { type AccountCategory, resolveAccountCategoryLogin } from "@k2b/cloud/contracts";
import { auth, getLocale } from "@k2b/cloud/server";
import { appApproval, coreSettings, readAccountCategoryPolicy } from "@k2b/cloud/services";
import { normalizeRedirectTo, readLoginMethodFromCookieHeader } from "@k2b/cloud/shared";
import { Band, Bar, Button, Inline, Notice, Tabs, Text } from "@k2b/ui/v2";
import { ssr } from "../../config";
import { useAppSignIn } from "../app-approval/availability";
import { appApprovalMessages } from "../app-approval/messages";
import { VisitorPage } from "../VisitorPage";
import AdminLoginForm from "./AdminLoginForm.island";
import AppLoginForm from "./AppLoginForm.island";
import GuestLoginForm from "./GuestLoginForm.island";
import IdleSignOutFinish from "./IdleSignOutFinish.island";
import LoginForm from "./LoginForm.island";
import { isReauthenticationRequest } from "./login-redirect";
import { authMessages } from "./messages";
import PasskeyLoginButton from "./PasskeyLoginButton.island";

/** Login page. */
export default ssr(async (c) => {
  const locale = getLocale(c);
  const t = authMessages.resolve([locale]).t;
  const confirmation = isReauthenticationRequest(c.req.url) ? appApprovalMessages.resolve([locale]).t : null;
  const [rawAppName, freeIpaEnabledRaw, allowSelfRegistrationRaw, contactEmailRaw, policy] = await Promise.all([
    coreSettings.get<string>("app.name"),
    coreSettings.get<boolean>("freeipa.enable"),
    coreSettings.get<boolean>("user.allow_self_registration"),
    coreSettings.get<string>("app.contact_email"),
    readAccountCategoryPolicy(),
  ]);
  const appName = rawAppName || "My App";
  const approvalEnabled = await appApproval
    .config()
    .then((config) => config.enabled)
    .catch(() => false);
  const freeIpaEnabled = Boolean(freeIpaEnabledRaw);
  const allowSelfRegistration = Boolean(allowSelfRegistrationRaw);
  const contactEmail = contactEmailRaw?.trim();
  const params = new URL(c.req.url).searchParams;
  const redirectTo = normalizeRedirectTo(params.get("redirectTo"));
  const token = params.get("token") ?? undefined;
  const method = params.get("method") ?? undefined;
  const hasBanner = params.get("banner") ?? undefined;
  const ipaUid = params.get("ipa-uid") ?? undefined;
  const hide = params.get("hide") ?? undefined;

  // A shared workstation remembers nothing about sign-ins: no method, no credential choice, no autofilled account.
  const sharedWorkstation = auth.session.isSharedWorkstation(c);
  const cookie = sharedWorkstation ? "" : (c.req.raw.headers.get("Cookie") ?? "");
  const persistedLoginMethod = readLoginMethodFromCookieHeader(cookie);
  const signedOutIdle = params.get("signedOut") === "idle";

  // If guest is hidden, force IPA method
  const isGuestHidden = freeIpaEnabled && hide === "guest";

  // Admin login: hidden method, no switch link, no cookie interaction
  const isAdminLogin = method === "admin" && !token;

  const { active: activeMethod, visible: visibleCategories } = resolveAccountCategoryLogin({
    policy,
    freeIpaEnabled,
    hasToken: Boolean(token),
    hideGuest: isGuestHidden,
    method,
    remembered: persistedLoginMethod,
  });

  const isEmailLogin = activeMethod === "email" || activeMethod === "guest" || activeMethod === "login";
  const useApproval =
    useAppSignIn({ configured: approvalEnabled, category: activeMethod, credential: params.get("credential"), cookieHeader: cookie }) &&
    !token &&
    !isAdminLogin &&
    activeMethod &&
    activeMethod !== "email";
  const categoryLabel = (category: AccountCategory) =>
    category === "login" ? policy.login.label : category === "guest" ? "Guest" : "FreeIPA";

  const buildMethodUrl = (nextMethod: AccountCategory | "admin") => {
    const methodParams = new URLSearchParams();
    methodParams.set("method", nextMethod === "freeipa" ? "ipa" : nextMethod);
    if (redirectTo) methodParams.set("redirectTo", redirectTo);
    if (hide && freeIpaEnabled && nextMethod === "freeipa") methodParams.set("hide", hide);
    if (hasBanner && nextMethod === "freeipa") methodParams.set("banner", hasBanner);
    if (ipaUid && nextMethod === "freeipa") methodParams.set("ipa-uid", ipaUid);
    return `/auth/login?${methodParams.toString()}`;
  };
  const adminHref = buildMethodUrl("admin");
  const supportHref = contactEmail ? `mailto:${contactEmail}` : "/impressum";
  const credentialParams = new URLSearchParams(params);
  credentialParams.delete("token");
  credentialParams.set("credential", useApproval ? "legacy" : "app");
  const credentialHref = `/auth/login?${credentialParams}`;
  const showPasskey = !isAdminLogin && !token && !!activeMethod;
  const formTitle = isAdminLogin ? t.adminToken : token ? t.completeEmailSignIn : t.signIn;
  const formSubtitle = isAdminLogin
    ? t.adminTokenDescription
    : token
      ? t.verifyingEmailLink
      : useApproval
        ? t.appLoginIntro
        : isEmailLogin
          ? t.emailLoginIntro
          : activeMethod === "freeipa"
            ? t.passwordLoginIntro
            : null;

  c.get("page").title = t.signIn;
  const title = confirmation?.reauthenticate ?? formTitle;
  const description = confirmation?.recent ?? formSubtitle;
  // Where app sign-in is set up, the password and email forms offer it beside their own action.
  const appAlternative =
    approvalEnabled && !useApproval && !token && !isAdminLogin && activeMethod && activeMethod !== "email"
      ? { href: credentialHref, label: t.useAppInstead }
      : undefined;
  // The account types as tabs: each is its own address, so reload and back show the same.
  const categoryTabs =
    !isAdminLogin && visibleCategories.length > 1 && !token
      ? visibleCategories.map((category) => ({
          label: categoryLabel(category),
          href: buildMethodUrl(category),
          current: category === activeMethod,
        }))
      : [];

  return () => (
    <VisitorPage c={c} appName={appName} title={title} description={description}>
      {categoryTabs.length > 0 && <Bar start={<Tabs label={t.fallbackMethod} items={categoryTabs} />} />}
      {signedOutIdle && (
        <>
          <IdleSignOutFinish />
          <Notice tone="note" icon="clock">
            {t.signedOutIdle}
          </Notice>
        </>
      )}
      {isAdminLogin ? (
        <AdminLoginForm redirectTo={redirectTo} requiresRecovery={!policy.login.enabled} />
      ) : useApproval && activeMethod ? (
        <AppLoginForm
          category={activeMethod}
          redirectTo={redirectTo}
          fallback={{ href: credentialHref, label: activeMethod === "freeipa" ? t.usePasswordInstead : t.useEmailInstead }}
          forget={sharedWorkstation}
        />
      ) : isEmailLogin ? (
        <GuestLoginForm
          redirectTo={redirectTo}
          token={token}
          category={activeMethod === "guest" || activeMethod === "login" ? activeMethod : undefined}
          allowSelfRegistration={allowSelfRegistration && policy.guest.enabled && activeMethod !== "login"}
          forget={sharedWorkstation}
          alternative={token ? undefined : appAlternative}
        />
      ) : activeMethod === "freeipa" ? (
        <LoginForm
          redirectTo={redirectTo}
          showBanner={hasBanner === "true"}
          defaultUsername={ipaUid}
          appName={appName}
          forget={sharedWorkstation}
          alternative={appAlternative}
        />
      ) : (
        <Notice tone="warn">{t.noLoginAvailable}</Notice>
      )}
      {sharedWorkstation && !signedOutIdle && (
        <Band>
          <Text type="meta" muted>
            {t.sharedWorkstationHint}
          </Text>
        </Band>
      )}
      {!isAdminLogin && !token && (
        // One line in the flow of the column, from the text edge, in the size of the bar above; it wraps on a narrow
        // phone, never a staircase.
        <Bar
          start={
            <Inline>
              {showPasskey && <PasskeyLoginButton redirectTo={redirectTo} forget={sharedWorkstation} />}
              <Button variant="ghost" icon="lifebuoy" href={supportHref}>
                {t.contactSupport}
              </Button>
              <Button variant="ghost" icon="shield" href={adminHref}>
                {t.adminToken}
              </Button>
            </Inline>
          }
        />
      )}
    </VisitorPage>
  );
});
