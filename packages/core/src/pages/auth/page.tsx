import { ButtonLink, LocaleProvider } from "@k2b/ui";
import { listLegalLinks } from "@valentinkolb/cloud";
import { getLocale } from "@valentinkolb/cloud/server";
import { coreSettings } from "@valentinkolb/cloud/services";
import {
  normalizeRedirectTo,
  readLoginMethodFromCookieHeader,
  readThemeFromCookieHeader,
  resolveLoginFallbackMethod,
} from "@valentinkolb/cloud/shared";
import { ssr } from "../../config";
import AdminLoginForm from "./AdminLoginForm.island";
import GuestLoginForm from "./GuestLoginForm.island";
import LoginForm from "./LoginForm.island";
import PasskeyLoginButton from "./PasskeyLoginButton.island";
import { authMessages } from "./messages";

/** Login page. */
export default ssr(async (c) => {
  const locale = getLocale(c);
  const t = authMessages.resolve([locale]).t;
  const [rawAppName, freeIpaEnabledRaw, allowSelfRegistrationRaw, contactEmailRaw, legalLinks] = await Promise.all([
    coreSettings.get<string>("app.name"),
    coreSettings.get<boolean>("freeipa.enable"),
    coreSettings.get<boolean>("user.allow_self_registration"),
    coreSettings.get<string>("app.contact_email"),
    listLegalLinks(locale),
  ]);
  const appName = rawAppName || "My App";
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

  // Priority: magic-link token forces email > hide=guest forces ipa > ?method= > remembered fallback > email.
  const activeMethod = resolveLoginFallbackMethod({
    freeIpaEnabled,
    hasToken: Boolean(token),
    isGuestHidden,
    queryMethod: method,
    persistedMethod: persistedLoginMethod,
  });

  const isEmailLogin = activeMethod === "email";

  const buildMethodUrl = (nextMethod: "email" | "ipa" | "admin") => {
    const methodParams = new URLSearchParams();
    methodParams.set("method", nextMethod);
    if (redirectTo) methodParams.set("redirectTo", redirectTo);
    if (hide && freeIpaEnabled && nextMethod !== "email") methodParams.set("hide", hide);
    if (hasBanner && nextMethod === "ipa") methodParams.set("banner", hasBanner);
    if (ipaUid && nextMethod === "ipa") methodParams.set("ipa-uid", ipaUid);
    return `/auth/login?${methodParams.toString()}`;
  };
  const emailHref = buildMethodUrl("email");
  const ipaHref = buildMethodUrl("ipa");
  const adminHref = buildMethodUrl("admin");
  const supportHref = contactEmail ? `mailto:${contactEmail}` : "/legal/imprint";
  const showPasskey = !isAdminLogin && !token;
  const formTitle = isAdminLogin ? t.adminToken : token ? t.completeEmailSignIn : t.signIn;
  const formSubtitle = isAdminLogin ? t.adminTokenDescription : token ? t.verifyingEmailLink : t.signInDescription;

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

            <main class="flex items-center justify-center p-6 sm:p-10">
              <div class="w-full max-w-md" style={{ "view-transition-name": "login-card" }}>
                <div>
                  <h1 class="sr-only">{t.signIn}</h1>
                  <h2 class="text-3xl font-semibold tracking-tight text-primary">{formTitle}</h2>
                  <p class="mt-1 text-sm text-dimmed">{formSubtitle}</p>
                </div>

                {showPasskey && (
                  <>
                    <div class="mt-8">
                      <PasskeyLoginButton redirectTo={redirectTo} />
                    </div>
                    <div class="my-6 flex items-center gap-3 text-xs text-zinc-400">
                      <span class="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                      <span>{t.fallbackDivider}</span>
                      <span class="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                    </div>
                  </>
                )}

                {!isAdminLogin && freeIpaEnabled && !isGuestHidden && !token && (
                  <div
                    role="radiogroup"
                    aria-label={t.fallbackMethod}
                    class="mb-5 inline-flex w-full items-stretch rounded-xl border border-zinc-300/50 bg-zinc-200/60 p-0.5 [box-shadow:var(--ui-control-recess)] dark:border-zinc-700/50 dark:bg-zinc-900/50"
                    style={{ "view-transition-name": "login-switch" }}
                  >
                    <a
                      href={emailHref}
                      role="radio"
                      aria-checked={isEmailLogin}
                      class={`relative z-0 flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs font-medium leading-4 transition-[background-color,color,box-shadow] ${
                        isEmailLogin
                          ? "z-10 rounded-[0.95rem] bg-white text-zinc-900 [box-shadow:0_1px_3px_-1px_rgb(0_0_0/0.2)] dark:bg-zinc-800/95 dark:text-zinc-100"
                          : "text-zinc-700 hover:bg-zinc-50/65 hover:text-zinc-900 dark:text-zinc-500 dark:hover:bg-zinc-800/35 dark:hover:text-zinc-300"
                      }`}
                    >
                      <i class="ti ti-mail" />
                      Email
                    </a>
                    <a
                      href={ipaHref}
                      role="radio"
                      aria-checked={!isEmailLogin}
                      class={`relative z-0 flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs font-medium leading-4 transition-[background-color,color,box-shadow] ${
                        !isEmailLogin
                          ? "z-10 rounded-[0.95rem] bg-white text-zinc-900 [box-shadow:0_1px_3px_-1px_rgb(0_0_0/0.2)] dark:bg-zinc-800/95 dark:text-zinc-100"
                          : "text-zinc-700 hover:bg-zinc-50/65 hover:text-zinc-900 dark:text-zinc-500 dark:hover:bg-zinc-800/35 dark:hover:text-zinc-300"
                      }`}
                    >
                      <i class="ti ti-building-fortress" />
                      FreeIPA
                    </a>
                  </div>
                )}

                <div class="flex flex-col gap-4">
                  {isAdminLogin ? (
                    <AdminLoginForm redirectTo={redirectTo} />
                  ) : isEmailLogin ? (
                    <GuestLoginForm redirectTo={redirectTo} token={token} allowSelfRegistration={allowSelfRegistration} />
                  ) : (
                    <LoginForm redirectTo={redirectTo} showBanner={hasBanner === "true"} defaultUsername={ipaUid} appName={appName} />
                  )}
                </div>

                {!isAdminLogin && !token && (
                  <div class="mt-4 flex items-center justify-between gap-3 text-xs text-dimmed">
                    <ButtonLink href={supportHref} variant="secondary" size="sm">
                      <i class="ti ti-lifebuoy" />
                      {t.contactSupport}
                    </ButtonLink>
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
