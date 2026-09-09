import { ButtonLink, LocaleProvider, NoticeCard } from "@k2b/ui";
import { listLegalLinks } from "@valentinkolb/cloud";
import { type AccountCategory, resolveAccountCategoryLogin } from "@valentinkolb/cloud/contracts";
import { getLocale } from "@valentinkolb/cloud/server";
import { appApproval, coreSettings, readAccountCategoryPolicy } from "@valentinkolb/cloud/services";
import { normalizeRedirectTo, readLoginMethodFromCookieHeader, readThemeFromCookieHeader } from "@valentinkolb/cloud/shared";
import { ssr } from "../../config";
import { useAppSignIn } from "../app-approval/availability";
import { appApprovalMessages } from "../app-approval/messages";
import AccountCategorySwitch from "./AccountCategorySwitch.island";
import AdminLoginForm from "./AdminLoginForm.island";
import AppLoginForm from "./AppLoginForm.island";
import GuestLoginForm from "./GuestLoginForm.island";
import LoginForm from "./LoginForm.island";
import { isReauthenticationRequest } from "./login-redirect";
import { authMessages } from "./messages";
import PasskeyLoginButton from "./PasskeyLoginButton.island";

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

  const cookie = c.req.raw.headers.get("Cookie") ?? "";
  c.get("page").theme = readThemeFromCookieHeader(cookie);
  const persistedLoginMethod = readLoginMethodFromCookieHeader(cookie);

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
    useAppSignIn(approvalEnabled, params.get("credential"), activeMethod) &&
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

  return () => (
    <LocaleProvider locale={locale}>
      <div class="min-h-screen bg-zinc-50 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50">
        <div class="flex min-h-screen flex-col items-center justify-center gap-5 p-4">
          <div class="grid w-full max-w-5xl overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_16px_48px_rgb(24_24_27/0.12)] dark:border-zinc-800 dark:bg-zinc-950 [@media(min-width:560px)]:grid-cols-[0.9fr_1.1fr]">
            <aside class="flex flex-col justify-between border-r border-zinc-200 bg-zinc-50 p-8 dark:border-zinc-800 dark:bg-zinc-900/60 [@media(max-width:559px)]:hidden">
              <div class="flex flex-1 items-center justify-center">
                <div class="flex flex-col items-center gap-4 text-center">
                  <img
                    src="/branding/logo"
                    alt={appName}
                    width="112"
                    height="112"
                    class="max-h-28 max-w-28 object-contain"
                    style={{ "view-transition-name": "logo" }}
                  />
                  <div>
                    <p class="text-lg font-semibold text-primary">{appName}</p>
                  </div>
                </div>
              </div>

              <div class="max-w-md">
                <h1 class="text-3xl font-semibold tracking-tight text-primary" style={{ "view-transition-name": "page-title" }}>
                  {t.welcomeBack}
                </h1>
                <p class="mt-4 text-sm leading-6 text-dimmed">{t.welcomeDescription}</p>
              </div>
            </aside>

            <main class="flex justify-center p-6 sm:p-10">
              <div class="flex min-h-[32rem] w-full max-w-md flex-col sm:min-h-[36rem]" style={{ "view-transition-name": "login-card" }}>
                <div>
                  <h1 class="sr-only">{t.signIn}</h1>
                  <h2 class="text-3xl font-semibold tracking-tight text-primary">{confirmation?.reauthenticate ?? formTitle}</h2>
                  {(confirmation?.recent || formSubtitle) && <p class="mt-1 text-sm text-dimmed">{confirmation?.recent ?? formSubtitle}</p>}
                </div>

                {!isAdminLogin && visibleCategories.length > 1 && !token && (
                  <div class="mt-6" style={{ "view-transition-name": "login-switch" }}>
                    <AccountCategorySwitch
                      options={visibleCategories.map((category) => ({
                        value: category,
                        label: categoryLabel(category),
                        href: buildMethodUrl(category),
                      }))}
                      value={activeMethod}
                      ariaLabel={t.fallbackMethod}
                    />
                  </div>
                )}

                <div class="flex flex-1 flex-col justify-center gap-4 py-7">
                  {isAdminLogin ? (
                    <AdminLoginForm redirectTo={redirectTo} requiresRecovery={!policy.login.enabled} />
                  ) : useApproval && activeMethod ? (
                    <AppLoginForm
                      category={activeMethod}
                      redirectTo={redirectTo}
                      fallback={{ href: credentialHref, label: activeMethod === "freeipa" ? t.usePasswordInstead : t.useEmailInstead }}
                      setupHint={activeMethod === "freeipa" ? t.appSetupPassword : t.appSetupEmail}
                    />
                  ) : isEmailLogin ? (
                    <GuestLoginForm
                      redirectTo={redirectTo}
                      token={token}
                      category={activeMethod === "guest" || activeMethod === "login" ? activeMethod : undefined}
                      allowSelfRegistration={allowSelfRegistration && policy.guest.enabled && activeMethod !== "login"}
                    />
                  ) : activeMethod === "freeipa" ? (
                    <LoginForm redirectTo={redirectTo} showBanner={hasBanner === "true"} defaultUsername={ipaUid} appName={appName} />
                  ) : (
                    <NoticeCard tone="info">{t.noLoginAvailable}</NoticeCard>
                  )}
                  {approvalEnabled && !useApproval && !token && !isAdminLogin && activeMethod && activeMethod !== "email" && (
                    <ButtonLink href={credentialHref} variant="secondary" class="w-full justify-center" size="lg">
                      {t.useAppInstead}
                    </ButtonLink>
                  )}
                </div>

                {!isAdminLogin && !token && (
                  <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-dimmed">
                    <ButtonLink href={supportHref} variant="secondary" size="sm">
                      <i class="ti ti-lifebuoy" />
                      {t.contactSupport}
                    </ButtonLink>
                    {showPasskey && <PasskeyLoginButton redirectTo={redirectTo} />}
                    <ButtonLink href={adminHref} variant="secondary" size="sm">
                      <i class="ti ti-shield" />
                      {t.adminToken}
                    </ButtonLink>
                  </div>
                )}
              </div>
            </main>
          </div>
          <div class="text-center text-xs text-dimmed">
            {legalLinks.map((link, i) => (
              <>
                {i > 0 ? " · " : null}
                <a href={link.href} target="_blank" class="hover:text-primary">
                  {link.label}
                </a>
              </>
            ))}
          </div>
        </div>
      </div>
    </LocaleProvider>
  );
});
