import { listLegalLinks } from "@k2b/cloud";
import { type AccountCategory, resolveAccountCategoryLogin } from "@k2b/cloud/contracts";
import { auth, getLocale } from "@k2b/cloud/server";
import { appApproval, coreSettings, readAccountCategoryPolicy } from "@k2b/cloud/services";
import { LOCALE_COOKIE, normalizeRedirectTo, readLoginMethodFromCookieHeader } from "@k2b/cloud/shared";
import { LocaleProvider } from "@k2b/ui";
import { ssr } from "../../config";
import { useAppSignIn } from "../app-approval/availability";
import { appApprovalMessages } from "../app-approval/messages";
import AuthPage from "./AuthPage";
import LoginScreen, { type LoginScreenProps } from "./LoginScreen.island";
import { isReauthenticationRequest } from "./login-redirect";
import { authMessages } from "./messages";

/** Login page. */
export default ssr(async (c) => {
  const locale = getLocale(c);
  const t = authMessages.resolve([locale]).t;
  const confirmation = isReauthenticationRequest(c.req.url) ? appApprovalMessages.resolve([locale]).t : null;
  const [rawAppName, freeIpaEnabledRaw, allowSelfRegistrationRaw, contactEmailRaw, legalLinks, policy] = await Promise.all([
    coreSettings.get<string>("app.name"),
    coreSettings.get<boolean>("freeipa.enable"),
    coreSettings.get<boolean>("user.allow_self_registration"),
    coreSettings.get<string>("app.contact_email"),
    listLegalLinks(locale),
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

  const form: LoginScreenProps["form"] = isAdminLogin
    ? { kind: "admin", requiresRecovery: !policy.login.enabled }
    : useApproval && activeMethod
      ? {
          kind: "app",
          category: activeMethod,
          fallback: { href: credentialHref, label: activeMethod === "freeipa" ? t.usePasswordInstead : t.useEmailInstead },
          setupHint: activeMethod === "freeipa" ? t.appSetupPassword : t.appSetupEmail,
        }
      : isEmailLogin
        ? {
            kind: "email",
            token,
            category: activeMethod === "guest" || activeMethod === "login" ? activeMethod : undefined,
            allowSelfRegistration: allowSelfRegistration && policy.guest.enabled && activeMethod !== "login",
          }
        : activeMethod === "freeipa"
          ? { kind: "freeipa", showBanner: hasBanner === "true", defaultUsername: ipaUid }
          : { kind: "none" };

  return () => (
    <LocaleProvider locale={locale}>
      <AuthPage>
        <LoginScreen
          appName={appName}
          legalLinks={legalLinks}
          localeCookie={LOCALE_COOKIE}
          title={confirmation?.reauthenticate ?? formTitle}
          subtitle={confirmation?.recent ?? formSubtitle}
          categories={
            !isAdminLogin && visibleCategories.length > 1 && !token
              ? visibleCategories.map((category) => ({
                  value: category,
                  label: categoryLabel(category),
                  href: buildMethodUrl(category),
                  current: category === activeMethod,
                }))
              : null
          }
          form={form}
          redirectTo={redirectTo}
          forget={sharedWorkstation}
          signedOutIdle={signedOutIdle}
          others={
            !isAdminLogin && !token
              ? {
                  passkey: showPasskey,
                  appInstead: approvalEnabled && !useApproval && activeMethod && activeMethod !== "email" ? credentialHref : null,
                  supportHref,
                  adminHref,
                }
              : null
          }
        />
      </AuthPage>
    </LocaleProvider>
  );
});
